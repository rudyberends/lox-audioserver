import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: '/admin/',
  root: 'src/admin',
  build: {
    outDir: '../../public/admin',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/admin/index.html')
    }
  }
});