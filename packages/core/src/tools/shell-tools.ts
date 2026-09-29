/**
 * 命令执行工具：run_shell。
 */

import { exec } from 'node:child_process';
import { Tool } from './tool-registry.js';

const TIMEOUT_MS = 120_000; // 2 分钟默认超时

const shell = 'bash';
const runShellTool: Tool = {
  name: 'run_shell',
  definition: {
    type: 'function',
    function: {
      name: 'run_shell',
      description: '执行 shell 命令并返回输出。支持超时设置。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          timeout: { type: 'number', description: '超时时间（毫秒），默认 120000' },
          directory: { type: 'string', description: '执行命令的工作目录（绝对路径），默认为当前工作目录' },
        },
        required: ['command'],
      },
    },
  },
  async execute(args) {
    const command = args.command as string;
    const timeout = typeof args.timeout === 'number' ? args.timeout : TIMEOUT_MS;
    const cwd = typeof args.directory === 'string' ? args.directory : process.cwd();

    return new Promise<string>((resolve) => {
      const child = exec(command, { cwd, timeout, shell, maxBuffer: 10 * 1024 * 1024, encoding:'buffer' }, (error, stdout, stderr) => {
        if (error) {
          resolve(`命令执行失败（退出码 ${error.code}）：\n${decodeOutput(stderr) || error.message}`);
          return;
        }
        const output = [decodeOutput(stdout), decodeOutput(stderr)].filter(Boolean).join('\n');
        console.log(`命令执行成功：${output}`);
        resolve(output || '(无输出)');
      });

      // 超时处理
      const timer = setTimeout(() => {
        child.kill();
        resolve(`命令超时（${timeout}ms）：${command}`);
      }, timeout + 1000);
      child.on('close', () => clearTimeout(timer));
    });
  },
};

export const shellTools: Tool[] = [runShellTool];

function decodeOutput(buf: Buffer): string {
  // 先严格 UTF-8，失败（说明是 GBK）再回退
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gbk').decode(buf);
  }
}
