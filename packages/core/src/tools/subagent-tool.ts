/**
 * 子 Agent 工具 —— 将「子 Agent」包装为一个普通 Tool，供主 Agent 通过
 * function-calling 调用。
 *
 * 核心思路（方案 A）：
 * - 子 Agent 每次被调用时使用**独立的会话上下文**（createConversation + 专属
 *   system prompt），与主 Agent 上下文完全隔离；
 * - 子 Agent 复用父 Agent 的 LLM Provider / 模型（可通过 model 指定不同模型），
 *   但工具集通过 runTask 的 allowedTools 收窄，默认只读工具
 *   （read_file / grep / glob），避免子 Agent 滥用写文件、Shell 等危险操作；
 * - 子 Agent 的执行通过父 Agent 的 runTask 完成，不修改父会话状态；
 * - 返回给主 Agent 的只是子任务结论（reply），中间过程不外泄（不回填主会话）。
 */

import { AgentSDK, DefaultAgent } from '../agent.js';
import { createConversation } from '../models/message.js';
import { Tool, ToolDef } from './tool-registry.js';

/** 子 Agent 执行时返回给主 Agent 的结果封装（JSON 序列化后作为 tool result）。 */
export interface SubAgentResult {
  /** 子 Agent 是否成功完成（未抛异常）。 */
  ok: boolean;
  /** 子 Agent 最终回复（结论）。 */
  reply: string;
  /** 失败时抛出的错误信息。 */
  error?: string;
  /** 消耗的大致时间（秒）。 */
  seconds?: number;
}

/** 创建子 Agent 工具的参数。 */
export interface SubAgentToolOptions {
  /** 工具名称（唯一，主 Agent 通过它调用）。 */
  name: string;
  /** 工具描述（给 LLM 看的用途说明，应说明何时调用、期望输出）。 */
  description: string;
  /** 子 Agent 专属 system prompt（角色、目标、输出格式、安全约束）。 */
  systemPrompt: string;
  /** 执行子任务的 Agent（复用其 provider / runTask / 存储）。 */
  agent: AgentSDK;
  /** 可选，指定子 Agent 使用的模型（provider 为 ProviderManager 时生效）。 */
  model?: string;
  /** 可选，子 Agent 最大工具轮数（默认 20，防止失控）。 */
  maxRounds?: number;
  /** 可选，子 Agent 可用工具白名单；为空时默认只读工具集。 */
  allowedTools?: string[];
  /** 可选，返回给主 Agent 的结论最大字符数（默认 8000，防止上下文爆炸）。 */
  maxResultLength?: number;
}

/**
 * 声明式子 Agent 配置（来自 .agent/subagent/*.md 文件的 YAML frontmatter）。
 * 每个 .md 文件的 frontmatter 提供元数据（name/description/model/tools 等），
 * 文件正文作为 systemPrompt。启动时由 CLI 装配：为每个条目创建
 * createSubAgentTool 工具并注册为 `run_subagent_<name>`。
 */
export interface SubAgentConfig {
  /** 工具唯一名（LLM 调用名），注册为 run_subagent_<name>。 */
  name: string;
  /** 面向 LLM 的用途描述（何时调用、期望输出）。 */
  description?: string;
  /** 子 Agent 专属 system prompt（角色、目标、输出格式、安全约束）。 */
  systemPrompt?: string;
  /** 指定模型（ProviderManager 解析；支持 label / idLabel / 模型 ID）。 */
  model?: string;
  /** 工具白名单（父注册表内工具名）；默认只读工具集。 */
  tools?: string[];
  /** 最大工具轮数（默认 20）。 */
  maxRounds?: number;
  /** 返回给主 Agent 的结论最大字符数（默认 8000）。 */
  maxResultLength?: number;
}

/**
 * 生成子 Agent 工具的 JSON Schema 定义（供 LLM function calling 使用）。
 */
export function subAgentToolDefinition(name: string, description: string): ToolDef {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: '交给子 Agent 的具体任务描述，应包含目标、范围与期望输出格式',
          },
        },
        required: ['task'],
      },
    },
  };
}

/**
 * 创建一个将子 Agent 包装为 Tool 的工厂函数。
 *
 * 用法：
 * ```ts
 * registry.register(createSubAgentTool({
 *   name: 'code_reviewer',
 *   description: '对指定代码做 Code Review，返回问题清单与修改建议',
 *   systemPrompt: '你是资深代码审查员。只读代码，不修改。输出：## 问题清单 / ## 修改建议',
 *   agent: mainAgent,
 * }));
 * ```
 */
export function createSubAgentTool(options: SubAgentToolOptions): Tool {
  const {
    name,
    description,
    systemPrompt,
    agent,
    model,
    maxRounds = 20,
    allowedTools,
    maxResultLength = 8000,
  } = options;

  return {
    name,
    definition: subAgentToolDefinition(name, description),
    async execute(args) {
      const task = typeof args.task === 'string' ? args.task : '';
      const startedAt = Date.now();
      try {
        // 每次调用都是独立上下文；runTask 不会修改 parent 的 this.current。
        const conv = createConversation();
        const result = await agent.reply(conv, task, model, {
          systemPrompt,
          maxRounds,
          // 默认只读工具；未指定时也强制限制在该白名单（防止子 Agent 越权）。
          allowedTools: allowedTools,
        });
        const reply =
          result.reply.length > maxResultLength
            ? `${result.reply.slice(0, maxResultLength)}\n\n…（结果已截断，超过 ${maxResultLength} 字符）`
            : result.reply;
        const out: SubAgentResult = {
          ok: true,
          reply,
          seconds: Math.round((Date.now() - startedAt) / 1000),
        };
        return JSON.stringify(out);
      } catch (error) {
        const out: SubAgentResult = {
          ok: false,
          reply: '',
          error: error instanceof Error ? error.message : String(error),
          seconds: Math.round((Date.now() - startedAt) / 1000),
        };
        return JSON.stringify(out);
      }
    },
  };
}
