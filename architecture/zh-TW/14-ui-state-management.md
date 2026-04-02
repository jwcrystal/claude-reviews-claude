# 第 14 集：UI 與狀態管理 —— 終端裡的瀏覽器

> **源碼文件**：`ink/` 目錄 — 48 個文件，約 620KB。核心：`ink.tsx` (252KB)、`reconciler.ts` (14.6KB)、`renderer.ts` (7.7KB)、`dom.ts` (15.1KB)、`screen.ts` (49.3KB)、`events/dispatcher.ts` (6KB)、`focus.ts` (5.1KB)。狀態管理：`state/store.ts` (836 字節)、`state/AppStateStore.ts` (21.8KB)、`state/AppState.tsx` (23.5KB)、`state/onChangeAppState.ts` (6.2KB)。屏幕：`screens/REPL.tsx` (874KB)、`screens/Doctor.tsx` (71KB)
>
> **一句話概括**：Claude Code 運行著一個完全 Fork 的 Ink 渲染引擎 —— React 19 + ConcurrentRoot、W3C 風格的捕獲/冒泡事件系統、Yoga Flexbox 佈局、以打包 Int32Array 實現的雙緩衝屏幕、和一個僅 35 行的 Zustand 替代品 —— 全部運行在你的終端裡。

---

## 1. 終端 UI 技術棧

大多數 CLI 工具逐行打印文本。Claude Code 在終端中構建了一整套基於組件的 UI 框架 —— 其技術棧深度令人驚訝：

```
┌─────────────────────────────────────────────────────────────┐
│  React 19 (通過 react-reconciler 實現 ConcurrentRoot)       │
│    └─ 自定義 Ink Reconciler (reconciler.ts, 513 行)         │
│        └─ 虛擬 DOM (dom.ts — ink-root/box/text/link/...)    │
│            └─ Yoga 佈局引擎 (終端中的 Flexbox)              │
│                └─ 屏幕緩衝 (screen.ts — 打包 Int32 數組)    │
│                    └─ ANSI Diff (log-update.ts → stdout)    │
└─────────────────────────────────────────────────────────────┘
```

### 核心文件索引

| 層級 | 文件 | 大小 | 職責 |
|------|------|------|------|
| 入口 | `ink/root.ts` | 4.6KB | 創建 Ink 實例，掛載 React 樹 |
| 協調器 | `ink/reconciler.ts` | 14.6KB | React 19 宿主配置，提交鉤子 |
| 渲染器 | `ink/renderer.ts` | 7.7KB | Yoga 佈局 → 屏幕緩衝 |
| DOM | `ink/dom.ts` | 15.1KB | 虛擬 DOM 節點，髒標記 |
| 屏幕 | `ink/screen.ts` | 49.3KB | 打包 Int32Array 單元格緩衝 |
| 核心 | `ink/ink.tsx` | 252KB | 幀調度，輸入處理，選區 |
| 事件 | `ink/events/dispatcher.ts` | 6KB | W3C 捕獲/冒泡派發 |
| 焦點 | `ink/focus.ts` | 5.1KB | FocusManager + 棧式恢復 |
| 輸出 | `ink/log-update.ts` | 27.2KB | ANSI 差分，光標管理 |

### 完整渲染管線

```
stdin 原始字節
  → parse-keypress.ts：解碼為 ParsedKey（xterm/VT 序列）
  → 創建 InputEvent
  → Dispatcher.dispatchDiscrete()：W3C 捕獲 → 目標 → 冒泡
  → React 狀態更新 → Reconciler 提交階段
  → resetAfterCommit() → rootNode.onComputeLayout() [Yoga]
  → rootNode.onRender() → renderer.ts 生成 Screen 緩衝
  → log-update.ts：對比前後 Screen → ANSI 轉義序列
  → process.stdout.write()
```

每次按鍵都走完這條完整管線。在 16ms 幀節流下，Claude Code 在終端中維持 60fps 等效渲染。

---

## 2. 為什麼要 Fork Ink

Claude Code 並不使用 npm 上的 `ink` 包，而是維護了一個完整的 Fork 版本，至少包含七項重大修改。理解其原因，就能看到這個項目的工程野心。

### 修改清單

