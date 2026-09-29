import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          antd: ['antd'],
          markdown: ['react-markdown', 'remark-gfm', 'rehype-highlight', 'rehype-sanitize'],
          virtuoso: ['react-virtuoso'],
        },
      },
    },
  },
});
