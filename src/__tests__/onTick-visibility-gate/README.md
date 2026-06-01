# onTick-visibility-gate (v0.2.2 simplified)

## 背景

topic-36 plan-v2 原方案：`WindowActivityWatcher` subscribe `visibilitychange + focus + blur` events，combined gate `panelVisible AND isWindowActive`。

**实测 FAIL**：Electron 38 macOS Cmd+M Dock-restore 不 fire `focus` event consistently（需 user click 才转 focus）；100ms delay recheck 也不行；事件驱动 state 也不行。

## 当前方案 (v0.2.2)

放弃事件订阅，**timer onTick 内直接读 `document.visibilityState` always-fresh property**：

```ts
onTick: async () => {
  if (document.visibilityState !== 'visible') return;
  // ... git status + refresh
}
```

**Trade-off**:
- ✅ Cmd+M minimize/restore: 立刻恢复（visibility 是 always-fresh property，下个 tick 即生效）
- ✅ Cmd+H app hide: 同上 (visibility hidden)
- ✅ window minimize to dock: 同上
- ⚠️ Cmd+Tab focus loss with window visible: polling 继续（small CPU waste — 但 git status skip 重复 hash 时无 refresh）

Cmd+Tab 不是核心 use case，放弃严格 focus 跟踪换可靠性。

## 行为契约 (T1-T2)

- T1: `document.visibilityState === 'visible'` + tick → readStatusHash 调用
- T2: `document.visibilityState === 'hidden'` + tick → readStatusHash **不**调用 (skip)