| 變更 | 原版 Ink | Fork 版 Ink | 原因 |
|------|---------|------------|------|
| React 版本 | LegacyRoot | **ConcurrentRoot (React 19)** | 併發特性、`useSyncExternalStore`、過渡 |
| 事件系統 | 基礎 `useInput` | **W3C 捕獲/冒泡派發器** | 複雜的重疊焦點上下文 |
| 屏幕模式 | 普通滾動緩衝 | **備用屏幕 + 鼠標追蹤** | 全屏 TUI，不汙染滾動歷史 |
| 渲染 | 單緩衝 | **雙緩衝 + 打包 Int32 屏幕** | 零閃爍渲染，CJK/emoji 支持 |
| 文本選擇 | 無 | **鼠標拖拽選擇 + 剪貼板** | 從終端輸出中複製代碼 |
| 滾動 | 全量重渲染 | **虛擬滾動 + 高度緩存** | 1000+ 條消息無性能懸崖 |
| 搜索 | 無 | **全屏搜索 + 逐單元格高亮** | 在整個對話中查找文本 |

### React 19 Reconciler：React 與終端之間的橋樑

```typescript
// 源碼：ink/reconciler.ts:224-506
const reconciler = createReconciler<
  ElementNames,  // 'ink-root' | 'ink-box' | 'ink-text' | ...
  Props,
  DOMElement,    // 虛擬 DOM 節點
  DOMElement,    // 容器類型
  TextNode,      // 文本節點類型
  DOMElement,    // Suspense 邊界
  unknown, unknown, DOMElement,
  HostContext,
  null,          // UpdatePayload — React 19 中不再使用
  NodeJS.Timeout,
  -1, null
>({
  // React 19 commitUpdate — 直接接收新舊 props
  //（React 18 使用 updatePayload）
  commitUpdate(node, _type, oldProps, newProps) {
    const props = diff(oldProps, newProps)
    const style = diff(oldProps['style'], newProps['style'])
    // 增量更新：只處理變更的屬性和樣式
  },

  // 關鍵鉤子：每次 React 提交後，重新計算佈局 + 渲染
  resetAfterCommit(rootNode) {
    rootNode.onComputeLayout?.()  // Yoga flexbox 計算
    rootNode.onRender?.()         // 繪製到屏幕緩衝 → stdout
  },
})
```

`UpdatePayload` 泛型為 `null` —— 這是 React 19 的標誌。React 18 中協調器在 `prepareUpdate()` 中預計算差分載荷，然後傳給 `commitUpdate()`。React 19 消除了這個中間步驟，直接傳遞新舊 props。這是 Claude Code 構建在前沿 React 內部實現之上的最明確信號之一。

---

## 3. 渲染管線深度剖析

### DOM 節點結構

每個 UI 元素都會成為虛擬樹中的 `DOMElement` 節點：

```typescript
// 源碼：ink/dom.ts:31-91
type DOMElement = {
  nodeName: ElementNames           // 'ink-root' | 'ink-box' | 'ink-text' | ...
  attributes: Record<string, DOMNodeAttribute>
  childNodes: DOMNode[]
  parentNode: DOMElement | undefined
  yogaNode?: LayoutNode            // Yoga flexbox 佈局節點
  style: Styles                    // Flexbox 屬性
  dirty: boolean                   // 需要重渲染

  // 事件處理器 —— 與屬性分開存儲，
  // 使處理器引用變化不會標記髒，避免破壞 blit 優化
  _eventHandlers?: Record<string, unknown>

  // overflow: 'scroll' 容器的滾動狀態
  scrollTop?: number
  pendingScrollDelta?: number      // 累積增量，逐幀消耗
  scrollClampMin?: number          // 虛擬滾動鉗制邊界
  scrollClampMax?: number
  stickyScroll?: boolean           // 自動釘底
  scrollAnchor?: { el: DOMElement; offset: number }  // 延遲位置讀取
  focusManager?: FocusManager      // 焦點管理（僅根節點）
}
```

七種元素類型映射了終端 UI 詞彙：

| 類型 | 用途 | 有 Yoga 節點？ |
|------|------|---------------|
| `ink-root` | 樹根 | ✅ |
| `ink-box` | Flexbox 容器 (`<Box>`) | ✅ |
| `ink-text` | 文本內容 (`<Text>`) | ✅（帶測量函數）|
| `ink-virtual-text` | `<Text>` 內嵌套文本 | ❌ |
| `ink-link` | 終端超鏈接 (OSC 8) | ❌ |
| `ink-progress` | 進度條 | ❌ |
| `ink-raw-ansi` | 預渲染 ANSI 透傳 | ✅（固定尺寸）|

### 屏幕緩衝：打包 Int32Array

這裡是 Claude Code 在性能方面*真正認真*的地方。與其為每個單元格分配對象（200×120 屏幕意味著 24,000 個對象），屏幕將單元格存儲為打包整數：

