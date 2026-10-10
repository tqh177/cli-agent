/**
 * Agent Service（AgentSDK）。
 *
 * 支持 tool-calling：当 LLM 返回 tool_calls 时，自动执行工具并将结果
 * 回传给 LLM 继续生成，直到 LLM 返回纯文本回复。
 *
 * 提供 runTask 方法：在独立会话上执行一次完整的工具调用循环，
 * 不修改 Agent 的当前会话状态（this.current），供子 Agent 等场景复用。
 */

import { Conversation, createConversation, appendMessage, getHistory, ChatMessage } from './models/message.js';
import { LLMProvider, GenerateResult } from './llm/provider.js';
import { ProviderManager } from './llm/provider-manager.js';
import { SessionStore } from './storage/session-store.js';
import { ToolRegistry, ToolDef } from './tools/tool-registry.js';
import { isValidInput } from './input.js';
import { AgentError } from './errors.js';

export interface ModelSwitchable {
  listModels(): string[];
  listLocalModels(): string[];
  selectModel(qualified: string): void;
}

/** 工具调用回调参数。 */
export interface ToolCallbackParams {
  /** 工具调用信息 */
  toolCall: import('./models/message.js').ToolCall;
  /** 工具执行结果 */
  result: string;
  /** 当前轮数 */
  round: number;
  /** LLM 返回的对话内容（工具调用时可能为空） */
  content: string;
}

/** 工具调用回调函数。 */
export type ToolCallback = (params: ToolCallbackParams) => void;

const INVALID_INPUT_MESSAGE = '输入不能为空，请重新输入。';
const MAX_TOOL_ROUNDS = 100;

/** runTask 的可选参数。 */
export interface RunTaskOptions {
  /** 覆盖最大工具轮数（默认 MAX_TOOL_ROUNDS）。 */
  maxRounds?: number;
  /** 覆盖会话起始 system 消息（追加在现有消息之前）。 */
  systemPrompt?: string;
  /** 工具白名单；为空时使用 Agent 注册的所有工具。 */
  allowedTools?: string[];
}

export interface AgentSDK {
  start(conversation?: Conversation): Conversation;
  reply(conv: Conversation, userInput: string,model?: string, options?: RunTaskOptions): Promise<{ conv: Conversation; reply: string }>;
  streamReply(conv: Conversation, userInput: string, model?: string): AsyncIterable<string>;
  saveSession(conv?: Conversation): Promise<void>;
  loadSession(id: string): Promise<Conversation>;
  listSessions(): Promise<string[]>;
  getCurrentConversation(): Conversation;
  listModels(): string[];
  listLocalModels(): string[];
  setModel(qualified: string): void;
  /** 获取工具注册表。 */
  getToolRegistry(): ToolRegistry;
  /** 删除指定 id 的会话。 */
  deleteSession(id: string): Promise<void>;
  /** 删除所有会话，返回删除数量。 */
  deleteAllSessions(): Promise<number>;
}

export class DefaultAgent implements AgentSDK {
  private readonly provider: LLMProvider;
  private readonly store: SessionStore;
  private readonly toolRegistry: ToolRegistry;
  private toolCallback?: ToolCallback;
  private current: Conversation;

  constructor(provider: LLMProvider, store: SessionStore, toolRegistry?: ToolRegistry, toolCallback?: ToolCallback) {
    this.provider = provider;
    this.store = store;
    this.toolRegistry = toolRegistry ?? new ToolRegistry();
    this.toolCallback = toolCallback;
    this.current = createConversation();
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  /** 获取 ProviderManager（如果 provider 是 ProviderManager 实例）。 */
  getProviderManager(): ProviderManager | null {
    if (this.provider instanceof ProviderManager) {
      return this.provider;
    }
    return null;
  }

  /** 设置工具调用回调。 */
  setToolCallback(cb: ToolCallback): void {
    this.toolCallback = cb;
  }

  /** 获取当前会话。 */
  getConversation(): Conversation {
    return this.current;
  }

  start(conversation?: Conversation): Conversation {
    this.current = conversation ?? createConversation();
    return this.current;
  }

  getCurrentConversation(): Conversation {
    return this.current;
  }

  streamReply(conv: Conversation, userInput: string, model?: string): AsyncIterable<string> {
    if (!isValidInput(userInput)) throw new AgentError(INVALID_INPUT_MESSAGE);

    const withUser = appendMessage(conv, { role: 'user', content: userInput });
    const activeProvider = this.resolveProvider(model);
    const self = this;

    return (async function* (): AsyncGenerator<string> {
      // currentConv 提升到 try 外，catch 中也能访问，用于错误时部分保存会话
      let currentConv = withUser;
      try {
        const tools = self.toolRegistry.getDefinitions();

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          let hasToolCalls = false;
          let content = '';

          for await (const chunk of activeProvider.streamWithTools(getHistory(currentConv), tools, currentConv.id)) {
            if (chunk.type === 'content') {
              content += chunk.content;
              yield chunk.content;
            } else if (chunk.type === 'tool_calls') {
              hasToolCalls = true;

              currentConv = appendMessage(currentConv, {
                role: 'assistant',
                content,
                tool_calls: chunk.toolCalls,
              });

              for (const tc of chunk.toolCalls) {
                let args: Record<string, unknown> = {};
                try {
                  args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
                } catch { /* 解析失败用空参数 */ }
                const toolResult = await self.toolRegistry.execute(tc.function.name, args);

                if (self.toolCallback) {
                  self.toolCallback({
                    toolCall: tc,
                    result: toolResult,
                    round,
                    content,
                  });
                }

                currentConv = appendMessage(currentConv, {
                  role: 'tool',
                  content: toolResult,
                  tool_call_id: tc.id,
                });
              }
              break;
            }
          }

          if (hasToolCalls) {
            continue;
          }

          currentConv = appendMessage(currentConv, { role: 'assistant', content });
          self.current = currentConv;
          return;
        }

        throw new AgentError(`工具调用超过最大轮数（${MAX_TOOL_ROUNDS}），可能陷入循环`);
      } catch (error) {
        // 错误时部分保存会话：已累积的消息（含本轮 user 输入与已完成的轮次）
        // 不因 LLM/工具错误而丢失，便于用户恢复上下文重试
        self.current = currentConv;
        if (error instanceof AgentError) {
          throw error;
        }
        throw new AgentError(error instanceof Error ? error.message : String(error));
      }
    })();
  }

