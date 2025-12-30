import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/admin'),
  base: '/admin/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/admin'),
    }
  },
  build: {
    outDir: path.resolve(__dirname, 'public/admin'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/admin/index.html'),
    }
  }
});