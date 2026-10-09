/**
 * CLI 配置加载与合并。
 *
 * 从可选配置文件读取配置，与内置默认值深度合并；缺失字段回退到默认值，
 * 非法配置抛出 ConfigError。
 *
 * 配置格式（提供商为中心，参照 opencode 配置风格）：
 * {
 *   "provider": {
 *     "deepseek": {
 *       "name": "DeepSeek",
 *       "options": { "baseURL": "https://..." },
 *       "models": {
 *         "deepseek-v4-pro": { "name": "deepseek-v4-pro" }
 *       }
 *     }
 *   },
 *   "storage": { "dir": "./data" },
 *   "tools": {
 *     "enabled": ["read_file", "write_file", "run_shell"],
 *     "disabled": []
 *   }
 * }
 *
 * provider map 每个键为提供商 ID；其 apiKey 不写入配置文件，而是由 core 的
 * resolveProviderMap 从环境变量「{ID}_API_KEY」读取（启动时由 loadEnvFile 加载 .env）。
 * tools 配置用于控制内置工具的启用和禁用。
 */

import { readFile } from 'node:fs/promises';
import {
  ConfigError,
  ProviderEntryConfig,
  ResolvedProviderConfig,
  resolveProviderMap,
  ToolConfig,
  SubAgentConfig,
} from '@agent/core';
import { loadSubAgentConfigsFromDir } from './subagent-config.js';

/** 存储相关的默认配置。 */
const DEFAULT_STORAGE = {
  dir: './data',
};

/** 合并后的最终配置结构。 */
export interface AppConfig {
  /** 配置文件中声明的 provider map（提供商 ID → 条目）。 */
  llm: Record<string, ProviderEntryConfig>;
  /** 解析后的扁平 Provider 配置（供 ProviderManager 使用）。 */
  llmResolved: ResolvedProviderConfig[];
  storage: { dir: string };
  tools?: ToolConfig;
  /** 新对话开头的默认 system 提示词（可选）。 */
  systemPrompt?: string;
  /** 声明式子 Agent 配置列表（可选）。 */
  subagents?: SubAgentConfig[];
}

/**
 * 加载并合并配置。
 * @param configPath 可选配置文件路径；未提供时仅使用默认值（必须通过环境变量提供 apiKey）。
 * @param opts 附加选项；systemPromptPath 为 system 提示词文件路径，若文件存在则其内容
 * 作为 systemPrompt（配置文件中的 systemPrompt 字段不再使用）。
 * subagentDir 为子 Agent 配置基目录，函数会在其下查找 .agent/subagent/*.md 文件。
 */
export async function loadConfig(configPath?: string, opts?: { systemPromptPath?: string; subagentDir?: string }): Promise<AppConfig> {
  let fileConfig: Record<string, unknown> = {};
  if (configPath) {
    let raw: string;
    try {
      raw = await readFile(configPath, 'utf8');
    } catch (error) {
      throw new ConfigError(`无法读取配置文件 "${configPath}"：${String(error)}`);
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        throw new ConfigError(`配置文件 "${configPath}" 顶层必须是 JSON 对象`);
      }
      fileConfig = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ConfigError) {
        throw error;
      }
      throw new ConfigError(`配置文件 "${configPath}" 不是合法 JSON`);
    }
  }

  const { config, jsonSubagents } = mergeConfig(fileConfig);

  // 从 system 提示词文件读取内容（可选）。文件不存在时保持无 systemPrompt。
  const systemPromptPath = opts?.systemPromptPath;
  if (systemPromptPath) {
    try {
      const raw = await readFile(systemPromptPath, 'utf8');
      if (raw.trim().length > 0) {
        config.systemPrompt = formatPrompt(raw);
      }
    } catch {
      // 提示词文件不存在或不可读时忽略，回退到无 systemPrompt。
    }
  }

  // 子 Agent 配置：优先从 .agent/subagent/*.md 文件加载。
  const subagentDir = opts?.subagentDir;
  if (subagentDir) {
    const fileSubagents = await loadSubAgentConfigsFromDir(subagentDir);
    if (fileSubagents) {
      config.subagents = fileSubagents;
    } else if (jsonSubagents) {
      // .agent/subagent/ 目录不存在或无 .md 文件，回退到 JSON 中的 subagents（弃用）。
      config.subagents = parseSubAgentConfigs(jsonSubagents);
      console.warn('[配置] agent.config.json 中的 subagents 字段已弃用，请迁移到 .agent/subagent/*.md 文件');
    }
  } else if (jsonSubagents) {
    // 未指定 subagentDir，回退到 JSON 中的 subagents（弃用）。
    config.subagents = parseSubAgentConfigs(jsonSubagents);
    console.warn('[配置] agent.config.json 中的 subagents 字段已弃用，请迁移到 .agent/subagent/*.md 文件');
  }

  return config;
}

