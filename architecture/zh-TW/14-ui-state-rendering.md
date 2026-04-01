# 14 — UI 與狀態管理：在終端中構建瀏覽器

> **範圍**: `src/ink/`（49 個文件，~600KB）、`src/state/`（3 個文件，~5KB）、`src/screens/REPL.tsx`（874KB）、`src/components/`（~200 個文件）
>
> **一句話概括**: Claude Code 搭載了一個 fork 並重寫的 Ink 框架 —— React 19 併發渲染、Yoga flexbox 佈局引擎、Int32Array 位打包雙緩衝屏幕、W3C 事件分發模型，全部在終端中以 60fps 渲染。

---

## 1. 終端 UI 技術棧層次

```
第5層: React 組件              ← REPL.tsx (874K), PromptInput, StatusLine
第4層: React 19 Reconciler     ← reconciler.ts — ConcurrentRoot，非 LegacyRoot
第3層: 自定義 DOM (ink-box)    ← dom.ts — 帶事件處理器的虛擬 DOM 節點
第2層: Yoga 佈局引擎           ← Facebook 的 Flexbox-in-C，編譯為 WASM
第1層: 屏幕緩衝區 (Int32)     ← screen.ts — 位打包 typed array，零 GC
第0層: ANSI 差分 → stdout      ← log-update.ts — 僅寫入變化的單元格
```

**源碼座標**: `src/ink/reconciler.ts:224` — `createReconciler()` 配置了 React 19 的 fiber 架構，包含 `maySuspendCommit()`、`preloadInstance()` 等 React 19 必需方法。

---

## 2. 為什麼 Fork Ink

| 原版限制 | Claude Code 需求 | 解決方案 |
|---------|-----------------|---------|
| LegacyRoot 渲染器 | 併發特性、Suspense | React 19 ConcurrentRoot |
| 無事件系統 | 快捷鍵、焦點管理 | W3C 捕獲/冒泡事件分發 |
| 全屏重繪 | 大量輸出下的 60fps | Int32Array 雙緩衝 + ANSI 差分 |
| 無備用屏幕 | 疊加層對話框、搜索 | Alt-screen 管理 |
| 無虛擬滾動 | 10 萬+ 行對話歷史 | WeakMap 高度緩存 + 窗口化渲染 |
| 無文本選擇 | 終端中的複製粘貼 | 選擇系統 + NoSelect 區域 |
| 無搜索功能 | 對話內查找 | 搜索高亮疊加層（SGR 堆疊） |

---

## 3. 渲染管線

每次按鍵或狀態變化觸發以下管線：

```
stdin 字節流
  → parse-keypress.ts (23K) — 原始字節序列解析為 KeyPress 事件
  → Dispatcher.dispatch() — W3C 捕獲/冒泡，穿過 DOM 樹
  → React setState / useSyncExternalStore
  → React 協調（fiber 樹差分）
  → Yoga 佈局計算（flexbox → 絕對位置）
  → render-node-to-output.ts (63K) — DOM 樹 → Screen 緩衝區
  → screen.ts diff() — 前後緩衝區對比（Int32 整數比較）
  → log-update.ts (27K) — 僅輸出變化單元格的 ANSI 序列
  → stdout.write()
```

幀調度以 16ms 節流（~60fps 目標），避免每次狀態變化都觸發渲染。

---

## 4. 屏幕緩衝區：零 GC 的位打包數組

// 源碼位置: src/ink/screen.ts（1,487 行，49KB）

這是整個 UI 系統中性能最關鍵的代碼。每個單元格用 2 個 Int32 連續存儲，而非分配 Cell 對象（200×120 屏幕將避免分配 24,000 個對象）：

```typescript
// word0: charId（32 位 — CharPool 索引）
// word1: styleId[31:17] | hyperlinkId[16:2] | width[1:0]
```

### CharPool 與 StylePool：字符串駐留

字符串通過 `CharPool` 駐留為整數 ID，ASCII 快速路徑直接數組查找（無需 Map.get）。樣式轉換在單元格間被緩存 —— `StylePool.transition(fromId, toId)` 返回預序列化的 ANSI 轉義字符串，首次調用後零分配。

### 雙緩衝

`cells64` BigInt64Array 視圖共享同一 ArrayBuffer，實現單次 `fill()` 調用清零整個屏幕。緩衝區只增長不縮小，避免重複分配。

---

## 5. 事件系統：終端中的 W3C

// 源碼位置: src/ink/events/dispatcher.ts

Claude Code 在終端內實現了 **W3C 捕獲/冒泡事件模型** —— 與瀏覽器相同的事件傳播模型：

```
捕獲階段: root → target（自頂向下）
目標階段: 目標節點上的事件處理器
冒泡階段: target → root（自底向上）
```

`Dispatcher` 與 React 19 的更新優先級系統集成：離散事件（按鍵、點擊）獲得更高優先級，連續事件（滾動）獲得較低優先級。

### FocusManager

