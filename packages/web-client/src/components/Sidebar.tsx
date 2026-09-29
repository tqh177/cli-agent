import { Popconfirm } from 'antd';
import { ConversationItem } from '../api';

interface Props {
  conversations: ConversationItem[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNewChat: () => void;
}

export default function Sidebar({ conversations, currentId, onSelect, onDelete, onNewChat }: Props) {
  return (
    <aside className="w-64 bg-ds-sidebar border-r border-ds-border-light flex flex-col shrink-0 shadow-sidebar">
      {/* 新对话按钮 */}
      <div className="px-3 py-3">
        <button
          onClick={onNewChat}
          className="w-full text-xs font-medium bg-ds-accent text-white px-3 py-2 rounded-lg hover:bg-ds-accent-hover transition-all shadow-sm hover:shadow-md active:scale-95 flex items-center justify-center gap-1.5"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          新对话
        </button>
      </div>

      {/* 头部 */}
      <div className="px-4 py-2 border-b border-ds-border-light">
        <h2 className="text-xs font-semibold text-ds-text-secondary uppercase tracking-wider select-none">
          对话历史
        </h2>
      </div>

      {/* 对话列表 */}
      <div className="flex-1 overflow-y-auto sidebar-scroll p-2 space-y-0.5">
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-ds-text-tertiary">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4" className="mb-2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span className="text-xs">暂无对话</span>
          </div>
        ) : (
          conversations.map(conv => {
            const isActive = conv.id === currentId;
            return (
              <div
                key={conv.id}
                className={`group flex items-center rounded-lg px-3 py-2.5 cursor-pointer transition-all text-sm ${
                  isActive
                    ? 'bg-ds-accent-light border border-ds-accent/20 shadow-sm'
                    : 'hover:bg-white/50 border border-transparent'
                }`}
              >
                <div
                  className="flex-1 min-w-0"
                  onClick={() => onSelect(conv.id)}
                >
                  <div className={`truncate ${isActive ? 'text-ds-accent font-medium' : 'text-ds-text'}`}>
                    {conv.preview || '新对话'}
                  </div>
                  <div className="text-2xs text-ds-text-tertiary mt-0.5">
                    {conv.messageCount ?? 0} 轮对话
                  </div>
                </div>
                <Popconfirm
                  title="确认删除该对话？"
                  description="删除后不可恢复"
                  onConfirm={() => onDelete(conv.id)}
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                >
                  <button
                    className="opacity-0 group-hover:opacity-100 text-ds-text-tertiary hover:text-ds-error p-1 rounded-md hover:bg-red-50 transition-all shrink-0 ml-1"
                    title="删除对话"
                    onClick={(e) => { e.stopPropagation(); }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                  </button>
                </Popconfirm>
              </div>
            );
          })
        )}
      </div>

      {/* 底部信息 */}
      <div className="px-4 py-2.5 border-t border-ds-border-light">
        <p className="text-2xs text-ds-text-tertiary text-center select-none">
          CLI Agent
        </p>
      </div>
    </aside>
  );
}