```typescript
// 源碼：ink/screen.ts:332-348
// 每個單元格 = 2 個連續 Int32 元素：
//   word0 (cells[ci]):     charId（完整 32 位，CharPool 的索引）
//   word1 (cells[ci + 1]): styleId[31:17] | hyperlinkId[16:2] | width[1:0]

const STYLE_SHIFT = 17
const HYPERLINK_SHIFT = 2
const WIDTH_MASK = 3           // 2 位（窄/寬/SpacerTail/SpacerHead）

function packWord1(styleId: number, hyperlinkId: number, width: number): number {
  return (styleId << STYLE_SHIFT) | (hyperlinkId << HYPERLINK_SHIFT) | width
}
```

同一 ArrayBuffer 上的 `cells64` BigInt64Array 視圖支持 8 字節批量填充 `cells64.fill(0n)` —— 一次操作清空整個屏幕，而非逐單元格迭代。

**字符串駐留**進一步降低內存壓力：

```typescript
// 源碼：ink/screen.ts:21-53
class CharPool {
  private ascii: Int32Array = initCharAscii()  // ASCII 快速路徑

  intern(char: string): number {
    if (char.length === 1) {
      const code = char.charCodeAt(0)
      if (code < 128) {
        const cached = this.ascii[code]!
        if (cached !== -1) return cached  // 直接數組查找，無 Map.get
      }
    }
    // 非 ASCII（CJK、emoji）回退到 Map
    return this.stringMap.get(char) ?? this.addNew(char)
  }
}
```

### 雙緩衝

渲染器維護兩個 `Frame` 對象 —— `frontFrame` 和 `backFrame`。每次渲染：

1. 重置**background緩衝**（通過 `resetScreen()` —— 一次 `cells64.fill(0n)` 調用）
2. 將 DOM 樹渲染到background緩衝
3. 與**foreground緩衝**對比生成最小 ANSI 輸出
4. 交換：background變foreground供下幀使用

`prevFrameContaminated` 標誌追蹤foreground緩衝在渲染後被修改的情況（如選區疊加）。被汙染時，渲染器跳過 blit 優化執行全量重繪 —— 但只限那一幀。

---

## 4. 事件系統：終端中的 W3C

也許是最令人意外的工程決策：Claude Code 在終端事件上實現了完整的 W3C 風格事件派發系統。這不是學術潔癖 —— 當你有重疊對話框、嵌套滾動容器、以及需要在不同樹深度攔截按鍵的 Vim 模式時，這是實際需求。

### 事件派發階段

```typescript
// 源碼：ink/events/dispatcher.ts:46-78
function collectListeners(target, event): DispatchListener[] {
  const listeners: DispatchListener[] = []
  let node = target
  while (node) {
    const isTarget = node === target
    // 捕獲處理器：unshift → 根優先順序
    const captureHandler = getHandler(node, event.type, true)
    if (captureHandler) {
      listeners.unshift({ node, handler: captureHandler,
        phase: isTarget ? 'at_target' : 'capturing' })
    }
    // 冒泡處理器：push → 目標優先順序
    const bubbleHandler = getHandler(node, event.type, false)
    if (bubbleHandler && (event.bubbles || isTarget)) {
      listeners.push({ node, handler: bubbleHandler,
        phase: isTarget ? 'at_target' : 'bubbling' })
    }
    node = node.parentNode
  }
  return listeners
  // 結果：[根捕獲, ..., 父捕獲, 目標捕獲, 目標冒泡, 父冒泡, ..., 根冒泡]
}
```

### 事件優先級：鏡像 react-dom

```typescript
// 源碼：ink/events/dispatcher.ts:122-138
function getEventPriority(eventType: string): number {
  switch (eventType) {
    case 'keydown': case 'keyup': case 'click':
    case 'focus': case 'blur': case 'paste':
      return DiscreteEventPriority     // 同步刷新
    case 'resize': case 'scroll': case 'mousemove':
      return ContinuousEventPriority   // 可批處理
    default:
      return DefaultEventPriority
  }
}
```

這直接映射到 React 的調度器優先級。按鍵觸發同步 React 更新（離散優先級），而滾動事件會被批處理（連續優先級）。

### 焦點管理：棧式恢復

