/**
 * 文件操作工具：read_file、write_file、edit_file、glob、grep。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { glob as globRaw } from 'node:fs/promises';
import { Tool } from './tool-registry.js';

/** Node 22 fs.glob 的类型兼容声明。 */
interface GlobEntry {
  path: string;
}
type GlobResult = string | GlobEntry;

function glob(pattern: string | string[], options?: { cwd?: string; exclude?: (path: string) => boolean }): AsyncIterable<GlobResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globRaw as unknown as (p: string | string[], opts?: Record<string, unknown>) => AsyncIterable<GlobResult>)(pattern, options as Record<string, unknown>);
}

const WORKSPACE_ROOT = process.cwd();

function safePath(userPath: string): string {
  const resolved = resolve(WORKSPACE_ROOT, userPath);
  const rel = relative(WORKSPACE_ROOT, resolved);
  if (rel.startsWith('..') || rel.startsWith(`${sep}..`) || (process.platform === 'win32' && rel.includes(':'))) {
    throw new Error(`路径 "${userPath}" 超出工作区范围`);
  }
  return resolved;
}

/* ==================== read_file ==================== */

const readFileTool: Tool = {
  name: 'read_file',
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取指定文件的内容。如果文件较大，内容会被截断。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '要读取的文件绝对路径' },
          offset: { type: 'number', description: '起始行号（0-based），与 limit 配合使用进行分页' },
          limit: { type: 'number', description: '最多读取的行数，与 offset 配合使用进行分页' },
        },
        required: ['file_path'],
      },
    },
  },
  async execute(args) {
    const filePath = safePath(args.file_path as string);
    const content = await readFile(filePath, 'utf8');
    const lines = content.split('\n');
    const offset = typeof args.offset === 'number' ? args.offset : 0;
    const limit = typeof args.limit === 'number' ? args.limit : lines.length;
    return lines.slice(offset, offset + limit).join('\n');
  },
};

/* ==================== write_file ==================== */

const writeFileTool: Tool = {
  name: 'write_file',
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description: '将内容写入指定文件（覆盖已有内容）。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '要写入的文件绝对路径' },
          content: { type: 'string', description: '要写入的内容' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  async execute(args) {
    const filePath = safePath(args.file_path as string);
    const content = args.content as string;
    await writeFile(filePath, content, 'utf8');
    return `文件已写入：${filePath}（${content.length} 字符）`;
  },
};

/* ==================== edit_file ==================== */

const editFileTool: Tool = {
  name: 'edit_file',
  definition: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '在文件中精确替换文本（将 old_string 替换为 new_string）。默认替换第一个匹配项，可设置 replace_all 替换所有。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '要编辑的文件绝对路径' },
          old_string: { type: 'string', description: '要替换的原始文本（必须精确匹配）' },
          new_string: { type: 'string', description: '替换后的新文本' },
          replace_all: { type: 'boolean', description: '是否替换所有匹配项，默认 false' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  async execute(args) {
    const filePath = safePath(args.file_path as string);
    const oldStr = args.old_string as string;
    const newStr = args.new_string as string;
    const replaceAll = args.replace_all === true;
    const content = await readFile(filePath, 'utf8');

    if (!content.includes(oldStr)) {
      return `错误：文件中未找到要替换的文本`;
    }

    const newContent = replaceAll
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, newStr);

    await writeFile(filePath, newContent, 'utf8');
    const count = content.split(oldStr).length - 1;
    const replaced = replaceAll ? count : 1;
    return `文件已编辑：${filePath}（替换了 ${replaced} 处）`;
  },
};

/* ==================== glob ==================== */

const globTool: Tool = {
  name: 'glob',
  definition: {
    type: 'function',
    function: {
      name: 'glob',
      description: '按 glob 模式搜索匹配的文件路径。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式，如 "**/*.ts"、"src/**/*.js"' },
          path: { type: 'string', description: '搜索的根目录（绝对路径），默认为当前工作目录' },
        },
        required: ['pattern'],
      },
    },
  },
  async execute(args) {
    const pattern = args.pattern as string;
    const baseDir = typeof args.path === 'string' ? safePath(args.path as string) : WORKSPACE_ROOT;
    const files: string[] = [];
    for await (const entry of glob(pattern, { cwd: baseDir, exclude: (d) => d.includes('node_modules') })) {
      files.push(typeof entry === 'string' ? entry : entry.path);
    }
    return files.length > 0 ? files.join('\n') : '未找到匹配的文件';
  },
};

/* ==================== grep ==================== */

const grepTool: Tool = {
  name: 'grep',
  definition: {
    type: 'function',
    function: {
      name: 'grep',
      description: '在文件内容中按正则表达式搜索匹配行。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '要搜索的正则表达式模式' },
          glob: { type: 'string', description: '限定搜索的文件 glob 模式，如 "*.ts"' },
          path: { type: 'string', description: '搜索的根目录（绝对路径），默认为当前工作目录' },
          limit: { type: 'number', description: '最多返回的匹配行数' },
        },
        required: ['pattern'],
      },
    },
  },
  async execute(args) {
    const pattern = args.pattern as string;
    const fileGlob = typeof args.glob === 'string' ? args.glob : '**/*';
    const baseDir = typeof args.path === 'string' ? safePath(args.path as string) : WORKSPACE_ROOT;
    const maxResults = typeof args.limit === 'number' ? args.limit : 50;

    const results: string[] = [];
    let count = 0;

    for await (const entry of glob(fileGlob, { cwd: baseDir, exclude: (d) => d.includes('node_modules') })) {
      if (count >= maxResults) break;
      const relativePath = typeof entry === 'string' ? entry : entry.path;
      const fullPath = resolve(baseDir, relativePath);
      const content = await readFile(fullPath, 'utf8');
      const lines = content.split('\n');
      const regex = new RegExp(pattern, 'gi');
      for (let i = 0; i < lines.length && count < maxResults; i++) {
        if (regex.test(lines[i])) {
          results.push(`${relativePath}:${i + 1}: ${lines[i].trim()}`);
          count++;
        }
      }
    }

    return results.length > 0 ? results.join('\n') : '未找到匹配内容';
  },
};

/* ==================== 导出 ==================== */

export const fileTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
];
