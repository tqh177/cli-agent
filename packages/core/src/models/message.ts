/**
 * 会话与消息数据模型（Agent 核心层）。
 *
 * 支持 tool-calling：消息可包含 tool_calls 和 tool_call_id，
 * role 新增 "tool" 类型。
 */

/** 消息参与者的角色类型。 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** LLM 返回的工具调用。 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON 字符串
  };
}

/** 单条聊天消息。 */
export interface ChatMessage {
  role: MessageRole;
  content: string;
  /** assistant 消息可能携带的工具调用。 */
  tool_calls?: ToolCall[];
  /** tool 消息关联的工具调用 id。 */
  tool_call_id?: string;
}

/**
 * 一个会话是按顺序排列的消息集合，带有唯一的 id 与创建时间。
 */
export interface Conversation {
  id: string;
  createdAt: string;
  messages: ChatMessage[];
}

export function generateConversationId(): string {
  // const timestamp = Date.now().toString(36);
  // const random = Math.random().toString(36).slice(2, 8);
  // return `conv_${timestamp}_${random}`;
  return crypto.randomUUID();
}

/**
 * 创建一个会话，可选地附带 system 提示词。
 * @param systemPrompt 可选的 system 提示词，为空时创建空会话。
 */
export function createConversation(systemPrompt?: string): Conversation {
  const conv: Conversation = {
    id: generateConversationId(),
    createdAt: new Date().toISOString(),
    messages: [],
  };
  if (systemPrompt && systemPrompt.trim().length > 0) {
    conv.messages.push({ role: 'system', content: systemPrompt.trim() });
  }
  return conv;
}

export function appendMessage(conversation: Conversation, message: ChatMessage): Conversation {
  return {
    id: conversation.id,
    createdAt: conversation.createdAt,
    messages: [...conversation.messages, message],
  };
}

export function getHistory(conversation: Conversation): ChatMessage[] {
  return conversation.messages;
}
