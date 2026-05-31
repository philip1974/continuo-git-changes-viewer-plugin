# diffview-scroll-fix (v0.1.8 hot-fix)

## 背景

v0.1.7 GUI verify 用户发现长 diff 不能滚动看全文 (e.g. README.md 77 行只能看 50 行)。

## Root cause

`src/styles/index.css` `.cgv-panel` 用 `min-height: 100%` 不是 `height: 100%`。

在 grid 上下文中：
- `min-height: 100%` → panel 至少 100% 父高，可 grow past parent
- 当 diff 内容高 → cgv-body 撑高 → panel 撑高超过 dockview 父容器
- dockview 父容器 overflow:hidden → 截断底部
- 内部 cgv-diff 的 overflow:auto 失效 (scrollable 在外层不在 cgv-diff)

## Fix

`min-height: 100%` → `height: 100%`：panel 锁定父高，middle row `minmax(0, 1fr)` 限制 body 占余空，子级 cgv-diff 的 overflow:auto 成为真 scroll surface。

## 行为契约

- Spec 1 (T1): src/styles/index.css `.cgv-panel` rule 必含 `height: 100%`
- Spec 2 (T2): src/styles/index.css `.cgv-panel` rule **不**含 `min-height: 100%`（regression guard — 不让任何人改回去）
