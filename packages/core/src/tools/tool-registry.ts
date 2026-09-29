/**
 * 工具系统 —— 接口、注册表与实现。
 *
 * 每个工具实现 Tool 接口：提供 JSON Schema 描述（供 LLM function calling 使用）
 * 和 execute 方法（执行实际操作）。ToolRegistry 管理所有已注册工具的查找与调用。
 */

/** JSON Schema 中的属性定义。 */
export interface ToolParamSchema {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
}

/** 工具的函数定义（符合 OpenAI function calling 格式）。 */
export interface ToolFunctionDef {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParamSchema>;
    required: string[];
  };
}

/** 工具定义。 */
export interface ToolDef {
  type: 'function';
  function: ToolFunctionDef;
}

/**
 * 单个工具接口。
 */
export interface Tool {
  /** 工具名称（唯一标识）。 */
  readonly name: string;
  /** 工具定义（供 LLM 使用）。 */
  readonly definition: ToolDef;
  /** 执行工具，传入 LLM 解析出的参数，返回字符串结果。 */
  execute(args: Record<string, unknown>): Promise<string>;
}

/**
 * 工具注册表 —— 管理所有已注册的工具。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /** 注册一个工具。 */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 "${tool.name}" 已注册`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 获取所有工具定义（传给 LLM）。 */
  getDefinitions(): ToolDef[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /** 按名称获取工具。 */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 执行指定工具。 */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `错误：未知工具 "${name}"`;
    }
    try {
      return await tool.execute(args);
    } catch (error) {
      return `工具执行错误：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** 列出所有工具名称。 */
  listNames(): string[] {
    return Array.from(this.tools.keys());
  }
}
