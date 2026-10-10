/**
 * 文件操作工具：read_file、write_file、edit_file、glob、grep。
 */

import { readFile, writeFile, realpath, glob } from 'node:fs/promises';
import { resolve, relative, sep, isAbsolute, dirname, basename, join } from 'node:path';
import { Tool } from './tool-registry.js';

const WORKSPACE_ROOT = resolve(process.cwd());

/** 缓存工作区根目录的真实路径（解析软链接后），避免 cwd 自身是软链接导致误判。 */
let realWorkspaceRootPromise: Promise<string> | null = null;
function getRealWorkspaceRoot(): Promise<string> {
  if (!realWorkspaceRootPromise) {
    realWorkspaceRootPromise = realpathSafe(WORKSPACE_ROOT);
  }
  return realWorkspaceRootPromise;
}

/**
 * 解析真实路径（连同符号链接）。对尚不存在的路径（如待写入的新文件），
 * 回溯到最近的已存在祖先目录做真实化，再拼回剩余部分。
 */
async function realpathSafe(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    const parent = dirname(target);
    if (parent === target) return target;
    return join(await realpathSafe(parent), basename(target));
  }
}

/** 判断 target 是否位于 root 之内（含 root 本身）。 */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  // rel === ''           -> 即 root 本身
  // isAbsolute(rel)      -> 跨盘符（Windows 下 relative 返回绝对路径）
  // '..' / '..'+sep      -> 逃逸到上层目录（精确匹配，避免误伤 "..config" 等）
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * 将用户提供的路径解析为工作区内的绝对路径，并做边界校验。
 * 会同时校验「解析后的路径」与「真实路径（解软链后）」，防止符号链接逃逸。
 */
async function safePath(userPath: string): Promise<string> {
  if (typeof userPath !== 'string' || userPath.trim() === '') {
    throw new Error('路径必须是非空字符串');
  }

  const resolved = resolve(WORKSPACE_ROOT, userPath);
  if (!isInside(WORKSPACE_ROOT, resolved)) {
    throw new Error(`路径 "${userPath}" 超出工作区范围`);
  }

  const realRoot = await getRealWorkspaceRoot();
  const real = await realpathSafe(resolved);
  if (!isInside(realRoot, real)) {
    throw new Error(`路径 "${userPath}" 超出工作区范围`);
  }

  return real;
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
    const filePath = await safePath(args.file_path as string);
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
    const filePath = await safePath(args.file_path as string);
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
    const filePath = await safePath(args.file_path as string);
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
    const baseDir = typeof args.path === 'string' ? await safePath(args.path as string) : await getRealWorkspaceRoot();
    const files: string[] = [];
    for await (const entry of glob(pattern, { cwd: baseDir, exclude: (d) => d.includes('node_modules') })) {
      files.push(entry);
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
    const baseDir = typeof args.path === 'string' ? await safePath(args.path as string) : await getRealWorkspaceRoot();
    const maxResults = typeof args.limit === 'number' ? args.limit : 50;

    const results: string[] = [];
    let count = 0;

    for await (const entry of glob(fileGlob, { cwd: baseDir, exclude: (d) => d.includes('node_modules') })) {
      if (count >= maxResults) break;
      const relativePath = entry;
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
