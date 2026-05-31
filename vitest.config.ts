import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Test mode: 不应用 build vite.config.ts 的 react alias（shim 留给 plugin runtime build）。
// 测试里 'react' / 'react/jsx-runtime' 解析到真实 npm package，让 @testing-library/react +
// JSX 转换工作正常。impl src 也透明用真 React（API 同 shim 转发到的 globalThis.co.React）。

export default defineConfig({
  plugins: [react()],
  // 显式不继承 vite.config.ts 的 resolve.alias
  resolve: {
    alias: [],
  },
  test: {
    environment: 'node', // 默认 node；spec 顶 `// @vitest-environment jsdom` 单独覆盖
    include: ['src/**/*.spec.{ts,tsx}'],
  },
});
