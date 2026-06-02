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

// react/jsx-runtime: jsx(type, props, key). Children live on props.children.
// v0.3.3 hot-fix: forward children as positional args to createElement.
// Passing them via props.children makes React think `props.children`
// is a runtime array and emits "Each child in a list should have a
// unique 'key' prop" warnings for every static JSX sibling pair.
// createElement(type, props, ...children) is the legacy form React
// trusts as compile-time-known and never warns about.
export function jsx(type: any, props: any, key?: any): any {
  const resolved = resolveType(type);
  const R = getR();
  const finalProps = key !== undefined ? { ...props, key } : props;
  if (finalProps && 'children' in finalProps) {
    const { children, ...rest } = finalProps;
    if (Array.isArray(children)) {
      return R.createElement(resolved, rest, ...children);
    }
    return R.createElement(resolved, rest, children);
  }
  return R.createElement(resolved, finalProps);
}

export const jsxs = jsx; // 18 的 jsxs（static children 优化）签名同 jsx
export const jsxDEV = jsx; // dev runtime 别名

// Fragment 是 sentinel — jsx() 内 resolve 到 host React.Fragment
export const Fragment = FRAGMENT_SENTINEL;
