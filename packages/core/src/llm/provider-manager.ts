/**
 * 多提供商 / 多模型选择器（Manager / Facade）。
 *
 * 根据 ResolvedProviderConfig 数组创建多个 LLMProvider 实例，默认使用第一个。
 * 实现 LLMProvider 接口（组合模式），使 DefaultAgent 和 CLI 无需感知内部有多组实现。
 * 用户可在 CLI 中通过 selectModel 切换当前使用的模型。
 *
 * 模型标识（label）：默认「提供商显示名/模型显示名」（缺省回退为对应 ID）。
 * 当显示名拼接撞车时，受影响条目改用「提供商 ID/模型 ID」（idLabel）以保证全局唯一。
 */

import { LLMProvider, GenerateResult } from './provider.js';
import { ChatMessage } from '../models/message.js';
import { createProvider, ResolvedProviderConfig, ProviderEntryConfig } from './factory.js';
import { ConfigError } from '../errors.js';
import { ToolDef } from '../tools/tool-registry.js';

/** 内部模型索引：记录条目来源与展示 label。 */
interface ModelRef {
  providerId: string;
  providerName?: string;
  modelId: string;
  modelName?: string;
  /** 展示 label：`${providerName ?? providerId}/${modelName ?? modelId}`。 */
  label: string;
  /** ID 限定名：`${providerId}/${modelId}`。 */
  idLabel: string;
}

interface ModelEntry {
  ref: ModelRef;
  provider: LLMProvider;
}

export interface ProviderManagerOptions {
  /** 可选：provider map（含显示名），用于生成展示 label。 */
  providerMap?: Record<string, ProviderEntryConfig>;
}

/* ================== ProviderManager =================== */

/**
 * 多提供商 / 多模型管理器。
 * 组合 LLMProvider 并转发调用，允许运行时切换当前模型。
 */
export class ProviderManager implements LLMProvider {
  readonly name = 'multi';
  model!: string;

  private readonly entries: ModelEntry[] = [];
  private currentIndex = 0;

  constructor(configs: ResolvedProviderConfig[], options?: ProviderManagerOptions) {
    if (configs.length === 0) {
      throw new ConfigError('Provider 配置数组不能为空');
    }

    const providerMap = options?.providerMap;

    // 先生成所有 label，再处理撞车：撞车条目使用 idLabel。
    const refs = configs.map((cfg) => {
      const prov = providerMap?.[cfg.name];
      const modelEntry = prov?.models?.[cfg.model];
      const providerName = prov?.name;
      const modelName = modelEntry?.name;
      return {
        providerId: cfg.name,
        providerName,
        modelId: cfg.model,
        modelName,
        label: `${providerName ?? cfg.name}/${modelName ?? cfg.model}`,
        idLabel: `${cfg.name}/${cfg.model}`,
      } satisfies ModelRef;
    });

    const used = new Map<string, number>();
    for (const ref of refs) {
      used.set(ref.label, (used.get(ref.label) ?? 0) + 1);
    }
    const finalRefs = refs.map((ref) =>
      used.get(ref.label)! > 1 ? { ...ref, label: ref.idLabel } : ref,
    );

    for (let i = 0; i < configs.length; i += 1) {
      this.entries.push({ ref: finalRefs[i], provider: createProvider(configs[i]) });
    }

    this.model = configs[0].model;
  }

  /**
   * 列出所有可用的模型（默认「提供商显示名/模型显示名」，撞车时用「提供商 ID/模型 ID」）。
   */
  listModels(): string[] {
    return this.entries.map((e) => e.ref.label);
  }

  /**
   * 列出当前提供商支持的模型（label 列表，含提供商前缀）。
   */
  listLocalModels(): string[] {
    const currentProviderId = this.entries[this.currentIndex].ref.providerId;
    return this.entries
      .filter((e) => e.ref.providerId === currentProviderId)
      .map((e) => e.ref.label);
  }

  /**
   * 切换模型。
   * @param qualified 限定模型名。匹配顺序：
   *                  1. 精确 label（显示名拼接或 idLabel）；
   *                  2. 无「/」时，在当前提供商范围内按模型 ID / 模型显示名匹配。
   */
  selectModel(qualified: string): void {
    const idx = this.resolveIndex(qualified);
    this.currentIndex = idx;
    this.model = this.entries[idx].ref.modelId;
  }

  /** 携带工具定义生成回复（转发到当前 provider）。 */
  async generateWithTools(messages: ChatMessage[], tools: ToolDef[], sessionId: string): Promise<GenerateResult> {
    return this.currentProvider().generateWithTools(messages, tools, sessionId);
  }

  /** 流式携带工具定义生成回复（转发到当前 provider）。 */
  async *streamWithTools(messages: ChatMessage[], tools: ToolDef[], sessionId: string) {
    yield* this.currentProvider().streamWithTools(messages, tools, sessionId);
  }

  /**
   * 获取当前供应商可用的模型列表（用于 REPL 渲染）。
   * @deprecated 使用 listLocalModels()。
   */
  getLocalModels(): string[] {
    return this.listLocalModels();
  }

  /** 返回当前条目的展示 label。 */
  currentLabel(): string {
    return this.entries[this.currentIndex].ref.label;
  }

  /** 获取当前选中的模型标识（展示 label 格式）。 */
  getCurrentModel(): string {
    return this.currentLabel();
  }

  /** 获取当前 provider 实例。 */
  private currentProvider(): LLMProvider {
    return this.entries[this.currentIndex].provider;
  }

  /**
   * 按模型名解析对应的 provider（不改动全局选中状态）。
   * @param qualified 限定模型名，省略时返回当前选中 provider。
   */
  getProviderByModel(qualified?: string): LLMProvider {
    if (!qualified) {
      return this.currentProvider();
    }
    return this.entries[this.resolveIndex(qualified)].provider;
  }

  /**
   * 解析限定名到条目下标。
   * 匹配顺序：精确 label / idLabel → 无「/」时当前提供商内按模型 ID/显示名。
   * 未命中时抛出 ConfigError（消息列出全部可用 label）。
   */
  private resolveIndex(qualified: string): number {
    // 1. 精确 label / idLabel 匹配
    const exactIdx = this.entries.findIndex(
      (e) => e.ref.label === qualified || e.ref.idLabel === qualified,
    );
    if (exactIdx !== -1) {
      return exactIdx;
    }

    // 2. 无「/」时在当前提供商内按模型 ID / 模型显示名匹配
    if (!qualified.includes('/')) {
      const currentProviderId = this.entries[this.currentIndex].ref.providerId;
      const localIdx = this.entries.findIndex(
        (e) =>
          e.ref.providerId === currentProviderId &&
          (e.ref.modelId === qualified || e.ref.modelName === qualified),
      );
      if (localIdx !== -1) {
        return localIdx;
      }
    }

    throw new ConfigError(
      `不支持的模型 "${qualified}"。可用模型：${this.listModels().join(', ')}`,
    );
  }
}
