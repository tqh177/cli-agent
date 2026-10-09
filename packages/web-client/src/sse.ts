/**
 * SSE（Server-Sent Events）解析 —— 纯函数模块。
 *
 * 将服务端推送的 `data: {...}\n\n` 帧中的单行文本解析为结构化事件；
 * 与 React 组件/网络层解耦，便于单元测试。
 */

/** 服务端推送的 SSE 事件类型（对应 web-server 的 sendEvent）。 */
export type SSEMessage =
  | { type: 'token'; token: string }
  | { type: 'tool_call'; name: string; arguments: string }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'done' }
  | { type: 'stopped' }
  | { type: 'error'; message: string };

/**
 * 解析单行 SSE 文本（形如 `data: {...}`），返回结构化事件。
 * - 非 `data: ` 前缀的行返回 undefined（忽略注释、空行、event 字段等）；
 * - JSON 解析失败返回 undefined（调用方静默跳过，不做中断）；
 * - 未知 type 的事件返回 undefined（向前兼容新事件类型）。
 */
export function parseSSELine(line: string): SSEMessage | undefined {
  if (!line.startsWith('data: ')) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  switch (parsed.type) {
    case 'token':
      if (typeof parsed.token === 'string') return { type: 'token', token: parsed.token };
      return undefined;
    case 'tool_call':
      if (typeof parsed.name === 'string' && typeof parsed.arguments === 'string') {
        return { type: 'tool_call', name: parsed.name, arguments: parsed.arguments };
      }
      return undefined;
    case 'tool_result':
      if (typeof parsed.name === 'string' && typeof parsed.result === 'string') {
        return { type: 'tool_result', name: parsed.name, result: parsed.result };
      }
      return undefined;
    case 'done':
      return { type: 'done' };
    case 'stopped':
      return { type: 'stopped' };
    case 'error':
      if (typeof parsed.message === 'string') return { type: 'error', message: parsed.message };
      return undefined;
    default:
      return undefined;
  }
}
