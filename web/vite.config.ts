import { defineConfig } from 'vite';
export default defineConfig({
  // The same built pages can be served at the root or a configured static mount.
  base: './',
  server: { proxy: { '/ws': { target: 'http://127.0.0.1:9728', ws: true } } },
  build: { outDir: 'dist', rollupOptions: { input: { main: 'index.html', embed: 'embed.html' } } },
});
