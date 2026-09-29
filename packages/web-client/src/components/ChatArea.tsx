import { useState, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { ChatMessage } from '../api';
import MessageBubble from './MessageBubble';

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  onSend: (content: string) => void;
  models: string[];
  currentModel: string;
  onModelChange: (model: string) => void;
  onDeleteMessages?: (displayIndices: number[]) => void;
}

export interface ChatAreaHandle {
  scrollToBottom: () => void;
}

const ChatArea = forwardRef<ChatAreaHandle, Props>(function ChatArea(
  { messages, streaming, onSend, models, currentModel, onModelChange, onDeleteMessages },
  ref,
) {
  const [input, setInput] = useState('');
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    scrollToBottom: () => {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
    },
  }), []);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;
    onSend(trimmed);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const displayMessages = useMemo(
    () => messages.filter(m => m.role !== 'system'),
    [messages],
  );

  const itemContent = useCallback(
    (index: number, msg: ChatMessage) => {
      // 判断是否为新一轮对话的开始：上一条不是 user（即前一内容为 AI/工具）或这是第一条
      const prev = displayMessages[index - 1];
      const turnStart = !prev || prev.role !== 'user';

      // 计算该用户消息的"成对消息"索引范围（从当前用户消息到下一个用户消息之前）
      let onDelete: (() => void) | undefined;
      if (msg.role === 'user' && onDeleteMessages) {
        // 找到下一个 user 消息的索引（不含当前）
        let endIdx = displayMessages.length;
        for (let i = index + 1; i < displayMessages.length; i++) {
          if (displayMessages[i].role === 'user') {
            endIdx = i;
            break;
          }
        }
        const pairIndices: number[] = [];
        for (let i = index; i < endIdx; i++) {
          pairIndices.push(i);
        }
        onDelete = () => onDeleteMessages(pairIndices);
      }

      return <MessageBubble message={msg} turnStart={turnStart} onDelete={onDelete} />;
    },
    [displayMessages, onDeleteMessages],
  );

  const Footer = useCallback(() => {
    if (!streaming) return null;
    return (
      <div className="flex justify-start px-4 py-2">
        <div className="bg-ds-bubble border border-ds-border rounded-2xl rounded-bl-md px-4 py-3 shadow-bubble">
          <div className="flex items-center gap-1">
            <span className="typing-dot inline-block w-2 h-2 bg-ds-accent rounded-full" />
            <span className="typing-dot inline-block w-2 h-2 bg-ds-accent rounded-full" />
            <span className="typing-dot inline-block w-2 h-2 bg-ds-accent rounded-full" />
          </div>
        </div>
      </div>
    );
  }, [streaming]);

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-ds-bg">
      {/* 消息区域 */}
      <div className="flex-1">
        {displayMessages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center px-4">
              {/* DeepSeek 风格 Logo */}
              <div className="mx-auto mb-5 w-16 h-16 rounded-2xl bg-ds-accent-light flex items-center justify-center">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ds-accent">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-ds-text mb-1">有什么可以帮忙的？</h2>
              <p className="text-sm text-ds-text-secondary">开始一段新对话，我会尽力帮助你</p>
            </div>
          </div>
        ) : (
          <div className='max-w-[75%] h-full mx-auto px-6 py-6'>
            <Virtuoso
              ref={virtuosoRef}
              data={displayMessages}
              followOutput="smooth"
              computeItemKey={(_index, msg) => `${msg.role}-${_index}`}
              itemContent={itemContent}
              components={{ Footer }}
              className="chat-scroll"
            />
          </div>
        )}
      </div>

      {/* 输入区域 - DeepSeek 风格 */}
      <div className="border-t border-ds-border-light bg-white/80 backdrop-blur-sm">
        <div className="max-w-[75%] mx-auto px-4 py-3">
          <div className="flex items-end gap-2 bg-ds-input border border-ds-border rounded-2xl px-3 py-2 shadow-soft focus-within:border-ds-accent/40 focus-within:ring-2 focus-within:ring-ds-accent/15 transition-all">
            {/* 模型选择器 */}
            <div className="relative shrink-0">
              <select
                value={currentModel}
                onChange={e => onModelChange(e.target.value)}
                title={currentModel || undefined}
                className="text-2xs border border-ds-border/60 rounded-lg pl-2 pr-5 py-1 bg-white/80 text-ds-text-secondary appearance-none cursor-pointer hover:border-ds-accent/40 transition-colors focus:outline-none w-[120px] truncate"
              >
                {models.map(m => <option key={m} value={m} title={m}>{m}</option>)}
              </select>
              <svg className="absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none text-ds-text-tertiary" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 9l6 6 6-6"/>
              </svg>
            </div>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              disabled={streaming}
              className="flex-1 bg-transparent border-none text-sm resize-none outline-none placeholder:text-ds-text-tertiary disabled:opacity-50 py-0.5"
              style={{ maxHeight: '120px' }}
            />
            <button
              onClick={handleSend}
              disabled={streaming || !input.trim()}
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-ds-accent text-white hover:bg-ds-accent-hover transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-ds-accent"
              title="发送"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
              </svg>
            </button>
          </div>
          <p className="text-2xs text-ds-text-tertiary text-center mt-2 select-none">
            CLI Agent · AI 生成内容仅供参考
          </p>
        </div>
      </div>
    </div>
  );
});

export default ChatArea;