```typescript
// 源碼：ink/focus.ts:15-82
class FocusManager {
  activeElement: DOMElement | null = null
  private focusStack: DOMElement[] = []  // 最多 32 條目

  focus(node) {
    if (node === this.activeElement) return
    const previous = this.activeElement
    if (previous) {
      // 推入前去重（防止 Tab 循環導致無界增長）
      const idx = this.focusStack.indexOf(previous)
      if (idx !== -1) this.focusStack.splice(idx, 1)
      this.focusStack.push(previous)
      if (this.focusStack.length > MAX_FOCUS_STACK) this.focusStack.shift()
    }
    this.activeElement = node
  }

  // 對話框關閉時，焦點自動返回前一個元素
  handleNodeRemoved(node, root) {
    this.focusStack = this.focusStack.filter(n => n !== node && isInTree(n, root))
    // 從棧中恢復最近一個仍掛載的元素
    while (this.focusStack.length > 0) {
      const candidate = this.focusStack.pop()!
      if (isInTree(candidate, root)) {
        this.activeElement = candidate
        return
      }
    }
  }
}
```

焦點棧硬限制 32 條目（`MAX_FOCUS_STACK`）。Tab 循環在推入前去重，防止棧隨反覆導航而增長。當對話框從樹中移除時，協調器調用 `handleNodeRemoved()`，反向遍歷棧找到最近仍掛載的元素 —— 無需顯式銷燬邏輯即實現焦點自動恢復。

---

## 5. 35 行 Store（替代 Redux/Zustand）

這是那種讓你停下來思考的工程決策。Claude Code 並未引入狀態管理庫，而是僅用 35 行代碼實現了整個應用狀態管理：

```typescript
// 源碼：state/store.ts —— 完整文件（35 行）
export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,
    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return   // 引用相等跳過
      state = next
      onChange?.({ newState: next, oldState: prev })  // 副作用鉤子
      for (const listener of listeners) listener()    // 通知訂閱者
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

沒有中間件鏈、沒有 devtools 集成、沒有 action 類型、沒有 reducer。就是 `getState`、`setState`（帶更新函數）和 `subscribe`。`Object.is` 檢查防止無效重渲染。`onChange` 回調集中管理副作用。

### 通過 useSyncExternalStore 集成 React

```typescript
// 源碼：state/AppState.tsx:142-163
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore()
  const get = () => selector(store.getState())
  return useSyncExternalStore(store.subscribe, get, get)
}

// 在組件中使用：
const verbose = useAppState(s => s.verbose)
const model = useAppState(s => s.mainLoopModel)
```

`useSyncExternalStore` 鉤子（React 18+）保證在併發渲染期間的撕裂安全讀取 —— 與 Zustand 內部使用的基元完全相同。Claude Code 只是不需要 Zustand 的包裝層。

### AppState：完整應用狀態類型

`AppStateStore.ts` 定義了 `AppState` 類型 —— **570 行**的類型定義覆蓋應用各個方面：

```typescript
// 源碼：state/AppStateStore.ts:89-452（精簡版）
export type AppState = DeepImmutable<{
  settings: SettingsJson           // 會話設置
  mainLoopModel: ModelSetting      // 主循環模型
  expandedView: 'none' | 'tasks' | 'teammates'  // UI 顯示狀態
  toolPermissionContext: ToolPermissionContext    // 權限系統
  remoteConnectionStatus: '...'    // 遠程/Bridge
  speculation: SpeculationState    // 推測執行
}> & {
  tasks: { [taskId: string]: TaskState }         // 可變狀態
  mcp: { clients, tools, commands, resources }   // MCP
  plugins: { enabled, disabled, commands }       // 插件
  teamContext?: { teamName, teammates, ... }     // 團隊
  computerUseMcpState?: { ... }                  // Computer Use
}
```

`DeepImmutable<>` 包裝器防止大多數字段的意外修改。包含 `Map`、`Set`、函數類型或任務狀態的字段通過交叉類型 (`&`) 排除在包裝器之外 —— 類型安全與表達力之間的務實折衷。

### 副作用集中化

所有狀態變更副作用通過單一 `onChangeAppState` 回調匯聚：

```typescript
// 源碼：state/onChangeAppState.ts:43-171
export function onChangeAppState({ newState, oldState }) {
  // 權限模式 → 同步到 CCR/SDK
  if (prevMode !== newMode) {
    notifySessionMetadataChanged({ permission_mode: newExternal })
  }
  // 模型變更 → 持久化到設置文件
  if (newState.mainLoopModel !== oldState.mainLoopModel) {
    updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
  }
  // 設置變更 → 清除認證緩存 + 重新應用環境變量
  if (newState.settings !== oldState.settings) {
    clearApiKeyHelperCache()
  }
}
```

這就是"單一咽喉"模式 —— 八條不同代碼路徑都可以更改權限模式，但全部流經這一個差分。在此集中化之前，每條路徑都需要手動通知 CCR，有幾條沒有做到 —— 導致 Web UI 與 CLI 狀態不同步。

---

## 6. REPL 屏幕架構

`screens/REPL.tsx` (874KB) 是應用的主界面 —— 一個編排所有用戶功能的 React 函數組件。編譯輸出約 12,000 行，是代碼庫中最大的單一組件。

### 組件層次

```
<REPL>
  <KeybindingSetup>                // 初始化鍵綁定系統
    <AlternateScreen>              // 進入終端備用屏幕模式
      <FullscreenLayout>           // 全屏佈局
        <ScrollBox stickyScroll>   // 可滾動主內容區
          <VirtualMessageList>     // 虛擬滾動
            <Messages>             // 消息渲染（遞歸）
          </VirtualMessageList>
        </ScrollBox>
        <StatusLine>               // 模型 │ 權限 │ 工作目錄 │ token │ 費用
        <PromptInput>              // 用戶輸入 + 自動補全 + 底欄按鈕
      </FullscreenLayout>
    </AlternateScreen>

    // 覆蓋層對話框
    <PermissionRequest>            // 工具權限確認
    <ModelPicker>                  // 模型選擇 (Meta+P)
    <GlobalSearchDialog>           // 全文搜索 (Ctrl+F)
    // ... 15+ 種覆蓋層對話框
  </KeybindingSetup>