  /**
   * 在独立会话上执行一次完整的工具调用任务（供子 Agent 复用）。
   *
   * - 会自动在会话上追加 system（可选）与 user 消息；
   * - 使用当前 Agent 的 provider 与工具注册表执行（可通过 model 指定模型）；
   * - **不修改当前会话状态**（不改 this.current），结果只通过返回值返回。
   *
   * @param conv 起始会话（可为空会话）
   * @param userInput 任务输入
   * @param model 可选，指定本次使用的模型（provider 为 ProviderManager 时生效）
   * @param options 覆盖最大轮数 / system 提示词
   */
  async reply(
    conv: Conversation,
    userInput: string,
    model?: string,
    options?: RunTaskOptions,
  ): Promise<{ conv: Conversation; reply: string }> {
    if (!isValidInput(userInput)) throw new AgentError(INVALID_INPUT_MESSAGE);

    let currentConv = conv;
    if (options?.systemPrompt && options.systemPrompt.trim().length > 0) {
      currentConv = appendMessage(currentConv, { role: 'system', content: options.systemPrompt.trim() });
    }
    currentConv = appendMessage(currentConv, { role: 'user', content: userInput });

    const activeProvider = this.resolveProvider(model);
    const maxRounds = options?.maxRounds ?? MAX_TOOL_ROUNDS;
    const allowedTools = options?.allowedTools;
    return this.runLoop(currentConv, activeProvider, maxRounds, allowedTools);
  }

  /**
   * Tool-calling 核心循环：反复调用 LLM，直到返回纯文本回复或达到最大轮数。
   * 不修改 this.current，由调用方决定是否落盘当前会话。
   */
  private async runLoop(
    conv: Conversation,
    provider: LLMProvider,
    maxRounds: number,
    allowedTools?: string[],
  ): Promise<{ conv: Conversation; reply: string }> {
    const allowSet = new Set(allowedTools);
    let currentConv = conv;
    let tools = this.toolRegistry.getDefinitions();
    if (allowedTools && allowedTools.length > 0) {
      tools = tools.filter((t) => allowSet.has(t.function.name));
    }

    for (let round = 0; round < maxRounds; round++) {
      const result = await provider.generateWithTools(getHistory(currentConv), tools, currentConv.id);

      if (result.toolCalls.length > 0) {
        currentConv = appendMessage(currentConv, {
          role: 'assistant',
          content: result.content,
          tool_calls: result.toolCalls,
        });

        for (const tc of result.toolCalls) {
          if (!allowSet.has(tc.function.name)) {
            currentConv = appendMessage(currentConv, {
              role: 'tool',
              content: "未知工具:" + tc.function.name,
              tool_call_id: tc.id,
            });
            continue;
          }
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch { /* 解析失败用空参数 */ }
          const toolResult = await this.toolRegistry.execute(tc.function.name, args);

          if (this.toolCallback) {
            this.toolCallback({
              toolCall: tc,
              result: toolResult,
              round,
              content: result.content,
            });
          }

          currentConv = appendMessage(currentConv, {
            role: 'tool',
            content: toolResult,
            tool_call_id: tc.id,
          });
        }
        continue;
      }

      const reply = result.content || '';
      currentConv = appendMessage(currentConv, { role: 'assistant', content: reply });
      return { conv: currentConv, reply };
    }

    throw new AgentError(`工具调用超过最大轮数（${maxRounds}），可能陷入循环`);
  }

  /**
   * 解析本次请求实际应使用的 LLMProvider。
   * provider 为 ProviderManager 时按模型解析对应 provider；非 Manager（单 Provider）场景下若指定了不同模型，则返回临时模型覆盖包装器，不改动共享 provider 状态。
   */
  private resolveProvider(model?: string): LLMProvider {
    const pm = this.getProviderManager();
    if (pm) {
      return pm.getProviderByModel(model);
    }
    return this.provider;
  }

  async saveSession(conv?: Conversation): Promise<void> {
    await this.store.saveSession(conv ?? this.current);
  }

  async loadSession(id: string): Promise<Conversation> {
    const loaded = await this.store.loadSession(id);
    this.current = loaded;
    return loaded;
  }

  async listSessions(): Promise<string[]> {
    return this.store.listSessions();
  }

  async deleteSession(id: string): Promise<void> {
    await this.store.deleteSession(id);
  }

  async deleteAllSessions(): Promise<number> {
    return this.store.deleteAllSessions();
  }

  listModels(): string[] {
    return this.trySwitchable()?.listModels() ?? [this.provider.model];
  }

  listLocalModels(): string[] {
    return this.trySwitchable()?.listLocalModels() ?? [this.provider.model];
  }

  setModel(qualified: string): void {
    const sw = this.trySwitchable();
    if (!sw) {
      this.provider.model = qualified;
      return;
    }
    sw.selectModel(qualified);
  }

  private trySwitchable(): ModelSwitchable | null {
    const p = this.provider;
    if (p && typeof ((p as unknown) as ModelSwitchable).listModels === 'function') {
      return (p as unknown) as ModelSwitchable;
    }
    return null;
  }
}
