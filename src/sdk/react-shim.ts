// react-shim: alias 'react' → 本 shim，避免 sandbox 解 bare import 失败。
// Continuo 主仓 src/main.tsx:42-54 把整个 React module 挂在 globalThis.co.React，
// 所以 useSyncExternalStore / useMemo / useCallback / Fragment 等 React 18 API
// 全部可达。本 shim **lazy proxy** — 不在模块 load 时 throw，访问时才 resolve
// （让 spec top-level `import React from 'react'` 不爆，spec setup 后 React 才用得上）。

type ReactNS = Record<string | symbol, any>;

function getR(): ReactNS {
  const co = (globalThis as { co?: { React: ReactNS } }).co;
  if (!co?.React) {
    throw new Error(
      '[react-shim] globalThis.co.React not initialized — ensure host set co.React before plugin runtime',
    );
  }
  return co.React;
}

// 默认 export = Proxy，转发任意属性到 globalThis.co.React
const defaultExport: ReactNS = new Proxy(
  {},
  {
    get(_target, prop) {
      return getR()[prop];
    },
  },
);

export default defaultExport;

// Named exports — wrapped functions / getters that resolve at call time.
// 仅 export plugin runtime 实际用得到的 React API；其他通过 default proxy 取。
export const createElement = (...args: any[]) => getR().createElement(...args);
export const Fragment = new Proxy({}, { get: (_, p) => getR().Fragment?.[p as any] });
export const useState = (...args: any[]) => getR().useState(...args);
export const useEffect = (...args: any[]) => getR().useEffect(...args);
export const useRef = (...args: any[]) => getR().useRef(...args);
export const useMemo = (...args: any[]) => getR().useMemo(...args);
export const useCallback = (...args: any[]) => getR().useCallback(...args);
export const useLayoutEffect = (...args: any[]) => getR().useLayoutEffect(...args);
export const useSyncExternalStore = (...args: any[]) => getR().useSyncExternalStore(...args);
export const useContext = (...args: any[]) => getR().useContext(...args);
export const useReducer = (...args: any[]) => getR().useReducer(...args);
export const useId = (...args: any[]) => getR().useId(...args);
export const useTransition = (...args: any[]) => getR().useTransition(...args);
export const useDeferredValue = (...args: any[]) => getR().useDeferredValue(...args);
export const useInsertionEffect = (...args: any[]) => getR().useInsertionEffect(...args);
export const useImperativeHandle = (...args: any[]) => getR().useImperativeHandle(...args);
export const useDebugValue = (...args: any[]) => getR().useDebugValue(...args);
export const memo = (...args: any[]) => getR().memo(...args);
export const forwardRef = (...args: any[]) => getR().forwardRef(...args);
export const createContext = (...args: any[]) => getR().createContext(...args);
export const cloneElement = (...args: any[]) => getR().cloneElement(...args);
export const isValidElement = (v: any) => getR().isValidElement(v);
export const startTransition = (...args: any[]) => getR().startTransition(...args);
