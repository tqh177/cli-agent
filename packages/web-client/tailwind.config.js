/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ds: {
          // 主背景
          bg: '#f7f8fa',
          // 侧边栏背景
          sidebar: '#f0f2f5',
          // 消息气泡 - AI
          bubble: '#ffffff',
          // 输入框背景
          input: '#f3f4f6',
          // 品牌蓝（DeepSeek 风格）
          accent: '#4d6bfe',
          'accent-hover': '#3b5ae0',
          'accent-light': 'rgba(77, 107, 254, 0.08)',
          'accent-light-hover': 'rgba(77, 107, 254, 0.15)',
          // 文字
          text: '#1a1a2e',
          'text-secondary': '#6b7280',
          'text-tertiary': '#9ca3af',
          // 边框
          border: '#e5e7eb',
          'border-light': '#f0f0f0',
          // 用户消息气泡
          'user-bubble': '#4d6bfe',
          'user-bubble-hover': '#3b5ae0',
          // 代码块背景
          'code-bg': '#1e1e2e',
          // 成功/警告/错误
          success: '#10b981',
          warning: '#f59e0b',
          error: '#ef4444',
        },
      },
      borderRadius: {
        'xl': '0.75rem',
        '2xl': '1rem',
        '3xl': '1.25rem',
      },
      boxShadow: {
        'soft': '0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.06)',
        'bubble': '0 1px 2px rgba(0, 0, 0, 0.04)',
        'sidebar': '1px 0 3px rgba(0, 0, 0, 0.02)',
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
    },
  },
  plugins: [],
};
