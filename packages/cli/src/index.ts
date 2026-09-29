#!/usr/bin/env node
/**
 * CLI Agent 入口。
 *
 * 解析命令行参数、加载配置、组装核心组件（provider / store / agent），
 * 输出欢迎提示并进入 REPL 对话循环。
 */

import { dirname, resolve } from 'node:path';
import { ConfigError, SessionLoadError, ProviderManager, DefaultAgent, FileSessionStore, ToolRegistry, fileTools, shellTools, webTools, ToolCallbackParams, createConversation, ProviderEntryConfig, createSubAgentTool, DEFAULT_SUBAGENT_TOOLS, SubAgentConfig } from '@agent/core';
import { WebChatServer } from '@agent/web-server';
import { loadConfig } from './config.js';
import { loadEnvFile } from './env.js';
import { runRepl } from './repl.js';
import { setupGlobalProxy } from './proxy.js';

/** 解析后的命令行参数。 */
interface CliArgs {
  configPath?: string;
  resumeId?: string;
  web?: boolean;
  webPort?: number;
}

/**
 * 解析命令行参数，支持的选项：
 * --config <path>  指定配置文件路径
 * --resume <id>    恢复已保存的会话
 * --web            启动 Web 聊天界面
 * --web-port <n>   Web 服务端口（默认 3000）
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config' && i + 1 < argv.length) {
      args.configPath = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--resume' && i + 1 < argv.length) {
      args.resumeId = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--web') {
      args.web = true;
    } else if (argv[i] === '--web-port' && i + 1 < argv.length) {
      args.webPort = parseInt(argv[i + 1], 10);
      i += 1;
    }
  }
  return args;
}

/** 输出一条带样式的欢迎提示。 */
function printWelcome(): void {
  console.log('=================================');
  console.log('  CLI Agent 已启动');
  console.log('  输入内容开始对话，输入 exit/quit 退出');
  console.log('=================================');
}

/**
 * 根据工具配置判断是否应该注册该工具。
 * @param toolName 工具名称
 * @param toolConfig 工具配置
 * @returns 是否应该注册该工具
 */
function shouldRegisterTool(toolName: string, toolConfig?: { enabled?: string[]; disabled?: string[] }): boolean {
  // 如果没有配置，默认注册所有工具
  if (!toolConfig) {
    return true;
  }

  // 如果在禁用列表中，不注册（优先级最高）
  if (toolConfig.disabled && toolConfig.disabled.includes(toolName)) {
    return false;
  }

  // 如果启用了列表且为空，不注册任何工具
  if (toolConfig.enabled && toolConfig.enabled.length === 0) {
    return false;
  }

  // 如果有启用列表，只注册列表中的工具
  if (toolConfig.enabled && toolConfig.enabled.length > 0) {
    return toolConfig.enabled.includes(toolName);
  }

  // 默认注册
  return true;
}

/** 子 Agent 默认系统提示词（未在配置中声明时使用，含安全约束兜底）。 */
const SUBAGENT_FALLBACK_PROMPT = `你是被主 Agent 委派的子 Agent，只负责完成被分配的子任务。

安全约束（必须遵守）：
1. 只使用明确允许的工具，不得越权；
2. 所有操作限制在主工作区内；
3. 不执行危险操作。

输出要求：以 Markdown 结构化输出结论（如 ## 结论 / ## 修改清单 / ## 风险）。`;

/**
 * 按声明式配置装配子 Agent 工具，注册到父 ToolRegistry。
 *
 * 子 Agent 本身就是一个普通 Tool：直接复用父 agent（runTask 会自动
 * 用 allowedTools 收窄工具集、不污染父会话），无需额外创建子 agent 实例。
 */
