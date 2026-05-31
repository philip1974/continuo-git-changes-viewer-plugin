import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const external = ['react', 'react-dom', '@codemirror/state', '@codemirror/view'];

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: 'src/main.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      external,
      output: {
        entryFileNames: 'index.js',
      },
      onwarn(warning, warn) {
        const source = String((warning as { source?: unknown }).source ?? '');
        if (
          warning.code === 'UNRESOLVED_IMPORT' &&
          !external.includes(source)
        ) {
          throw new Error(`Unexpected external import: ${source}`);
        }
        warn(warning);
      },
    },
  },
});
