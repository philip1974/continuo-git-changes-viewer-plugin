import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// v0.1 hotfix: Continuo plugin sandbox 不解 bare import (e.g. `import 'react'`).
// react / react/jsx-runtime alias 到本地 shim，shim 透传 globalThis.co.React。
// CodeMirror（state / view / merge）host 不 expose → bundle 进 plugin。
// 详 verify.md "Soft regressions" 段（topic-28 GUI verified 阶段定位）。

const external: string[] = [];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // 顺序敏感：长 path 在前，避免 'react' prefix 吞 'react/jsx-runtime'。
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: path.resolve(__dirname, 'src/sdk/jsx-runtime.ts'),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: path.resolve(__dirname, 'src/sdk/jsx-runtime.ts'),
      },
      {
        find: /^react$/,
        replacement: path.resolve(__dirname, 'src/sdk/react-shim.ts'),
      },
    ],
  },
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