function registerSubAgents(
  parentAgent: DefaultAgent,
  parentRegistry: ToolRegistry,
  configs?: SubAgentConfig[],
): void {
  if (!configs || configs.length === 0) {
    return;
  }
  for (const cfg of configs) {
    const toolName = `run_subagent_${cfg.name}`;
    if (parentRegistry.get(toolName)) {
      // 名称冲突直接跳过（保持现有注册语义：不覆盖）
      continue;
    }

    const tool = createSubAgentTool({
      name: toolName,
      description: cfg.description
        ? `${cfg.description}（子 Agent）`
        : `委派子任务给子 Agent "${cfg.name}" 执行，返回结构化结论`,
      systemPrompt: cfg.systemPrompt ?? SUBAGENT_FALLBACK_PROMPT,
      // 子 Agent 复用父 agent：runTask 不修改父会话，allowedTools 负责收窄工具。
      agent: parentAgent,
      model: cfg.model,
      maxRounds: cfg.maxRounds,
      allowedTools: cfg.tools ? [...cfg.tools] : [...DEFAULT_SUBAGENT_TOOLS],
      maxResultLength: cfg.maxResultLength,
    });

    parentRegistry.register(tool);
    console.log(`🧩 已注册子 Agent 工具: ${toolName}${cfg.model ? ` (模型: ${cfg.model})` : ''}`);
  }
}

/** 程序入口。 */
async function main(): Promise<void> {
  // 初始化全局代理（读取环境变量 HTTPS_PROXY/HTTP_PROXY/http_proxy）
  setupGlobalProxy();

  // 加载 .env（提供商 apiKey 等密钥），必须在 loadConfig 之前。
  loadEnvFile();

  const args = parseArgs(process.argv.slice(2));

  // 加载配置并组装核心组件（默认读取项目根目录下的 agent.config.json）。
  const configPath = args.configPath ?? resolve(process.cwd(), 'agent.config.json');
  const config = await loadConfig(configPath, { systemPromptPath: resolve(dirname(configPath), 'system_prompt.md') });
  const store = new FileSessionStore(resolve(config.storage.dir));

  // 根据配置过滤并注册工具
  const toolRegistry = new ToolRegistry();
  const allTools = [...fileTools, ...shellTools, ...webTools];

  for (const tool of allTools) {
    if (shouldRegisterTool(tool.name, config.tools)) {
      toolRegistry.register(tool);
    }
  }

  const agent = new DefaultAgent(
    new ProviderManager(config.llmResolved, { providerMap: config.llm as Record<string, ProviderEntryConfig> }),
    store,
    toolRegistry,
    (params: ToolCallbackParams) => {
    console.log(`\n🔧 工具调用: ${params.toolCall.function.name}`);
    console.log(`📝 参数: ${params.toolCall.function.arguments}`);
    // 截断过长的结果
    const result = params.result;
    const displayResult = result.length > 200 ? result.substring(0, 200) + '...' : result;
    console.log(`✅ 结果: ${displayResult}\n`);
  });

  // 按配置装配声明式子 Agent（注册 run_subagent_<name> 工具到主注册表）。
  registerSubAgents(agent, toolRegistry, config.subagents);

  printWelcome();

  // Web 模式
  if (args.web) {
    const webPort = args.webPort ?? 3000;
    const webStaticDir = resolve(process.cwd(), 'packages/web-client/dist');
    const webServer = new WebChatServer({
      port: webPort,
      host: '0.0.0.0',
      agent,
      store,
      systemPrompt: config.systemPrompt,
      staticDir: webStaticDir,
    });
    await webServer.start();
    console.log(`Web 聊天界面已启动: http://localhost:${webPort}`);
    console.log('按 Ctrl+C 退出');
    return;
  }

  // 如指定了 resume，恢复对应会话。
  if (args.resumeId) {
    agent.start(await agent.loadSession(args.resumeId));
    console.log(`已恢复会话：${args.resumeId}`);
  } else {
    // 新对话：使用配置的 system 提示词（如有）创建会话
    agent.start(createConversation(config.systemPrompt));
  }

  await runRepl({
    agent,
    out: (text) => console.log(text),
    write: (text) => process.stdout.write(text),
  });
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(`[配置错误] ${error.message}`);
  } else if (error instanceof SessionLoadError) {
    console.error(`[会话错误] ${error.message}`);
  } else {
    console.error(`[错误] ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
});
