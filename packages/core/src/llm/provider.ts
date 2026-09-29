/**
 * LLM Provider 抽象层。
 *
 * 通过定义统一的 LLMProvider 接口，将 Agent 核心对话逻辑与具体 LLM 供应商
 * （OpenAI、Claude、本地模型等）解耦。切换供应商只需注入不同实现，无需
 * 改动核心逻辑（依赖倒置）。
 */

import { ChatMessage } from '../models/message.js';
import { ToolDef } from '../tools/tool-registry.js';

/** generateWithTools 的返回类型。 */
export interface GenerateResult {
  content: string;
  toolCalls: import('../models/message.js').ToolCall[];
}

/** 工具配置选项。 */
export interface ToolConfig {
  /** 启用的工具列表，未指定则全部启用 */
  enabled?: string[];
  /** 禁用的工具列表，优先级高于 enabled */
  disabled?: string[];
}

/**
 * LLM Provider 的统一接口。
 * - generateWithTools：携带工具定义生成回复，返回可能包含 tool_calls 的完整响应；
 * - streamWithTools：流式携带工具定义生成回复。
 *
 * model 属性表示当前生效的模型名，可被外部读写，从而实现运行时切换模型。
 */
export interface LLMProvider {
  /** 供应商的唯一名称，例如 "openai"。 */
  readonly name: string;
  /** 当前生效的模型名称，例如 "gpt-4o-mini"。 */
  model: string;
  /** 携带工具定义生成回复，可能返回 tool_calls。 */
  generateWithTools(messages: ChatMessage[], tools: ToolDef[], sessionId: string): Promise<GenerateResult>;
  /** 流式携带工具定义生成回复。 */
  streamWithTools(messages: ChatMessage[], tools: ToolDef[], sessionId: string): AsyncIterableIterator<{ type: 'content'; content: string } | { type: 'tool_calls'; toolCalls: import('../models/message.js').ToolCall[] }>;
}
