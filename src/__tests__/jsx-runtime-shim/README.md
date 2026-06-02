# jsx-runtime-shim (v0.3.2/v0.3.3 regression guards)

## 背景

`src/sdk/jsx-runtime.ts` 是 vite alias 的 `react/jsx-runtime`，Continuo plugin sandbox 不解 bare `react` import，所以 forward 到 `globalThis.co.React`。

GUI verify topic-39 暴露 2 个 latent bug：

### v0.3.2 fix: Fragment must be a Symbol sentinel, not Proxy

旧代码 `Fragment = new Proxy({}, getter)`：React 用 `type === REACT_FRAGMENT_TYPE` reference equality 识别 Fragment，Proxy 永远不等 → React 报 "Element type is invalid: got: object" → 黑屏。

修：Symbol sentinel exported as Fragment + jsx() 内 resolve 到 host React.Fragment (lazy — module load 时 co.React 可能未 ready)。

### v0.3.3 fix: spread children as positional args

旧代码 `createElement(type, { ...props, key })` 把 children 留在 `props.children` 数组 → React 当 runtime array → 多 component "missing key" warnings 飘满 console。

修：spread `props.children` (when array) 作 positional args to `createElement(type, rest, ...children)` — React 信 createElement-form 为 compile-time-known，不警告。

## 行为契约 (T1-T4)

- T1: jsx(Fragment, {children:[a,b]}) → createElement(realFragment, null, a, b)
- T2: jsx('div', {className:'x', children:[a,b]}) → createElement('div', {className:'x'}, a, b) (children 不留 props)
- T3: jsx('div', {className:'x', children:single}) → createElement('div', {className:'x'}, single)
- T4: jsx(Fragment, {children:...}, 'mykey') → key 进 props，Fragment resolve 到 host
