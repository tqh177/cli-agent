/**
 * LLM Provider 工厂。
 *
 * 根据解析后的 Provider 配置创建对应的 LLMProvider 实现。核心对话逻辑只依赖
 * LLMProvider 接口，工厂负责将「解析后的配置」映射为具体实现，并将嵌套的
 * provider map 解析为扁平配置数组。
 *
 * 所有提供商统一使用 OpenAI 兼容的 chat completions 接口，因此 createProvider
 * 一律构造 OpenAIProvider，不再按 provider 名分派（无白名单）。
 */

import { LLMProvider } from './provider.js';
import { OpenAIProvider, OpenAIProviderOptions } from './openai-provider.js';
import { ConfigError } from '../errors.js';

/** 配置文件中单个提供商条目（对应 provider.<id>，参照 opencode 配置风格）。 */
export interface ProviderEntryConfig {
  /** 提供商显示名称（用于前端展示），缺省时回退为提供商 ID。 */
  name?: string;
  /** 提供商级选项。 */
  options?: {
    /** 自定义 baseURL，缺省时回退环境变量 {ID}_BASE_URL，再回退 OpenAI 默认地址。 */
    baseURL?: string;
  };
  /** 该提供商下的模型列表（key 为模型 ID，作为 chat completions 的 model 字段）。 */
  models: Record<string, ModelEntryConfig>;
}

/** 配置文件中单个模型条目。 */
export interface ModelEntryConfig {
  /** 模型显示名称（用于前端展示），缺省时回退为模型 ID。 */
  name?: string;
}

/** baseUrl 模板中按模型 ID 展开的占位符。 */
export const MODEL_PLACEHOLDER = '{model}';

/**
 * 解析后的扁平 Provider 配置（ProviderManager / createProvider 的输入）。
 */
export interface ResolvedProviderConfig {
  /** 提供商 ID。 */
  name: string;
  /** 模型 ID（作为 chat completions 的 model 字段）。 */
  model: string;
  /**
   * 已按优先级解析的 baseUrl。
   * 若模板含 {model} 占位符，已按该模型 ID 展开（如
   * `http://host/llm/{model}/v1` → `http://host/llm/deepseek-v4-pro/v1`）。
   */
  baseUrl: string;
  /** 来自环境变量的 apiKey。 */
  apiKey: string;
}

/** OpenAI 兼容接口的默认地址。 */
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * 环境变量名：{PROVIDER_ID}_API_KEY / {PROVIDER_ID}_BASE_URL。
 * 提供商 ID 先做规范化：转为大写，并将非 [A-Z0-9_] 字符替换为下划线，
 * 以保证生成的环境变量名在任意 shell 中合法（如 `deepseek-flash` → `DEEPSEEK_FLASH`）。
 */
export function envKeyFor(id: string, suffix: 'API_KEY' | 'BASE_URL'): string {
  const normalized = id.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return `${normalized}_${suffix}`;
}

/**
 * 纯函数：将嵌套 provider map 解析为扁平配置数组。
 *
 * - apiKey 从 env 的「{ID}_API_KEY」读取，缺失或为空抛 ConfigError；
 * - baseUrl 依次取配置 options.baseURL → env「{ID}_BASE_URL」→ 默认 OpenAI 地址；
 * - models 缺失或为空抛 ConfigError。
 *
 * @param providerMap 配置中的 provider 对象（top-level 已由调用方校验为非空对象）
 * @param env 环境变量快照（测试时可注入）
 * @returns 解析后的扁平配置数组，保持对象键插入序
 * @throws ConfigError
 */
export function resolveProviderMap(
  providerMap: Record<string, ProviderEntryConfig>,
  env: NodeJS.ProcessEnv,
): ResolvedProviderConfig[] {
  const resolved: ResolvedProviderConfig[] = [];

  for (const providerId of Object.keys(providerMap)) {
    const entry = providerMap[providerId];
    if (!entry || typeof entry !== 'object') {
      throw new ConfigError(`提供商 "${providerId}" 必须是对象`);
    }

    const models = entry.models;
    if (!models || typeof models !== 'object' || Object.keys(models).length === 0) {
      throw new ConfigError(`提供商 "${providerId}" 必须至少配置一个模型（models）`);
    }

    const apiKey = env[envKeyFor(providerId, 'API_KEY')];
    if (!apiKey) {
      throw new ConfigError(
        `提供商 "${providerId}" 缺少 API 密钥：请在 .env 中设置 ${envKeyFor(providerId, 'API_KEY')}`,
      );
    }

    const configBaseUrl = entry.options?.baseURL;
    const envBaseUrl = env[envKeyFor(providerId, 'BASE_URL')];
    const baseUrlTemplate =
      configBaseUrl && configBaseUrl.length > 0
        ? configBaseUrl
        : (envBaseUrl && envBaseUrl.length > 0 ? envBaseUrl : DEFAULT_BASE_URL);
    const baseUrlTemplateTrimmed = baseUrlTemplate.replace(/\/$/, '');

    for (const modelId of Object.keys(models)) {
      // baseUrl 模板含 {model} 时按当前模型 ID 展开（同一提供商不同模型可指向不同端点）。
      const baseUrl = baseUrlTemplateTrimmed.replaceAll(MODEL_PLACEHOLDER, modelId);
      resolved.push({
        name: providerId,
        model: modelId,
        baseUrl,
        apiKey,
      });
    }
  }

  return resolved;
}

/**
 * 根据解析后的配置创建对应的 LLMProvider。
 * 所有提供商统一使用 OpenAI 兼容实现。
 */
export function createProvider(config: ResolvedProviderConfig): LLMProvider {
  const options: OpenAIProviderOptions = {
    name: config.name,
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
  };
  return new OpenAIProvider(options);
}
