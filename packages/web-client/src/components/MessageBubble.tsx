import { App, Popconfirm } from 'antd';
import { ChatMessage } from '../api';
import MarkdownRenderer from './MarkdownRenderer';
import ToolCallCard from './ToolCallCard';

interface Props {
  message: ChatMessage;
  /** 是否为新一轮对话的第一条消息（用于拉开轮次间距） */
  turnStart?: boolean;
  /** 删除该消息及其配对回复的回调 */
  onDelete?: () => void;
}

export default function MessageBubble({ message, turnStart, onDelete }: Props) {
  const { message: antdMessage } = App.useApp();
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(message.content);
      antdMessage.success('已复制到剪贴板');
    } catch {
      antdMessage.error('复制失败');
    }
  };


  // 计算外边距：不同轮次之间加大间距，轮次内部保持紧凑
  const wrapperClass = turnStart
    ? 'mt-8 first:mt-2'
    : isUser
      ? 'mt-4'
      : 'mt-1.5';

  // 工具调用单独的消息（旧版兼容）：以卡片形式展示
  if (isTool) {
    return (
      <div className={`flex justify-start ${wrapperClass}`}>
        <div className="w-full max-w-[85%]">
          <ToolCallCard
            tool={{ name: '工具返回', arguments: '', result: message.content, status: 'success' }}
            last
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} ${wrapperClass} group`}>
      {/* AI 头像 */}
      {!isUser && (
        <div className="shrink-0 mr-3 mt-0.5">
          <div className="w-7 h-7 rounded-full bg-ds-accent-light flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ds-accent">
              <path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/>
              <path d="M20 21v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1"/>
            </svg>
          </div>
        </div>
      )}

      <div className="max-w-[85%] min-w-0 relative">
        {/* 工具调用卡片区 */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mb-2">
            {message.toolCalls.map((tc, i) => (
              <ToolCallCard key={i} tool={tc} last={i === message.toolCalls!.length - 1} />
            ))}
          </div>
        )}

        {/* 文本气泡：有内容时渲染内容；无内容但有工具卡片时跳过气泡（避免误导性等待文案） */}
        {(message.content || !(message.toolCalls && message.toolCalls.length > 0)) && (
          <div
            className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
              isUser
                ? 'bg-ds-user-bubble text-white rounded-br-md shadow-bubble'
                : 'bg-ds-bubble border border-ds-border rounded-bl-md shadow-bubble'
            }`}
          >
            {message.content ? (
              <div className="message-content"><MarkdownRenderer content={message.content} /></div>
            ) : (
              // 无内容、无工具卡片的助手消息（罕见兜底）
              <div className="text-ds-text-tertiary text-xs">正在处理…</div>
            )}
          </div>
        )}

        {/* 操作按钮区 — DeepSeek 风格：气泡下方右下角，hover 消息时淡入 */}
        <div className="mt-1 flex items-center gap-0.5 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleCopy}
            className="w-6 h-6 flex items-center justify-center rounded-md text-ds-text-tertiary hover:bg-ds-input hover:text-ds-text transition-all"
            title="复制"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
          {isUser && onDelete && (
            <Popconfirm
              title="删除该轮对话？"
              description="将删除此消息及其 AI 回复"
              onConfirm={onDelete}
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true, size: 'small' }}
              cancelButtonProps={{ size: 'small' }}
            >
              <button
                className="w-6 h-6 flex items-center justify-center rounded-md text-ds-text-tertiary hover:bg-red-50 hover:text-ds-error transition-all"
                title="删除此轮对话"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </Popconfirm>
          )}
        </div>
      </div>

      {/* 用户头像 */}
      {isUser && (
        <div className="shrink-0 ml-3 mt-0.5">
          <div className="w-7 h-7 rounded-full bg-ds-accent flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}
