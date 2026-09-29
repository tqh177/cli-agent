import crypto from 'crypto';
/**
 * OpenAI 兼容的 LLM Provider 实现。
 *
 * 使用官方 openai npm 模块发起 LLM 调用，支持 function calling（tool calls）。
 * 通过 OpenAI SDK 的 defaultHeaders 和单次请求 headers 注入自定义请求头。
 */
import OpenAI, { ClientOptions } from 'openai';
import { ChatMessage, ToolCall } from '../models/message.js';
import { LLMProvider, GenerateResult } from './provider.js';
import { ToolDef } from '../tools/tool-registry.js';
import { LLMError } from '../errors.js';

export interface OpenAIProviderOptions {
  /** 提供商 ID（用于标识 provider，如 deepseek / qwen / yunxiao）。 */
  name: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

function toOpenAIMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    const msg = { role: m.role, content: m.content, tool_calls: undefined } as {role: string; content: string; tool_calls?: ToolCall[]; tool_call_id?: string};
    if (m.tool_calls && m.tool_calls.length > 0) {
      msg.tool_calls = m.tool_calls;
    }
    if (m.tool_call_id) {
      msg.tool_call_id = m.tool_call_id;
    }
    return msg as OpenAI.Chat.Completions.ChatCompletionMessageParam;
  });
}

function toLLMError(context: string, error: unknown): LLMError {
  const detail = error instanceof Error ? error.message : String(error);
  return new LLMError(`${context}：${detail}`);
}

/** 构建单次请求的动态请求头。 */
function buildRequestHeaders(sessionId: string): Record<string, string> {
  return {
    'X-Request-Id': crypto.randomUUID().replaceAll('-', ''),
    'X-Session-Id': sessionId,
    'X-Task-Id': crypto.randomUUID().replaceAll('-', '') + '########0',
    'X-Turn-Index': '0',
  };
}

export class OpenAIProvider implements LLMProvider {
  readonly name: string;
  model: string;
  private readonly client: OpenAI;

  constructor(options: OpenAIProviderOptions) {
    this.name = options.name;
    this.model = options.model;
    const baseURL = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');

    const clientOptions: ClientOptions = {
      apiKey: options.apiKey,
      baseURL,
      defaultHeaders: {
        'X-Version': '0.3.5',
      },
    };

    this.client = new OpenAI(clientOptions);
  }

  /** 携带工具定义生成回复，可能返回 tool_calls。 */
  async generateWithTools(messages: ChatMessage[], tools: ToolDef[], sessionId: string): Promise<GenerateResult> {
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: toOpenAIMessages(messages),
          stream: false,
          tools: tools.length > 0 ? tools : undefined,
        },
        {
          headers: buildRequestHeaders(sessionId),
        },
      );

      const message = completion.choices[0]?.message;
      return {
        content: message?.content ?? '',
        toolCalls: (message?.tool_calls ?? []) as ToolCall[],
      };
    } catch (error) {
      throw toLLMError('OpenAI 请求失败', error);
    }
  }

  /** 流式生成回复（携带工具）。 */
  async *streamWithTools(messages: ChatMessage[], tools: ToolDef[], sessionId: string): AsyncIterableIterator<{ type: 'content'; content: string } | { type: 'tool_calls'; toolCalls: ToolCall[] }> {
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: toOpenAIMessages(messages),
          stream: true,
          tools: tools.length > 0 ? tools : undefined,
        },
        {
          headers: buildRequestHeaders(sessionId),
        },
      );
    } catch (error) {
      throw toLLMError('OpenAI 流式请求失败', error);
    }

    // 收集流式 tool_calls（跨多个 delta 拼接）
    const toolCallsAcc = new Map<number, { id: string; name: string; arguments: string }>();
    let streamedContent = '';

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          streamedContent += delta.content;
          yield { type: 'content', content: delta.content };
        }

        // 拼接 tool_calls delta
        if (delta.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index;
            let acc = toolCallsAcc.get(idx);
            if (!acc) {
              acc = { id: tcDelta.id ?? '', name: '', arguments: '' };
              toolCallsAcc.set(idx, acc);
            }
            if (tcDelta.id) acc.id = tcDelta.id;
            if (tcDelta.function?.name) acc.name += tcDelta.function.name;
            if (tcDelta.function?.arguments) acc.arguments += tcDelta.function.arguments;
          }
        }
      }

      // 流结束后产出收集到的 tool_calls
      if (toolCallsAcc.size > 0) {
        const toolCalls: ToolCall[] = [];
        for (const [, tc] of toolCallsAcc) {
          toolCalls.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } });
        }
        yield { type: 'tool_calls', toolCalls };
      }
    } catch (error) {
      throw toLLMError('OpenAI 流式读取失败', error);
    }
  }
}
