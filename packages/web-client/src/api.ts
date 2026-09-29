export interface ConversationItem {
  id: string;
  createdAt: string;
  messageCount: number;
  preview: string;
}

export interface ConversationDetail {
  id: string;
  createdAt: string;
  messages: ChatMessage[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /**
   * 流式过程中结构化记录的工具调用（名称/参数/结果），
   * 用于在界面上以卡片形式直观展示，而非混入 content 文本。
   */
  toolCalls?: ToolCallData[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolCallData {
  name: string;
  arguments: string;
  result?: string;
  status: 'running' | 'success' | 'error';
}

export interface ModelInfo {
  models: string[];
}

const BASE = '';

export async function fetchConversations(): Promise<ConversationItem[]> {
  const res = await fetch(`${BASE}/api/conversations`);
  return res.json();
}

export async function fetchConversation(id: string): Promise<ConversationDetail> {
  const res = await fetch(`${BASE}/api/conversations/${id}`);
  if (!res.ok) throw new Error('Conversation not found');
  return res.json();
}

export async function createConversation(systemPrompt?: string): Promise<ConversationDetail> {
  const res = await fetch(`${BASE}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemPrompt }),
  });
  return res.json();
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/conversations/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(data.error || 'Delete failed');
  }
}

export async function deleteAllConversations(): Promise<number> {
  const res = await fetch(`${BASE}/api/conversations`, { method: 'DELETE' });
  const data = await res.json();
  return data.deleted ?? 0;
}

export async function deleteMessages(convId: string, indices: number[]): Promise<void> {
  const res = await fetch(`${BASE}/api/conversations/${convId}/messages/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ indices }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(data.error || 'Delete messages failed');
  }
}

export function sendMessageStream(
  convId: string,
  content: string,
  model: string,
  onToken: (token: string) => void,
  onToolCall: (name: string, args: string) => void,
  onToolResult: (name: string, result: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${BASE}/api/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, model }),
        signal: controller.signal,
      });

      // 非 2xx 响应（如 404/500）不是 SSE 流，直接报错
      if (!res.ok) {
        let msg = `请求失败（${res.status}）`;
        try {
          const data = await res.json();
          if (data && typeof data.error === 'string') msg = data.error;
        } catch { /* 忽略解析失败 */ }
        onError(msg);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        onError('无法读取响应流');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let ended = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            switch (data.type) {
              case 'token':
                onToken(data.token);
                break;
              case 'tool_call':
                onToolCall(data.name, data.arguments);
                break;
              case 'tool_result':
                onToolResult(data.name, data.result);
                break;
              case 'done':
                ended = true;
                onDone();
                break;
              case 'error':
                ended = true;
                onError(data.message);
                break;
            }
          } catch { /* skip parse errors */ }
        }
      }

      // 流结束但未收到 done，视为异常终止
      if (!ended) {
        onError('连接中断，未收到完整回复');
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        onError((err as Error).message);
      }
    }
  })();

  return controller;
}

export async function fetchModels(): Promise<ModelInfo> {
  const res = await fetch(`${BASE}/api/models`);
  return res.json();
}
