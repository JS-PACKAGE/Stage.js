import { defineConfig } from 'vite';
export default defineConfig({
  server: { proxy: { '/ws': { target: 'http://127.0.0.1:9728', ws: true } } },
  build: { outDir: 'dist', rollupOptions: { input: { main: 'index.html', embed: 'embed.html' } } },
});
