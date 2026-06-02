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

// v0.3.2 hot-fix (GUI verify): Fragment was a Proxy({}) so React saw `object`
// instead of REACT_FRAGMENT_TYPE and threw "Element type is invalid: got:
// object" when any plugin component used <>…</> (e.g. PreviewDrawer.tsx).
// React identifies Fragment by reference equality, so the shim must hand
// off the host's real React.Fragment at jsx() call time.
const FRAGMENT_SENTINEL: unique symbol = Symbol.for('git-viewer.fragment.shim');

function resolveType(type: any): any {
  if (type === FRAGMENT_SENTINEL) return getR().Fragment;
  return type;
}

// react/jsx-runtime 真正的 jsx(type, props, key) 签名：
// children 在 props.children；这里直接 createElement 也接受 props.children。
export function jsx(type: any, props: any, key?: any): any {
  const resolved = resolveType(type);
  if (key !== undefined) {
    return getR().createElement(resolved, { ...props, key });
  }
  return getR().createElement(resolved, props);
}

export const jsxs = jsx; // 18 的 jsxs（static children 优化）签名同 jsx
export const jsxDEV = jsx; // dev runtime 别名

// Fragment 是 sentinel — jsx() 内 resolve 到 host React.Fragment
export const Fragment = FRAGMENT_SENTINEL;
