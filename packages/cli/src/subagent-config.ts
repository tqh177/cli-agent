/**
 * 从 .agent/subagent/*.md 文件加载声明式子 Agent 配置。
 *
 * 每个 MD 文件包含 YAML frontmatter（name/description/model/tools/maxRounds/maxResultLength）
 * 和 markdown body（作为 systemPrompt）。文件名 stem 可作为 name 的默认值。
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { ConfigError, SubAgentConfig } from '@agent/core';

/** name 字段的合法格式：字母开头，允许字母、数字、下划线、连字符。 */
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * 从 .agent/subagent/*.md 文件加载子 Agent 配置。
 *
 * @param baseDir 配置基目录（通常为 agent.config.json 所在目录），
 *                函数会在其下查找 .agent/subagent/ 子目录。
 * @returns SubAgentConfig[] 或 undefined（目录不存在或无 .md 文件时）
 */
export async function loadSubAgentConfigsFromDir(
  baseDir: string,
): Promise<SubAgentConfig[] | undefined> {
  const subagentDir = join(baseDir, '.agent', 'subagent');

  let entries: string[];
  try {
    entries = await readdir(subagentDir);
  } catch {
    // 目录不存在或不可读 → 无文件配置，不算错误。
    return undefined;
  }

  // 筛选 .md 文件，按字母序排列确保确定性。
  const mdFiles = entries
    .filter((name) => name.endsWith('.md'))
    .sort();

  if (mdFiles.length === 0) {
    return undefined;
  }

  const configs: SubAgentConfig[] = [];

  for (const fileName of mdFiles) {
    const filePath = join(subagentDir, fileName);
    const stem = fileName.slice(0, -3); // 去掉 .md 后缀

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      throw new ConfigError(`无法读取子 Agent 配置文件 "${filePath}"：${String(error)}`);
    }

    // gray-matter 解析 frontmatter + body
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch (error) {
      throw new ConfigError(
        `子 Agent 配置文件 "${fileName}" 的 YAML frontmatter 解析失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const data = parsed.data as Record<string, unknown>;
    const body = parsed.content.trim();

    // name：frontmatter 显式指定 > 文件名 stem
    let name: string;
    if (data.name !== undefined && data.name !== null) {
      if (typeof data.name !== 'string' || data.name.trim().length === 0) {
        throw new ConfigError(`子 Agent 配置文件 "${fileName}" 的 name 字段必须为非空字符串`);
      }
      name = data.name.trim();
    } else {
      name = stem;
    }
    if (!NAME_PATTERN.test(name)) {
      throw new ConfigError(
        `子 Agent 配置文件 "${fileName}" 的 name "${name}" 不合法，须匹配 ${NAME_PATTERN.source}（建议在 frontmatter 中显式指定 name）`,
      );
    }

    const cfg: SubAgentConfig = { name };

    // description
    if (typeof data.description === 'string' && data.description.trim().length > 0) {
      cfg.description = data.description.trim();
    }

    // systemPrompt（来自 markdown body）
    if (body.length > 0) {
      cfg.systemPrompt = body;
    }

    // model
    if (typeof data.model === 'string' && data.model.trim().length > 0) {
      cfg.model = data.model.trim();
    }

    // tools
    if (Array.isArray(data.tools)) {
      const tools: string[] = [];
      for (const t of data.tools) {
        if (typeof t === 'string' && t.length > 0) {
          tools.push(t);
        }
      }
      if (tools.length > 0) {
        cfg.tools = tools;
      }
    }

    // maxRounds
    if (data.maxRounds !== undefined) {
      if (typeof data.maxRounds !== 'number' || !Number.isInteger(data.maxRounds) || data.maxRounds <= 0) {
        throw new ConfigError(`子 Agent 配置文件 "${fileName}" 的 maxRounds 必须为正整数`);
      }
      cfg.maxRounds = data.maxRounds;
    }

    // maxResultLength
    if (data.maxResultLength !== undefined) {
      if (typeof data.maxResultLength !== 'number' || !Number.isInteger(data.maxResultLength) || data.maxResultLength <= 0) {
        throw new ConfigError(`子 Agent 配置文件 "${fileName}" 的 maxResultLength 必须为正整数`);
      }
      cfg.maxResultLength = data.maxResultLength;
    }

    configs.push(cfg);
  }

  return configs.length > 0 ? configs : undefined;
}