焦點以**棧**方式管理 —— 每個可聚焦組件向 `FocusManager` 註冊，追蹤焦點鏈。

---

## 6. 35 行 Store（替代 Redux）

// 源碼位置: src/state/store.ts — 恰好 35 行

可能是整個代碼庫中最優雅的代碼：

```typescript
export function createStore<T>(initialState: T, onChange?: OnChange<T>): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()
  return {
    getState: () => state,
    setState: (updater) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return   // 引用相等跳過
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

`Store` 接口 `{ getState, setState, subscribe }` 恰好是 React 18+ 的 `useSyncExternalStore` 所期望的格式。無中間件、無 reducer、無 action。`onChangeAppState` 集中處理所有副作用。

---

## 7. REPL 屏幕架構

// 源碼位置: src/screens/REPL.tsx — 874KB

```
<FullscreenProvider>             ← 終端尺寸跟蹤
  <AlternateScreen>              ← 模態疊加層的備用屏幕
    <FullscreenLayout>           ← Flexbox 根（全終端）
      <ScrollBox>                ← 可滾動容器
        <VirtualMessageList>     ← 窗口化渲染（視口 ± 1 屏）
      <PromptInput>              ← 文本輸入（支持 vim 模式）
      <StatusLine>               ← 底部狀態欄
      <OverlayStack>             ← 權限對話框、模型選擇器、搜索
```

對話框作為疊加層渲染在 alt-screen 上，保留對話上下文。

---

## 8. 虛擬滾動與高度緩存

對於包含數千條消息的對話，只渲染可見消息加上緩衝區：

```
可見視口: messages[startIdx..endIdx]
緩衝區: 視口上下各 ±1 屏高度
其他: <Spacer height={cachedHeight} />
```

高度緩存使用 `WeakMap`，消息從對話中移除時條目自動垃圾回收。

搜索（`Ctrl+F`）時，當前匹配通過 `StylePool.withCurrentMatch()` 應用黃底 + 粗體 + 下劃線 SGR 疊加層；其他匹配用 `withInverse()` —— 視覺上有區分但不那麼突出。

---

## 9. Vim 模式

// 源碼位置: src/hooks/useVimInput.ts

簡化的兩態模型：

```typescript
export type VimMode = 'INSERT' | 'NORMAL'
```

`NORMAL` 模式下按鍵被攔截用於導航（hjkl、w、b、0、$等）和編輯命令（dd、yy、p等）。模式狀態從 `REPL.tsx` 流經 `PromptInput`、`StatusLine`、`useCancelRequest`。

---

## 10. 鍵綁定系統

| 上下文 | 激活時機 | 示例綁定 |
|--------|---------|---------|
| **全局** | 始終 | `Ctrl+C`（取消）、`Ctrl+D`（退出） |
| **聊天** | 對話中 | `Shift+Tab`（模式切換）、`Enter`（提交） |
| **權限** | 權限對話框打開時 | `y/n`（允許/拒絕） |
| **搜索** | 搜索激活時 | `Ctrl+G`（下一個匹配）、`Escape`（關閉） |

用戶可通過 `~/.claude/keybindings.json` 自定義覆蓋默認綁定。

---

## 可遷移設計模式

### 模式 1："35 行替代一個庫"

當用例足夠具體時，35 行定製方案勝過 50KB 依賴。關鍵是 `useSyncExternalStore` 已做完重活 —— 你只需匹配它期望的 API 形狀。

### 模式 2：位打包 Typed Array 消除 GC

Screen 用 `Int32Array` + 位打包替代對象。`BigInt64Array` 視圖實現批量清零。這種模式可遷移到任何高吞吐數據結構。

### 模式 3：非瀏覽器環境中的瀏覽器事件模型

W3C 捕獲/冒泡事件分發在瀏覽器外同樣優雅。關鍵適配：將終端特有事件映射到 React 組件期望的事件傳播模型。

---

## 組件總結

| 組件 | 大小 | 角色 |
|------|------|------|
| `ink.tsx` | 252KB | 核心渲染引擎、React 集成、幀調度 |
| `screen.ts` | 49KB | 位打包 Int32Array 屏幕緩衝區、雙緩衝、單元格差分 |
| `render-node-to-output.ts` | 63KB | DOM 樹 → Screen 緩衝區轉換 |
| `selection.ts` | 35KB | 文本選擇 + NoSelect 區域 |
| `log-update.ts` | 27KB | ANSI 差分輸出 —— 僅發送變化單元格 |
| `parse-keypress.ts` | 23KB | 原始 stdin → KeyPress 事件解析 |
| `reconciler.ts` | 15KB | React 19 ConcurrentRoot fiber 調和器 |
| `store.ts` | **836B** | 完整狀態管理 —— 35 行 |
| `REPL.tsx` | 874KB | 主屏幕：虛擬滾動、疊加層、vim 模式 |

---

**上一篇**: [← 13 — 橋接系統](13-bridge-system.md)
**下一篇**: [→ 15 — 服務層與 API 架構](15-services-api-layer.md)
