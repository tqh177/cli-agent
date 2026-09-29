import { useState } from 'react';
import { ToolCallData } from '../api';

interface Props {
  tool: ToolCallData;
  expanded?: boolean;
  last?: boolean;
}

/** 尝试美化参数 JSON 文本，失败时原样返回 */
function formatArgs(args: string): string {
  if (!args) return args;
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

/** 尝试截断过长结果 */
function summarize(content: string, max: number): string {
  if (!content) return '';
  return content.length > max ? content.slice(0, max) + '…' : content;
}

export default function ToolCallCard({ tool, expanded, last }: Props) {
  const [open, setOpen] = useState(!!expanded);

  const running = tool.status === 'running';
  const error = tool.status === 'error';

  // 状态颜色与文案
  const statusIcon = running
    ? <span className="inline-block w-3 h-3 rounded-full border-2 border-ds-accent border-t-transparent animate-spin" />
    : error
      ? <span className="text-ds-error">✕</span>
      : <span className="text-ds-success">✓</span>;

  const statusText = running ? '执行中' : error ? '失败' : '完成';

  return (
    <div className={`border border-ds-border rounded-xl overflow-hidden bg-white/70 ${last ? '' : 'mb-2'}`}>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-ds-input/60 transition-colors"
      >
        <span className="shrink-0 w-5 h-5 flex items-center justify-center text-[11px] text-ds-accent bg-ds-accent-light rounded-md">🔧</span>
        <span className="flex-1 truncate text-xs font-medium text-ds-text">{tool.name}</span>
        <span className={`shrink-0 text-[11px] px-1.5 py-0.5 rounded-full ${
          running ? 'bg-ds-accent-light text-ds-accent'
            : error ? 'bg-red-50 text-ds-error'
            : 'bg-emerald-50 text-ds-success'
        }`}>{statusIcon} {statusText}</span>
        <svg
          className={`shrink-0 text-ds-text-tertiary transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
        >
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>

      {open && (
        <div className="px-3 pb-2.5 pt-1 border-t border-ds-border/60 space-y-2">
          {/* 参数 */}
          {tool.arguments && (
            <div>
              <div className="text-2xs text-ds-text-tertiary mb-1">参数</div>
              <pre className="text-2xs bg-ds-input/70 rounded-lg p-2 overflow-x-auto text-ds-text-secondary leading-relaxed whitespace-pre-wrap">
                {formatArgs(tool.arguments)}
              </pre>
            </div>
          )}
          {/* 结果 */}
          {tool.result && (
            <div>
              <div className="text-2xs text-ds-text-tertiary mb-1">结果</div>
              <pre className={`text-2xs rounded-lg p-2 overflow-x-auto leading-relaxed whitespace-pre-wrap ${
                error ? 'bg-red-50 text-ds-error' : 'bg-ds-input/70 text-ds-text-secondary'
              }`}>
                {summarize(tool.result, 600)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
