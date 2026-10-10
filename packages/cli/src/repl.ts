/**
 * REPL 交互循环。
 *
 * 负责与用户在命令行进行多轮对话：读取输入、过滤空/空白输入、识别退出命令、
 * 识别斜杠命令（/list、/delete、/clear）、调用 AgentSDK 流式生成回复并渲染、
 * 在回复结束后保存会话。
 */

import * as readline from 'node:readline/promises';
import { AgentSDK, SessionLoadError } from '@agent/core';
import { isValidInput } from '@agent/core';

/** 退出命令集合（大小写不敏感）。 */
const EXIT_COMMANDS = new Set(['exit', 'quit']);

/** REPL 运行时依赖（可注入以便测试）。 */
export interface REPLDeps {
  agent: AgentSDK;
  /** 输出一行文本。 */
  out: (text: string) => void;
  /** 就地输出回复片段（不换行）。 */
  write: (text: string) => void;
}

/**
 * 判断给定输入是否为退出命令。
 */
export function isExitCommand(input: string): boolean {
  return EXIT_COMMANDS.has(input.trim().toLowerCase());
}

/**
 * 判断给定输入是否为斜杠命令。
 */
export function isSlashCommand(input: string): boolean {
  return input.trim().startsWith('/');
}

/**
 * 处理斜杠命令，返回 true 表示已处理（应继续循环），false 表示未识别。
 */
export async function handleSlashCommand(
  input: string,
  agent: AgentSDK,
  out: (text: string) => void,
  readLine: () => Promise<string>,
): Promise<boolean> {
  const trimmed = input.trim();
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '/list') {
    const ids = await agent.listSessions();
    if (ids.length === 0) {
      out('没有已保存的会话。');
      return true;
    }
    out(`共 ${ids.length} 个会话：`);
    for (const id of ids) {
      try {
        const conv = await agent.loadSession(id);
        const msgCount = conv.messages.length;
        out(`  ${id}  |  创建时间: ${conv.createdAt}  |  消息数: ${msgCount}`);
      } catch {
        out(`  ${id}  |  (无法加载详情)`);
      }
    }
    return true;
  }

  if (cmd === '/delete') {
    if (parts.length < 2) {
      out('用法: /delete <会话ID>');
      return true;
    }
    const id = parts[1];
    try {
      await agent.deleteSession(id);
      out(`已删除会话: ${id}`);
    } catch (error) {
      if (error instanceof SessionLoadError) {
        out(`会话不存在: ${id}`);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        out(`删除失败: ${message}`);
      }
    }
    return true;
  }

  if (cmd === '/clear') {
    const ids = await agent.listSessions();
    if (ids.length === 0) {
      out('没有可删除的会话。');
      return true;
    }
    out(`确定要删除所有 ${ids.length} 个会话吗？输入 yes 确认：`);
    const confirm = await readLine();
    if (confirm.trim().toLowerCase() === 'yes') {
      const deleted = await agent.deleteAllSessions();
      out(`已删除 ${deleted} 个会话。`);
    } else {
      out('已取消。');
    }
    return true;
  }

  return false;
}

/**
 * 运行 REPL 对话循环，直到用户输入退出命令或流结束。
 */
export async function runRepl(deps: REPLDeps): Promise<void> {
  const { agent, out, write } = deps;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 提示符前缀。
  const readLine = (): Promise<string> => rl.question('你> ');

  let input = await readLine();
  while (!isExitCommand(input)) {
    // 处理斜杠命令。
    if (isSlashCommand(input)) {
      await handleSlashCommand(input, agent, out, readLine);
      input = await readLine();
      continue;
    }

    // 忽略空或纯空白输入（Requirement 1.4）。
    if (!isValidInput(input)) {
      input = await readLine();
      continue;
    }

    const conv = agent.getCurrentConversation();
    out('助手> ');
    try {
      let reply = '';
      // 流式生成并逐步渲染。
      for await (const token of agent.streamReply(conv, input)) {
        reply += token;
        write(token);
      }
      out('');
      // 回复结束后保存会话。
      await agent.saveSession();
    } catch (error) {
      // 报错也保存会话：streamReply 的 catch 已把已累积消息写入 agent.current，
      // 此处落盘避免报错导致本轮记录丢失
      await agent.saveSession().catch(() => { /* 保存失败不掩盖原始错误 */ });
      const message = error instanceof Error ? error.message : String(error);
      out('');
      out(`[错误] ${message}`);
    }

    input = await readLine();
  }

  rl.close();
}