</REPL>
```

### 三個屏幕組件

| 屏幕 | 文件 | 大小 | 用途 |
|------|------|------|------|
| REPL | `screens/REPL.tsx` | 874KB | 主交互循環 |
| Doctor | `screens/Doctor.tsx` | 71KB | 環境診斷 (`/doctor`) |
| ResumeConversation | `screens/ResumeConversation.tsx` | 58KB | 會話恢復 (`--resume`) |

### 查詢循環流程

```
用戶輸入 → handleSubmit()
  → 創建 UserMessage → addToHistory()
  → query({ messages, tools, onMessage, ... })
    → 流式回調：handleMessageFromStream()
      → setMessages(prev => [...prev, newMessage])
      → 工具調用 → useCanUseTool → 權限檢查
        → 允許 → 執行工具 → 追加結果
        → 拒絕 → 追加拒絕消息
    → 完成 → 記錄分析 → 保存會話
```

---

## 7. 虛擬滾動與高度緩存

當對話增長到數百條消息時，每幀渲染每條消息會摧毀性能。Claude Code 實現了終端虛擬滾動 —— 一種借鑑自瀏覽器虛擬列表庫（如 `react-window`）的技術。

### 核心策略

```
┌────────────────────────────────┐
│  Spacer（估計高度）            │  ← 不渲染，固定高度 Box
├────────────────────────────────┤
│  緩衝區（上方 1 屏高度）       │  ← 已渲染但不可見
├────────────────────────────────┤
│  ████████████████████████████  │
│  ████ 可見視口 ██████████████  │  ← 用戶實際可見
│  ████████████████████████████  │
├────────────────────────────────┤
│  緩衝區（下方 1 屏高度）       │  ← 已渲染但不可見
├────────────────────────────────┤
│  Spacer（估計高度）            │  ← 不渲染，固定高度 Box
└────────────────────────────────┘
```

### 關鍵設計決策

- **WeakMap 高度緩存**：每條消息的渲染高度通過 WeakMap 緩存，鍵為消息對象引用。消息引用不變時直接複用高度無需重新測量。

- **窗口 = 視口 + 1 屏緩衝**：僅渲染可見視口加上下各一屏高度內的消息。其餘全部替換為 `<Box height={N}>` 佔位符。

- **滾動鉗制邊界**：DOM 元素上的 `scrollClampMin`/`scrollClampMax` 防止滾動位置進入未渲染區域。用戶滾動快於 React 重渲染時，渲染器停在已掛載內容邊緣而非顯示空白。

- **粘性底部滾動**：新消息通過 `stickyScroll` 自動滾動到底部。僅用戶顯式上滾時取消釘底。

- **搜索索引**：全文搜索構建所有消息的緩存純文本索引。搜索高亮在屏幕緩衝層面應用（逐單元格樣式疊加），而非通過 React 重渲染。

### ScrollBox：滾動容器

`pendingScrollDelta` 累積器每幀消耗 `SCROLL_MAX_PER_FRAME` 行 —— 快速滑動顯示中間幀而非一次大跳。方向反轉自然抵消（純累積器，無目標跟蹤）。

---

## 8. Vim 模式狀態機

Claude Code 為輸入框內建了完整的 Vim 編輯模式 —— 不是子集，而是包含運算符、動作、文本對象、寄存器和點重複的完整實現。

### 狀態機架構

```typescript
// 源碼：vim/ 目錄
type VimState =
  | { mode: 'INSERT'; insertedText: string }
  | { mode: 'NORMAL'; command: CommandState }

