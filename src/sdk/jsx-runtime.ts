// jsx-runtime shim: alias 'react/jsx-runtime' → 本 shim。
// vite-plugin-react 默认 automatic runtime 会注入 `import { jsx, jsxs, Fragment } from 'react/jsx-runtime'`。
// Continuo plugin sandbox 不解 bare import，所以全部 forward 到 globalThis.co.React。
// **Lazy** — module load 时不 throw，调用时才 resolve（spec top-level import 不爆）。

function getR(): any {
  const co = (globalThis as { co?: { React: any } }).co;
  if (!co?.React) {
    throw new Error(
      '[jsx-runtime-shim] globalThis.co.React not initialized — ensure host set co.React before plugin runtime',
    );
  }
  return co.React;
}

// react/jsx-runtime 真正的 jsx(type, props, key) 签名：
// children 在 props.children；这里直接 createElement 也接受 props.children。
export function jsx(type: any, props: any, key?: any): any {
  if (key !== undefined) {
    return getR().createElement(type, { ...props, key });
  }
  return getR().createElement(type, props);
}

export const jsxs = jsx; // 18 的 jsxs（static children 优化）签名同 jsx
export const jsxDEV = jsx; // dev runtime 别名

// Fragment 是个对象/symbol — proxy 让它延迟到访问时
export const Fragment = new Proxy({}, { get: (_, p) => getR().Fragment?.[p as any] });
