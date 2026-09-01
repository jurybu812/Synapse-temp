import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@components': path.resolve(__dirname, './src/components'),
      '@services': path.resolve(__dirname, './src/services'),
      '@store': path.resolve(__dirname, './src/store'),
      '@hooks': path.resolve(__dirname, './src/hooks'),
      '@types': path.resolve(__dirname, './src/types'),
      '@platform': path.resolve(__dirname, './src/platform'),
    },
  },
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  // ★ PDF worker 修复（Vite 8.0.1 回归 #20631/#21422）：dep optimizer 预构建 pdfjs-dist 时不会把
  //   pdf.worker.mjs 资源同步搬进 .vite/deps，导致 ?url 解析出的 worker 路径在重启后漂移、PDF 打不开
  //   （fake worker fallback 报 Failed to fetch …pdf.worker.mjs?import）。排除 pdfjs-dist 出预构建 +
  //   显式声明 worker 为 ES 格式（pdf.worker.mjs 是纯 ESM），让 worker 走独立资源管线、不被 optimizer 干扰。
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
