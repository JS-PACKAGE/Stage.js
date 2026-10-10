import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    // `stage-element` imports the `stage-client` entry, so pages using both load the client once.
    lib: { entry: { 'stage-client': 'src/index.ts', 'stage-element': 'src/stage-element.ts' }, formats: ['es'], fileName: (_format, name) => `${name}.js` },
    rolldownOptions: { preserveEntrySignatures: 'allow-extension' },
    outDir: 'dist', emptyOutDir: true,
  },
});
