import { useState, useEffect, useCallback, useRef } from 'react';
import { App } from 'antd';
import Sidebar from './components/Sidebar';
import ChatArea, { ChatAreaHandle } from './components/ChatArea';
import { ConversationItem, ChatMessage, fetchConversations, fetchConversation, createConversation, deleteConversation, deleteMessages, sendMessageStream, fetchModels } from './api';

/**
 * 将服务端会话消息归一化为前端展示格式：
 * - assistant 消息的 `tool_calls` 原始字段映射为前端结构化的 `toolCalls` 卡片；
 * - 紧随的 `tool` 结果消息按 `tool_call_id` 合并进对应卡片（result），并从列表移除；
 * - 同一轮工具调用链产生的多条连续 assistant 消息（中间仅隔 tool 消息）合并为一条，
 *   使"工具调用卡片 + 最终文本回复"展示在同一个气泡内，与实时流式效果一致。
 */
function normalizeMessages(msgs: ChatMessage[]): ChatMessage[] {
  const normalized: ChatMessage[] = [];

  for (const m of msgs) {
    // tool 结果消息：合并进前一条 assistant 消息中对应的工具卡片
    if (m.role === 'tool') {
      const prev = normalized[normalized.length - 1];
      if (prev?.role === 'assistant' && prev.toolCalls && prev.toolCalls.length > 0) {
        // ① 按 tool_call_id（== 原始 tool_calls[].id）精确匹配
        let idx = -1;
        if (m.tool_call_id) {
          idx = (prev.tool_calls ?? []).findIndex(tc => tc.id === m.tool_call_id);
        }
        // ② 匹配不到（旧数据无 id）则按顺序补到第一张尚无结果的卡片
        if (idx < 0) {
          idx = prev.toolCalls.findIndex(tc => !tc.result);
        }
        if (idx >= 0) {
          const next = prev.toolCalls.map((tc, i) =>
            i === idx
              ? {
                  ...tc,
                  result: m.content,
                  status: m.content.toLowerCase().startsWith('error')
                    ? ('error' as const)
                    : ('success' as const),
                }
              : tc,
          );
          prev.toolCalls = next;
          continue; // 已合并，不再作为独立消息
        }
      }
      // 无法匹配时降级为独立消息（保持原样）
      normalized.push(m);
      continue;
    }

    // assistant 消息：把 tool_calls 映射为 toolCalls 卡片
    if (m.role === 'assistant') {
      // 历史会话中带 tool_calls 原始字段的 assistant 消息，映射出前端卡片结构
      const msg: ChatMessage = (() => {
        if (m.toolCalls || !m.tool_calls || m.tool_calls.length === 0) return m;
        return {
          ...m,
          toolCalls: m.tool_calls.map(tc => ({
            name: tc.function.name,
            arguments: tc.function.arguments,
            status: 'success' as const,
          })),
        };
      })();

      const prev = normalized[normalized.length - 1];
      if (prev?.role === 'assistant') {
        // 合并同一轮内的多条 assistant 消息：content 拼接、toolCalls 累积
        const content = [prev.content, msg.content].filter(Boolean).join('\n\n');
        const toolCalls = [...(prev.toolCalls ?? []), ...(msg.toolCalls ?? [])];
        const tool_calls = [...(prev.tool_calls ?? []), ...(msg.tool_calls ?? [])];
        normalized[normalized.length - 1] = { ...prev, content, toolCalls, tool_calls };
      } else {
        normalized.push(msg);
      }
      continue;
    }

    normalized.push(m);
  }

  return normalized;
}

