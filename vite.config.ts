import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'src/client',
  optimizeDeps: {
    include: [
      '@wix/design-system',
      '@wix/wix-ui-icons-common',
      'react',
      'react-dom',
    ],
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'src/client/index.html'),
        widget: path.resolve(__dirname, 'src/client/widget.html'),
        settings: path.resolve(__dirname, 'src/client/settings.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/client/src'),
    },
  },
});
