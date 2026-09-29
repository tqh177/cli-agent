/**
 * .env 文件加载。
 *
 * 在 CLI 启动时把项目根目录的 .env 文件并入 process.env，使提供商 apiKey 等
 * 密钥不进代码仓库。已有环境变量优先（不覆盖）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError } from '@agent/core';

/**
 * 解析 .env 内容为键值对（仅用于旧版 Node fallback，Node ≥22 直接使用内置加载）。
 * - 跳过空行与以 # 开头的注释行；
 * - 仅当 key 尚未存在于 process.env 时设置（已有值优先）。
 */
export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key.length > 0) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 把指定 .env 文件加载到 process.env（已有变量不被覆盖）。
 * @param envPath .env 文件路径；缺省为 process.cwd()/.env。
 * @throws ConfigError 当文件存在但无法读取（ENOENT 静默）。
 */
export function loadEnvFile(envPath?: string): void {
  const path = envPath ?? resolve(process.cwd(), '.env');

  if (!existsSync(path)) {
    return;
  }

  // Node ≥ 22 提供内置加载；其余版本使用手写解析 fallback。
  const load = (process as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof load === 'function') {
    try {
      load(path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        return;
      }
      throw new ConfigError(`无法加载 .env 文件 "${path}"：${String(error)}`);
    }
  }

  try {
    const content = readFileSync(path, 'utf8');
    const pairs = parseEnvContent(content);
    for (const [key, value] of Object.entries(pairs)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return;
    }
    throw new ConfigError(`无法加载 .env 文件 "${path}"：${String(error)}`);
  }
}