export default function AppRoot() {
  const { message } = App.useApp();
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [models, setModels] = useState<string[]>([]);
  const [currentModel, setCurrentModel] = useState('');
  const chatAreaRef = useRef<ChatAreaHandle>(null);
  // 当前流式请求的 AbortController：终止按钮通过它中止生成
  const stopControllerRef = useRef<AbortController | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const list = await fetchConversations();
      setConversations(list);
    } catch { /* ignore */ }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const info = await fetchModels();
      setModels(info.models);
      setCurrentModel(prev => prev || info.models[0] || '');
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadConversations();
    loadModels();
  }, [loadConversations, loadModels]);

  const handleSelectConversation = async (id: string) => {
    setCurrentId(id);
    try {
      const conv = await fetchConversation(id);
      setMessages(normalizeMessages(conv.messages));
      // 延迟滚动，等待 Virtuoso 渲染完成
      setTimeout(() => chatAreaRef.current?.scrollToBottom(), 50);
    } catch {
      setMessages([]);
    }
  };

  const handleNewChat = () => {
    setCurrentId(null);
    setMessages([]);
  };

  const handleDeleteConversation = async (id: string) => {
    try {
      await deleteConversation(id);
      if (currentId === id) {
        setCurrentId(null);
        setMessages([]);
      }
      await loadConversations();
    } catch (err) {
      message.error('删除失败: ' + (err as Error).message);
    }
  };

  const handleSend = async (content: string) => {
    if (!content.trim() || streaming) return;

    let convId = currentId;
    if (!convId) {
      try {
        const conv = await createConversation();
        convId = conv.id;
        setCurrentId(convId);
        await loadConversations();
      } catch (err) {
        message.error('创建会话失败: ' + (err as Error).message);
        return;
      }
    }

    const userMsg: ChatMessage = { role: 'user', content };
    setMessages(prev => [...prev, userMsg]);
    // 发送新消息后滚动到底部
    setTimeout(() => chatAreaRef.current?.scrollToBottom(), 50);
    setStreaming(true);

    let reply = '';
    // 流式过程中结构化记录工具调用，最终合并到 assistant 消息的 toolCalls 字段
    let toolCalls: import('./api').ToolCallData[] = [];

    // 合并最新 toolCalls 到最后一条 assistant 消息
    const patchToolCalls = () => {
      setMessages(prev => {
        if (toolCalls.length === 0) return prev;
        const copy = [...prev];
        const idx = copy.length - 1;
        if (copy[idx]?.role === 'assistant') {
          copy[idx] = { ...copy[idx], toolCalls: [...toolCalls] };
        } else {
          copy.push({ role: 'assistant', content: '', toolCalls: [...toolCalls] });
        }
        return copy;
      });
    };

    let controller: AbortController;

    // 流式结束（完成/终止/出错共用）处理
    const finishStreaming = () => {
      // 仅复位当前流：旧流迟到的完成/停止回调不允许误清新流的状态
      if (stopControllerRef.current !== controller) return;
      setStreaming(false);
      stopControllerRef.current = null;
      loadConversations();
    };

    controller = sendMessageStream(
      convId,
      content,
      currentModel,
      (token) => {
        reply += token;
        const calls = toolCalls.length ? [...toolCalls] : undefined;
        setMessages(prev => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant') {
            copy[copy.length - 1] = { ...last, content: reply, toolCalls: calls ?? last.toolCalls };
          } else {
            copy.push({ role: 'assistant', content: reply, toolCalls: calls });
          }
          return copy;
        });
      },
      (name, args) => {
        toolCalls = [...toolCalls, { name, arguments: args, status: 'running' }];
        patchToolCalls();
      },
      (_name, result) => {
        // 更新对应（最近一个 running 状态）工具调用的结果
        toolCalls = toolCalls.map((tc, i) =>
          i === toolCalls.length - 1 && tc.status === 'running'
            ? { ...tc, result, status: result.toLowerCase().startsWith('error') ? 'error' : 'success' }
            : tc,
        );
        patchToolCalls();
      },
      () => {
        finishStreaming();
      },
      (msg) => {
        setMessages(prev => [...prev, { role: 'assistant', content: `[错误] ${msg}` }]);
        finishStreaming();
      },
      () => {
        // 用户手动终止：保留已生成的部分回复，不追加错误消息
        finishStreaming();
      },
    );
    stopControllerRef.current = controller;
  };

  const handleModelChange = (model: string) => {
    setCurrentModel(model);
  };

  /** 用户点击"停止生成"：中止当前流式请求（服务端 close → AbortSignal → 生成循环停止）。 */
  const handleStop = () => {
    const controller = stopControllerRef.current;
    if (!controller) return;
    controller.abort();
    // 立即复位前端流式状态：客户端 abort 后 fetch 抛 AbortError，
    // sendMessageStream 的 catch 分支会回调 onStopped → finishStreaming 复位（双保险）
    stopControllerRef.current = null;
    setStreaming(false);
    loadConversations();
  };

  const handleDeleteMessages = async (displayIndices: number[]) => {
    if (!currentId || displayIndices.length === 0) return;

    // 将 display 索引映射回原始 messages 索引（display 过滤了 system 消息）
    const originalIndices: number[] = [];
    let msgIdx = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'system') continue;
      if (displayIndices.includes(msgIdx)) {
        originalIndices.push(i);
      }
      msgIdx++;
    }

    try {
      await deleteMessages(currentId, originalIndices);
      // 从本地状态中移除对应消息
      setMessages(prev => {
        const sorted = [...originalIndices].sort((a, b) => b - a);
        const copy = [...prev];
        for (const idx of sorted) {
          copy.splice(idx, 1);
        }
        return copy;
      });
      loadConversations();
    } catch (err) {
      message.error('删除消息失败: ' + (err as Error).message);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-ds-bg">
      {/* Header - DeepSeek 风格 */}
      <header className="h-12 bg-white/90 backdrop-blur-sm border-b border-ds-border-light flex items-center px-4 shrink-0 z-10">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSidebarOpen(v => !v)}
            className="text-ds-text-secondary hover:text-ds-text hover:bg-ds-input rounded-lg p-1.5 transition-all"
            title="切换侧边栏"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 5h14M3 10h14M3 15h14"/>
            </svg>
          </button>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-ds-accent flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" className="text-white">
                <circle cx="12" cy="12" r="10" opacity="0.35"/>
                <path d="M12 8v4l3 2"/>
              </svg>
            </div>
            <h1 className="font-semibold text-sm text-ds-text select-none">CLI Agent</h1>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        {sidebarOpen && (
          <Sidebar
            conversations={conversations}
            currentId={currentId}
            onSelect={handleSelectConversation}
            onDelete={handleDeleteConversation}
            onNewChat={handleNewChat}
          />
        )}

        {/* Chat */}
        <ChatArea
          ref={chatAreaRef}
          messages={messages}
          streaming={streaming}
          onSend={handleSend}
          onStop={handleStop}
          models={models}
          currentModel={currentModel}
          onModelChange={handleModelChange}
          onDeleteMessages={handleDeleteMessages}
        />
      </div>
    </div>
  );
}