type CommandState =
  | { type: 'idle' }                                  // 等待輸入
  | { type: 'count'; digits: string }                 // 前綴計數 (3dw)
  | { type: 'operator'; op: Operator; count }         // 等待動作 (d_)
  | { type: 'operatorCount'; op, count, digits }      // 運算符 + 計數 (d3w)
  | { type: 'operatorFind'; op, count, find }         // 運算符 + 查找 (df_)
  | { type: 'operatorTextObj'; op, count, scope }     // 運算符 + 文本對象 (diw)
  | { type: 'find'; find: FindType; count }           // f/F/t/T 等待字符
  | { type: 'g'; count }                              // g 前綴命令
  | { type: 'replace'; count }                        // r 等待替換字符
  | { type: 'indent'; dir: '>' | '<'; count }         // >> / << 縮進
```

### 狀態轉換圖

```
  idle ──┬─[d/c/y]──► operator ──┬─[motion]──► execute
         ├─[1-9]────► count      ├─[0-9]────► operatorCount
         ├─[fFtT]───► find       ├─[ia]─────► operatorTextObj
         ├─[g]──────► g          └─[fFtT]───► operatorFind
         ├─[r]──────► replace
         └─[><]─────► indent
```

### 純函數轉換

轉換函數是純函數 —— 無副作用，確定性輸出：

```typescript
function transition(state, input, ctx): TransitionResult {
  switch (state.type) {
    case 'idle':     return fromIdle(input, ctx)
    case 'count':    return fromCount(state, input, ctx)
    case 'operator': return fromOperator(state, input, ctx)
    // ... TypeScript 保證窮舉
  }
}
// 返回：{ next?: CommandState; execute?: () => void }
```

### 持久狀態（跨命令記憶）

```typescript
type PersistentState = {
  lastChange: RecordedChange | null  // 點重複 (.)
  lastFind: { type, char } | null   // 重複查找 (;/,)
  register: string                   // yank 寄存器內容
  registerIsLinewise: boolean        // 上次 yank 是否行級？
}
```

### 支持的操作

| 類別 | 命令 |
|------|------|
| **移動** | `h/l/j/k`, `w/b/e/W/B/E`, `0/^/$`, `gg/G`, `gj/gk` |
| **運算符** | `d` (刪除), `c` (修改), `y` (複製), `>/<` (縮進) |
| **查找** | `f/F/t/T` + 字符, `;/,` 重複 |
| **文本對象** | `iw/aw`, `i"/a"`, `i(/a(`, `i{/a{`, `i[/a[`, `i</a<` |
| **命令** | `x`, `~`, `r`, `J`, `p/P`, `D/C/Y`, `o/O`, `u` (撤銷), `.` (重複) |
| **點重複** | 記錄插入文本、運算符、替換、大小寫切換、縮進 |

`VimTextInput.tsx` (16KB) 組件將該狀態機與輸入框集成：Normal 模式攔截按鍵並路由到 `transition()`，Insert 模式直接透傳到正常文本編輯。

---

## 9. 鍵綁定系統

Claude Code 的鍵綁定系統支持多上下文、Emacs 風格的和絃序列、用戶自定義以及保留快捷鍵 —— 建立在事件系統之上的完整鍵盤層。

### 上下文綁定解析

每個綁定屬於一個**上下文**，決定其何時激活：

```typescript
// 源碼：keybindings/defaultBindings.ts（精簡版）
const DEFAULT_BINDINGS: KeybindingBlock[] = [
  {
    context: 'Global',              // 始終活躍
    bindings: {
      'ctrl+c': 'app:interrupt',
      'ctrl+d': 'app:exit',
      'ctrl+l': 'app:redraw',
      'ctrl+t': 'app:toggleTodos',
      'ctrl+r': 'history:search',
    }
  },
  {
    context: 'Chat',                // 輸入框獲得焦點時
    bindings: {
      'escape': 'chat:cancel',
      'shift+tab': 'chat:cycleMode',
      'meta+p': 'chat:modelPicker',
      'enter': 'chat:submit',
      'ctrl+x ctrl+e': 'chat:externalEditor',  // 和絃！
      'ctrl+x ctrl+k': 'chat:killAgents',      // 和絃！
    }
  },
  {
    context: 'Scroll',              // 滾動離開底部時
    bindings: {
      'pageup': 'scroll:pageUp',
      'ctrl+shift+c': 'selection:copy',
    }
  },
]
```

### 和絃支持（Emacs 風格多鍵序列）

```typescript
// 用戶按 ctrl+x → 進入"和絃等待"狀態
// 顯示 "ctrl+x ..." 提示
// 用戶按 ctrl+e → 匹配 'ctrl+x ctrl+e' → 'chat:externalEditor'
// 用戶按其他鍵 → 和絃取消，按鍵正常處理

type ChordResolveResult =
  | { type: 'match'; action: string }         // 完整匹配
  | { type: 'chord_started'; pending: ... }   // 和絃進行中
  | { type: 'chord_cancelled' }               // 第二鍵不匹配
  | { type: 'unbound' }                       // 顯式解綁
  | { type: 'none' }                          // 無綁定
```

### 在組件中使用鍵綁定

```typescript
// 單一綁定
useKeybinding('app:toggleTodos', () => {
  setShowTodos(prev => !prev)
}, { context: 'Global' })

// 多重綁定
useKeybindings({
  'chat:submit': () => handleSubmit(),
  'chat:cancel': () => handleCancel(),
}, { context: 'Chat' })
```

### 用戶自定義

用戶可通過 `~/.claude/keybindings.json` 重寫任何非保留綁定。文件通過 Zod schema 驗證，無效條目產生警告但不會破壞應用。

---

## 10. Computer Use 集成

Claude Code 集成了 Anthropic 的 Computer Use 能力 —— 讓模型能看到屏幕、移動鼠標、操作鍵盤並控制應用。這是一種完全不同的工具：不是文本輸入/輸出，而是基於像素和輸入事件的操作。

### 與常規工具的對比

| 方面 | 常規工具 | Computer Use 工具 |
|------|---------|-------------------|
| API 塊類型 | `tool_use` | `server_tool_use` |
| 執行 | CLI 端 | CLI 端（截圖）+ 服務器反饋 |
| 輸入 | 結構化 JSON | `{ action, coordinate?, text? }` |
| 輸出 | 文本結果 | JPEG 截圖（base64） |
| 平臺 | 跨平臺 | **僅 macOS**（需要 Swift + Rust 原生模塊） |

### Executor 模式

```typescript
// 源碼：utils/computerUse/executor.ts:259-644
export function createCliExecutor(opts): ComputerExecutor {
  // 兩個原生模塊：
  //   @ant/computer-use-swift  — 截圖、應用管理、TCC
  //   @ant/computer-use-input  — 鼠標、鍵盤（Rust/enigo）

  const cu = requireComputerUseSwift()  // 工廠時加載一次

  return {
    async screenshot(opts) {
      // 預調整至 targetImageSize，使 API 轉碼器早返回
      // 無服務器端縮放 → scaleCoord 保持一致
      const d = cu.display.getSize(opts.displayId)
      const [targetW, targetH] = computeTargetDims(d.width, d.height, d.scaleFactor)
      return drainRunLoop(() =>
        cu.screenshot.captureExcluding(withoutTerminal(opts.allowedBundleIds), ...)
      )
    },

    async click(x, y, button, count, modifiers?) {
      const input = requireComputerUseInput()  // 惰性加載
      await moveAndSettle(input, x, y)         // 瞬移 + 50ms 沉降
      // ... 修飾鍵包裝
    },

    async key(keySequence, repeat?) {
      // xdotool 風格："ctrl+shift+a" → 按 '+' 分割 → keys()
      // 裸 Escape：通知 CGEventTap 不要中止
      const parts = keySequence.split('+')
      await drainRunLoop(async () => {
        for (let i = 0; i < n; i++) {
          if (isBareEscape(parts)) notifyExpectedEscape()
          await input.keys(parts)
        }
      })
    },
  }
}
```

### CFRunLoop 挑戰

最獨特的工程細節：`drainRunLoop()`。在 macOS 上，原生 GUI 操作派發到主線程的 CFRunLoop。在終端應用中（無 NSRunLoop），這些事件會排隊但永遠不會被處理。解決方案是手動泵送：

```typescript
// drainRunLoop 包裝派發到主隊列的異步操作。
// 沒有泵送，來自 Rust/Swift 原生模塊的鼠標/鍵盤調用
// 在終端上下文中會永遠掛起。
await drainRunLoop(async () => {
  await cu.screenshot.captureExcluding(...)
})
```

這就是 Computer Use 僅限 macOS 的原因：與 AppKit、CGEvent 和 SCContentFilter 的緊密集成需要僅在 Apple 事件模型內工作的原生 Swift 和 Rust 模塊。

### AppState 中的狀態

Computer Use 狀態存儲在 `AppState.computerUseMcpState` 中：

```typescript
computerUseMcpState?: {
  allowedApps?: readonly { bundleId, displayName, grantedAt }[]
  grantFlags?: { clipboardRead, clipboardWrite, systemKeyCombos }
  lastScreenshotDims?: { width, height, displayWidth, displayHeight, ... }
  hiddenDuringTurn?: ReadonlySet<string>
  selectedDisplayId?: number
  displayPinnedByModel?: boolean
}
```

此狀態為**會話範圍**（不跨恢復持久化），追蹤應用允許列表、截圖尺寸（用於座標映射）以及當前回合被隱藏的應用（回合結束時通過 `cleanup.ts` 取消隱藏）。

---

## 可遷移設計模式

> 以下模式可直接應用於其他智能體系統或 CLI 工具。

### 模式 1："35 行替代一個庫"

**場景**：你需要 React 應用中的全局狀態管理。

**實踐**：在引入 Redux/Zustand/Jotai 之前先問：你真的需要中間件、devtools 或計算選擇器嗎？如果答案是否定的，一個帶 `getState`/`setState`/`subscribe` 的 `createStore` 函數 —— 通過 `useSyncExternalStore` 集成 —— 能在 40 行內提供相同的併發安全渲染保證。

### 模式 2：瀏覽器事件模型用於非瀏覽器環境

**場景**：你的終端/嵌入式 UI 有重疊的交互區域（模態框、嵌套滾動器、焦點上下文）。

**實踐**：實現 W3C 捕獲/冒泡派發模型。三階段模型（捕獲 → 目標 → 冒泡）配合 `stopPropagation()` 和優先級層級，能解決臨時方案難以應付的事件路由問題。

### 模式 3：非瀏覽器環境中的虛擬滾動

**場景**：你需要在固定高度視口中顯示數千條項目。

**實踐**：僅渲染視口 + 緩衝區內的項目。使用高度估算配合測量緩存。實現滾動鉗制以防止快速滾動時出現空白屏幕。

### 模式 4：打包類型化數組實現無 GC 渲染

**場景**：你在做逐幀的網格/單元格操作，其中對象分配導致 GC 暫停。

**實踐**：使用位移將多個字段打包到類型化數組中。在同一 `ArrayBuffer` 上使用雙視圖，用於逐元素訪問（Int32Array）和批量操作（BigInt64Array）。將字符串駐留為整數池。

### 模式 5：純函數狀態機用於編輯器模式

**場景**：你需要一個帶可組合命令的多模式文本編輯器。

**實踐**：將每種模式建模為狀態類型的可區分聯合體成員。轉換函數是純函數：`(state, input, ctx) → { next?, execute? }`。持久狀態（寄存器、上次命令）存在於瞬態命令狀態之外。

---

## 組件總覽

| 組件 | 關鍵文件 | 大小 | 職責 |
|------|---------|------|------|
| Ink Fork | `ink/` (48 文件) | ~620KB | 自定義終端渲染引擎 |
| 協調器 | `ink/reconciler.ts` | 14.6KB | React 19 ↔ 終端橋樑 |
| 屏幕緩衝 | `ink/screen.ts` | 49.3KB | 打包 Int32Array 雙緩衝單元格 |
| 事件系統 | `ink/events/` | ~15KB | W3C 捕獲/冒泡 + 優先級派發 |
| Store | `state/store.ts` | 836B | 35 行全局狀態管理 |
| AppState | `state/AppStateStore.ts` | 21.8KB | 570 行應用狀態類型 |
| REPL 屏幕 | `screens/REPL.tsx` | 874KB | 主交互界面 |
| 虛擬滾動 | `VirtualMessageList.tsx` | 148KB | 高度緩存虛擬滾動 |
| Vim 模式 | `vim/` 目錄 | ~50KB | 完整 Vim 狀態機 |
| 鍵綁定 | `keybindings/` | ~40KB | 多上下文和絃鍵綁定 |
| Computer Use | `utils/computerUse/` | ~125KB | macOS 原生屏幕/輸入控制 |

**UI 與狀態管理總面積：約 2MB 的渲染、交互和狀態基礎設施。**

---

*下一集：第 15 集 — 服務與 API 層*

[← 第 13 集 — Bridge 系統](13-bridge-system.md) · [第 15 集 — 服務與 API 層 →](15-services-api-layer.md)