/** 将文件配置与默认值合并，生成最终配置。同时返回 JSON 中原始的 subagents 数据（由 loadConfig 决定如何加载）。 */
function mergeConfig(fileConfig: Record<string, unknown>): { config: AppConfig; jsonSubagents: unknown } {
  const providerRaw = fileConfig.provider;
  const storageRaw = (fileConfig.storage as Record<string, unknown> | undefined) ?? {};
  const toolsRaw = fileConfig.tools as Record<string, unknown> | undefined;

  const llm = parseProviderMap(providerRaw);
  const llmResolved = resolveProviderMap(llm, process.env);
  return {
    config: {
      llm,
      llmResolved,
      storage: buildStorage(storageRaw),
      tools: parseToolConfig(toolsRaw),
    },
    jsonSubagents: fileConfig.subagents,
  };
}

function formatPrompt(prompt: string): string {
  const now = new Date();
  const map = {
    '{{date}}': now.toISOString().replace(/T.+Z/, ''),
    '{{week}}': ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][now.getDay()],
  }
  return prompt.trim().replace(/{{\w+}}/g, (p)=>{
    return p in map ? map[p as keyof typeof map] : p;
  }).replace(/\n+/g, '\n');
}

/**
 * 解析 provider 配置：顶层必须为非空对象，返回「提供商 ID → 条目」结构。
 * apiKey 等敏感字段不在此处解析（由 core resolveProviderMap 从环境变量读取）。
 */
function parseProviderMap(raw: unknown): Record<string, ProviderEntryConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('provider 配置必须是对象');
  }
  const map: Record<string, ProviderEntryConfig> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      throw new ConfigError(`提供商 "${id}" 必须是对象`);
    }
    const entry = value as Record<string, unknown>;
    const models = entry.models;
    if (typeof models !== 'object' || models === null || Object.keys(models).length === 0) {
      throw new ConfigError(`提供商 "${id}" 必须至少配置一个模型（models）`);
    }
    map[id] = entry as unknown as ProviderEntryConfig;
  }
  if (Object.keys(map).length === 0) {
    throw new ConfigError('必须至少配置一个提供商（provider）');
  }
  return map;
}

/** 构建存储配置，处理相对路径。 */
function buildStorage(storageRaw: Record<string, unknown>): { dir: string } {
  const dir = typeof storageRaw.dir === 'string' ? storageRaw.dir : DEFAULT_STORAGE.dir;
  return { dir };
}

/** 解析工具配置。 */
function parseToolConfig(raw: Record<string, unknown> | undefined): ToolConfig {
  if (!raw) {
    return {};
  }

  const config: ToolConfig = {};

  if (Array.isArray(raw.enabled)) {
    const enabled: string[] = [];
    for (const item of raw.enabled) {
      if (typeof item === 'string' && item.length > 0) {
        enabled.push(item);
      }
    }
    if (enabled.length > 0) {
      config.enabled = enabled;
    }
  }

  if (Array.isArray(raw.disabled)) {
    const disabled: string[] = [];
    for (const item of raw.disabled) {
      if (typeof item === 'string' && item.length > 0) {
        disabled.push(item);
      }
    }
    if (disabled.length > 0) {
      config.disabled = disabled;
    }
  }

  return config;
}
/** 解析声明式子 Agent 配置（`subagents` 数组）。 */
function parseSubAgentConfigs(raw: unknown): SubAgentConfig[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new ConfigError('subagents 配置必须是数组');
  }
  const list: SubAgentConfig[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      throw new ConfigError('subagents 每个条目必须是对象');
    }
    const entry = item as Record<string, unknown>;
    const name = entry.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ConfigError('subagents 每个条目必须包含非空 name');
    }
    const cfg: SubAgentConfig = { name: name.trim() };
    if (typeof entry.description === 'string' && entry.description.trim().length > 0) {
      cfg.description = entry.description.trim();
    }
    if (typeof entry.systemPrompt === 'string' && entry.systemPrompt.trim().length > 0) {
      cfg.systemPrompt = entry.systemPrompt.trim();
    }
    if (typeof entry.model === 'string' && entry.model.trim().length > 0) {
      cfg.model = entry.model.trim();
    }
    if (Array.isArray(entry.tools)) {
      const tools: string[] = [];
      for (const t of entry.tools) {
        if (typeof t === 'string' && t.length > 0) {
          tools.push(t);
        }
      }
      if (tools.length > 0) {
        cfg.tools = tools;
      }
    }
    if (typeof entry.maxRounds === 'number' && Number.isInteger(entry.maxRounds) && entry.maxRounds > 0) {
      cfg.maxRounds = entry.maxRounds;
    }
    if (typeof entry.maxResultLength === 'number' && Number.isInteger(entry.maxResultLength) && entry.maxResultLength > 0) {
      cfg.maxResultLength = entry.maxResultLength;
    }
    list.push(cfg);
  }
  return list.length > 0 ? list : undefined;
}
