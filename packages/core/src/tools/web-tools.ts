/**
 * Web 工具：web_fetch。
 */

import { Tool } from './tool-registry.js';

const FETCH_TIMEOUT_MS = 30_000;

const webFetchTool: Tool = {
  name: 'web_fetch',
  definition: {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '获取指定 URL 的内容（HTML 页面）。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要获取的 URL' },
          timeout: { type: 'number', description: '超时时间（毫秒），默认 30000' },
        },
        required: ['url'],
      },
    },
  },
  async execute(args) {
    const url = args.url as string;
    const timeout = typeof args.timeout === 'number' ? args.timeout : FETCH_TIMEOUT_MS;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!response.ok) {
        return `HTTP 错误 ${response.status}：${response.statusText}`;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/html') || contentType.includes('text/plain')) {
        const text = await response.text();
        const maxLen = 50_000;
        if (text.length > maxLen) {
          return text.slice(0, maxLen) + `\n...(内容已截断，原始长度 ${text.length} 字符)`;
        }
        return text;
      }

      return `内容类型 ${contentType} 不支持文本读取`;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return `请求超时（${timeout}ms）：${url}`;
      }
      return `请求失败：${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

export const webTools: Tool[] = [webFetchTool];
