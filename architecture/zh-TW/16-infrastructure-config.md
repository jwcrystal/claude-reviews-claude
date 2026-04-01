# 16 — 基礎設施與配置：Claude Code 的隱藏骨架

> **範圍**: `bootstrap/state.ts`（56KB）、`entrypoints/init.ts`、`utils/config.ts`、`utils/settings/`、`utils/secureStorage/`、`utils/tokens.ts`、`utils/claudemd.ts`、`utils/signal.ts`、`utils/git/`、`utils/thinking.ts`、`utils/cleanupRegistry.ts`、`utils/startupProfiler.ts`
>
> **一句話概括**: 那個不起眼的基礎設施層——從 1,759 行的全局狀態單例到五層設置合併系統——讓所有其他子系統得以運轉，同時徹底杜絕循環依賴。

---

## 目錄

1. [Bootstrap 全局單例模式](#1-bootstrap-全局單例模式)
2. [init.ts 初始化編排器](#2-inits-初始化編排器)
3. [雙層配置系統](#3-雙層配置系統)
4. [五層設置合併](#4-五層設置合併)
5. [安全存儲](#5-安全存儲)
6. [Signal 事件原語與 AbortController](#6-signal-事件原語與-abortcontroller)
7. [Git 工具庫](#7-git-工具庫)
8. [Token 管理與上下文預算](#8-token-管理與上下文預算)
9. [CLAUDE.md 與持久化記憶系統](#9-claudemd-與持久化記憶系統)
10. [Thinking 模式 API 規則](#10-thinking-模式-api-規則)
11. [可遷移的設計模式](#11-可遷移的設計模式)

---

## 1. Bootstrap 全局單例模式

**源碼座標**: `src/bootstrap/state.ts`（1,759 行，56KB——整個項目中導入最少的最大文件）

每個複雜系統都有"上帝對象"問題。Claude Code 的對策是 `state.ts`——一個位於依賴圖最底層的**葉模塊**，僅導入外部包和僅類型聲明。這不是偶然；而是由**自定義 ESLint 規則強制執行**的。

### 1.1 葉模塊約束

```typescript
// 源碼位置: src/bootstrap/state.ts:17-18
// eslint-disable-next-line custom-rules/bootstrap-isolation
import { randomUUID } from 'src/utils/crypto.js'
```

`custom-rules/bootstrap-isolation` 規則確保 `state.ts` 永遠不從 `src/` 的其他位置導入。唯一的例外——通過 `crypto.js` 導入的 `randomUUID`——需要顯式的 ESLint 禁用註釋，其存在僅因為瀏覽器 SDK 構建需要平臺無關的 `crypto` 墊片。

**為什麼重要**: 在一個 100+ 模塊的代碼庫中，任何成為依賴中心的模塊都會產生循環導入風險。通過將 `state.ts` 變成葉節點，Claude Code 保證了任何模塊都能安全導入它，無需擔心依賴循環。這就是對抗循環依賴的**架構免疫系統**。

### 1.2 State 對象：約 100 個字段的會話真相

私有 `STATE` 對象是會話級狀態的唯一真相源。分類概覽：

```
┌─────────────────────────────────────────────────────────────┐
│                    STATE 對象分類概覽                         │
├──────────────────────┬──────────────────────────────────────┤
│ 身份與路徑           │ originalCwd, projectRoot, cwd,       │
│                      │ sessionId, parentSessionId            │
├──────────────────────┼──────────────────────────────────────┤
│ 成本與指標           │ totalCostUSD, totalAPIDuration,       │
│                      │ turnHookDurationMs, turnToolCount     │
├──────────────────────┼──────────────────────────────────────┤
│ 模型配置             │ modelUsage, mainLoopModelOverride,    │
│                      │ initialMainLoopModel, modelStrings    │
├──────────────────────┼──────────────────────────────────────┤
│ 遙測（OpenTelemetry）│ meter, sessionCounter, locCounter,    │
│                      │ loggerProvider, tracerProvider         │
├──────────────────────┼──────────────────────────────────────┤
│ 緩存鎖存             │ afkModeHeaderLatched,                  │
│（一旦開啟不再關閉）   │ fastModeHeaderLatched,                 │
│                      │ promptCache1hEligible,                 │
│                      │ cacheEditingHeaderLatched               │
├──────────────────────┼──────────────────────────────────────┤
│ 會話標誌             │ sessionBypassPermissionsMode,          │
│（不持久化）          │ sessionTrustAccepted,                  │
│                      │ scheduledTasksEnabled,                  │
│                      │ sessionCreatedTeams                     │
├──────────────────────┼──────────────────────────────────────┤
│ Skills 與插件        │ invokedSkills, inlinePlugins,          │
│                      │ allowedChannels, hasDevChannels         │
└──────────────────────┴──────────────────────────────────────┘
```

### 1.3 鎖存機制：一旦開啟，永不關閉

`state.ts` 中最精妙的模式是**粘性開關鎖存**——某些 beta header 一旦激活，就會在整個會話生命週期內保持激活：

```typescript
// 源碼位置: src/bootstrap/state.ts:226-242
// AFK_MODE_BETA_HEADER 的粘性鎖存。一旦 auto 模式首次激活，
// 在會話剩餘時間內持續發送該 header，這樣 Shift+Tab 切換
// 不會破壞 ~50-70K token 的 prompt cache。
afkModeHeaderLatched: boolean | null   // null = 尚未觸發

// 相同模式重複用於:
fastModeHeaderLatched: boolean | null
cacheEditingHeaderLatched: boolean | null
thinkingClearLatched: boolean | null
```

**經濟賬**: 如果 `Shift+Tab` 切換每次都翻轉 prompt cache 控制 header，每次翻轉都會使服務器端的 prompt cache（~50–70K token）失效。按 $3/MTok 輸入價格計算，每次切換浪費約 $0.15–$0.21。鎖存機制將這從"每次切換都花錢"變成了"整個會話只花一次"。

### 1.4 原子會話切換

```typescript
// 源碼位置: src/bootstrap/state.ts:468-479
export function switchSession(
  sessionId: SessionId,
  projectDir: string | null = null,
): void {
  STATE.planSlugCache.delete(STATE.sessionId)  // 清理舊會話
  STATE.sessionId = sessionId
  STATE.sessionProjectDir = projectDir
  sessionSwitched.emit(sessionId)  // 通知訂閱者
}
```

`sessionId` 和 `sessionProjectDir` 總是一起變化——沒有任何一方的獨立 setter。註釋 `CC-34` 引用了驅動這一設計的 bug：當它們被獨立設置時，`/resume` 可能導致兩者不同步，導致 transcript 寫入錯誤的目錄。

### 1.5 交互時間批處理

一個為終端渲染服務的精巧優化：

```typescript
// 源碼位置: src/bootstrap/state.ts:665-689
let interactionTimeDirty = false

export function updateLastInteractionTime(immediate?: boolean): void {
  if (immediate) {
    flushInteractionTime_inner()  // 立即調用 Date.now()
  } else {
    interactionTimeDirty = true   // 延遲到下一個渲染週期
  }
}
```

不在每次按鍵時都調用 `Date.now()`，而是標記髒位，將實際時間戳更新批量合入 Ink 渲染週期。`immediate` 路徑是為 React `useEffect` 回調準備的——它們運行在渲染週期刷新_之後_。

---

## 2. init.ts 初始化編排器

**源碼座標**: `src/entrypoints/init.ts`（341 行）

`init()` 函數——用 `memoize` 包裝以確保只執行一次——編排了啟動序列。這是**有序初始化與策略性並行**的典範。

### 2.1 初始化序列

```
┌─ 1. enableConfigs()              — 驗證並啟用配置系統
│
├─ 2. applySafeConfigEnvironmentVariables()
│     ↳ 信任對話框之前僅應用安全變量
│
├─ 3. applyExtraCACertsFromConfig()
│     ↳ 必須在首次 TLS 握手之前
│     ↳ Bun 在啟動時通過 BoringSSL 緩存證書存儲
│
├─ 4. setupGracefulShutdown()       — 註冊清理處理器
│
├─ 5. void Promise.all([...])       — 即發即忘異步初始化
│     ├─ firstPartyEventLogger      — 非阻塞
│     └─ growthbook                  — 特性開關刷新回調
│
├─ 6. void populateOAuthAccountInfoIfNeeded()   — 異步，非阻塞
│  void initJetBrainsDetection()
│  void detectCurrentRepository()
│
├─ 7. configureGlobalMTLS()         — 雙向 TLS
│  configureGlobalAgents()          — 代理配置
│
├─ 8. preconnectAnthropicApi()      — TCP+TLS 握手重疊
│     ↳ 在 action-handler 的 ~100ms 工作期間完成
│
├─ 9. registerCleanup(shutdownLspServerManager)
│  registerCleanup(cleanupSessionTeams)
│
└─ 10. ensureScratchpadDir()        — 如果啟用了 scratchpad
```

### 2.2 為什麼順序很重要

第 3 步（CA 證書）**必須**在第 8 步（預連接）之前：Bun 使用 BoringSSL，它在啟動時緩存證書存儲。如果企業設置中的額外 CA 證書在首次 TLS 握手之前沒有被應用，它們在整個進程生命週期內都會被忽略。

第 8 步（預連接）**必須**在第 7 步（代理）之後：預連接優化會向 Anthropic API 打開 TCP+TLS 連接，與 action-handler 的 ~100ms 工作重疊。但它必須使用配置好的代理/mTLS 傳輸，所以代理設置在前。當代理/mTLS/Unix 套接字配置會阻止全局 HTTP 池複用預熱連接時，預連接會被完全跳過。

### 2.3 遙測：延遲到信任對話框之後

```typescript
// 源碼位置: src/entrypoints/init.ts:305-311
async function setMeterState(): Promise<void> {
  // 延遲加載以推遲 ~400KB 的 OpenTelemetry + protobuf
  const { initializeTelemetry } = await import(
    '../utils/telemetry/instrumentation.js'
  )
  const meter = await initializeTelemetry()
  // ...
}
```

遙測棧——~400KB 的 OpenTelemetry + protobuf，加上進一步的 ~700KB `@grpc/grpc-js` 導出器——僅在**信任對話框被接受後**才加載。這既是性能優化（`--version` 不需要付出導入代價），也是隱私保證（同意之前沒有遙測）。

### 2.4 ConfigParseError：優雅的錯誤對話框

當 `settings.json` 未通過 Zod 驗證時，一個基於 React 的 Ink 對話框會出現以展示錯誤並引導用戶修復。但在非交互（SDK/無頭）模式下，對話框會破壞 JSON 消費者，所以回退為寫入 stderr 並退出。

---

## 3. 雙層配置系統

**源碼座標**: `src/utils/config.ts`

Claude Code 將運行時狀態和行為配置分開：

| 層級 | 文件 | 用途 |
|-------|------|---------|
| **GlobalConfig** | `~/.claude.json` | 運行時狀態：OAuth token、會話歷史、使用指標 |
| **ProjectConfig** | `.claude/config.json` | 項目狀態：允許的工具、MCP 服務器、信任狀態 |
| **SettingsJson** | `settings.json`（多源）| 行為：權限、鉤子、模型選擇、環境變量 |

### 3.1 重入防護

防止無限遞歸的精妙防禦：

```typescript
// 源碼位置: src/utils/config.ts
let insideGetConfig = false

export function getGlobalConfig(): GlobalConfig {
  if (insideGetConfig) {
    return DEFAULT_GLOBAL_CONFIG  // 短路返回默認值
  }
  insideGetConfig = true
  try {
    // ... 實際讀取邏輯（可能觸發 logEvent → getGlobalConfig）
  } finally {
    insideGetConfig = false
  }
}
```

調用鏈 `getConfig → logEvent → getGlobalConfig → getConfig` 沒有這個防護就會無限遞歸。修復方法很優雅：重入時返回默認配置。日誌事件獲取了略微過時的數據，但系統不會崩潰。

---

## 4. 五層設置合併

**源碼座標**: `src/utils/settings/settings.ts`、`src/utils/settings/constants.ts`

### 4.1 五個來源

設置從五個來源加載，後加載的覆蓋先加載的：

```typescript
export const SETTING_SOURCES = [
  'userSettings',      // ~/.claude/settings.json — 個人全局
  'projectSettings',   // .claude/settings.json — 項目共享，已提交
  'localSettings',     // .claude/settings.local.json — 項目本地，gitignored
  'flagSettings',      // --settings CLI 參數覆蓋
  'policySettings',    // managed-settings.json 或遠程 API — 企業管控
] as const
```

### 4.2 企業管控設置：Drop-In 目錄

支持 systemd 風格的 drop-in 配置：

```typescript
export function loadManagedFileSettings(): { settings, errors } {
  // 1. 加載基礎文件 managed-settings.json（最低優先級）
  // 2. 加載 drop-in 目錄 managed-settings.d/*.json
  //    按字母排序，後文件覆蓋前文件
  //    例如: 10-otel.json, 20-security.json
}
```

這使 IT 部門能夠獨立部署配置片段：`10-otel.json` 用於可觀察性設置，`20-security.json` 用於權限策略，`30-models.json` 用於批准的模型列表。每個團隊可以擁有自己的片段而不會產生合併衝突。

### 4.3 lazySchema：打破 Schema 循環依賴

```typescript
export function lazySchema<T>(factory: () => T): () => T {
  let cached: T | undefined
  return () => cached ?? (cached = factory())
}
```

這不僅是性能優化——它**打破了 schema 文件之間的循環依賴**。當 `schemas/hooks.ts` 引用 `settings/types.ts` 中的類型，反之亦然時，將 schema 包裝在惰性工廠函數中確保在導入時無需完全求值。

---

## 5. 安全存儲

**源碼座標**: `src/utils/secureStorage/`

### 5.1 平臺適配鏈

```typescript
export function getSecureStorage(): SecureStorage {
  if (process.platform === 'darwin') {
    return createFallbackStorage(macOsKeychainStorage, plainTextStorage)
  }
  return plainTextStorage  // Linux/Windows: 優雅降級
}
```

### 5.2 macOS Keychain：TTL 緩存 + Stale-While-Error

關鍵洞察是 **stale-while-error** 策略：當 `security` 子進程失敗時（macOS Keychain 服務臨時重啟、用戶切換等），繼續使用緩存數據而非返回 null。如果沒有這一策略，一次 `security` 進程故障會表現為全局的"未登錄"錯誤，迫使用戶重新認證。

### 5.3 異步去重

```typescript
async readAsync(): Promise<SecureStorageData | null> {
  if (keychainCacheState.readInFlight) {
    return keychainCacheState.readInFlight  // 合併併發請求
  }
  // ...
}
```

多個併發的 `readAsync()` 調用共享一個進行中的 Promise，防止對 Keychain 子進程的驚群效應。

---

## 6. Signal 事件原語與 AbortController

**源碼座標**: `src/utils/signal.ts`、`src/utils/abortController.ts`

### 6.1 Signal 原語

Claude Code 用一個可複用原語替換了約 15 處手寫的監聽器集合：

```typescript
// 源碼位置: src/utils/signal.ts
export function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }  // 返回取消訂閱函數
    },
    emit(...args) { for (const listener of listeners) listener(...args) },
    clear() { listeners.clear() },
  }
}
```

**Signal vs Store**: Signal 沒有快照或 `getState()`——它只說"某事發生了"。Store（第 14 篇）持有狀態並在變化時通知。這種區分讓 API 表面保持最小化。

### 6.2 帶 WeakRef 的父子 AbortController

三重內存安全保證：
1. **WeakRef** 防止父級保持對已廢棄子級的強引用
2. **{once: true}** 確保監聽器最多觸發一次
3. **模塊級 `propagateAbort`** 使用 `.bind()` 而非閉包，避免每次調用分配函數對象

---

## 7. Git 工具庫

**源碼座標**: `src/utils/git/gitFilesystem.ts`

### 7.1 文件系統級 Git 狀態

不為每次狀態檢查產生 `git` 子進程，而是直接讀取 `.git` 文件：

```typescript
export async function resolveGitDir(startPath?: string): Promise<string | null> {
  const gitPath = join(root, '.git')
  const st = await stat(gitPath)
  if (st.isFile()) {
    // Worktree 或 Submodule: .git 是包含 "gitdir: <path>" 的文件
    const content = (await readFile(gitPath, 'utf-8')).trim()
    if (content.startsWith('gitdir:')) {
      return resolve(root, content.slice('gitdir:'.length).trim())
    }
  }
  return gitPath  // 正常倉庫: .git 是目錄
}
```

透明處理三種情況：正常倉庫、Worktree（跟隨 gitdir 指針）、Submodule。

### 7.2 Ref 名稱安全驗證

防止三種攻擊向量：路徑遍歷（`../../../etc/passwd`）、參數注入（前導 `-`）、Shell 元字符注入（反引號、`$`、`;`、`|`、`&`）。使用白名單方式：只允許 ASCII 字母數字 + `/._+-@`。

---

## 8. Token 管理與上下文預算

**源碼座標**: `src/utils/tokens.ts`、`src/utils/context.ts`、`src/utils/tokenBudget.ts`

### 8.1 權威 Token 計數器

`tokenCountWithEstimation()` 是上下文窗口大小的**唯一真相源**。算法：
1. 從消息末尾向前查找最後一個帶 `usage` 數據的 API 響應
2. 處理並行工具拆分：如果響應被拆分為多個消息（相同 `message.id`），回溯到第一個
3. 用 API 報告的 token 計數作為基線，然後**估算**該響應之後到達的消息的 token 數

這種混合方法（API 真相 + 估算）避免了昂貴的 tokenization 調用，同時保持足夠的精度用於壓縮閾值判斷。

### 8.2 用戶指定 Token 預算

用戶可以在消息中直接嵌入預算提示：`+500k fix the login bug` 會被解析為 500,000 輸出 token 預算。

---

## 9. CLAUDE.md 與持久化記憶系統

**源碼座標**: `src/utils/claudemd.ts`、`src/memdir/memdir.ts`

### 9.1 加載層級

從低到高（後加載覆蓋前加載）：

```
1. /etc/claude-code/CLAUDE.md              — 企業全局指令
2. ~/.claude/CLAUDE.md + ~/.claude/rules/   — 用戶全局指令
3. 項目 CLAUDE.md, .claude/CLAUDE.md        — 項目級指令（版本控制內）
4. CLAUDE.local.md                          — 項目本地指令（gitignored）
```

### 9.2 @include 指令系統

支持跨文件包含（`@path`、`@./relative`、`@~/home`），僅在葉文本節點中工作（代碼塊中的不會被當作 include），有循環引用檢測，不存在的文件靜默忽略。

### 9.3 自動記憶 (memdir)

`MEMORY.md` 的截斷策略是刻意按行感知的：先按行截斷（200 行上限），再按字節截斷（25,000 字節），且始終在換行符邊界切割，不會切斷行內容。

---

## 10. Thinking 模式 API 規則

**源碼座標**: `src/utils/thinking.ts`

### 10.1 三種配置類型

- `adaptive`: 模型自主決定（僅 4.6+ 支持）
- `enabled { budgetTokens }`: 固定 token 預算
- `disabled`: 不使用思考塊

### 10.2 提供商感知的能力檢測

1P 和 Foundry 環境：所有 Claude 4+ 支持 thinking；3P（Bedrock/Vertex）：僅 Opus 4+ 和 Sonnet 4+。自適應思考僅 4.6 版本模型支持。

### 10.3 Ultrathink：構建時 + 運行時雙重門控

`feature('ULTRATHINK')` 在構建時由 `bun:bundle` 解析。外部構建中為 `false`，整個函數體包括 GrowthBook 調用都被死代碼消除。內部構建中，運行時 GrowthBook 標誌提供動態控制。

---

## 可遷移設計模式

> 以下模式從 Claude Code 基礎設施層提煉而來，可直接應用於任何複雜 CLI 工具或 Agentic 系統。

### 模式 1: 葉模塊隔離

**場景**: 每個其他模塊都導入的全局狀態模塊。
**實踐**: 讓全局模塊成為依賴圖葉節點——它**不從項目中導入任何東西**。用自定義 linter 規則強制執行。
**應用**: `bootstrap/state.ts` 通過 `custom-rules/bootstrap-isolation` 阻止從 `src/` 的任何導入。

### 模式 2: 粘性開關鎖存（緩存鍵穩定性）

**場景**: 影響服務器端緩存的 API 請求 header 的布爾開關。
**實踐**: header 首次激活後，在會話生命週期內保持激活。使用三態類型（`boolean | null`），其中 `null` 表示"尚未觸發"。

### 模式 3: 重入防護

**場景**: 觸發日誌記錄的配置讀取器，日誌又讀取配置。
**實踐**: 布爾守衛標誌 + 重入時短路返回默認值。

### 模式 4: Stale-While-Error

**場景**: 偶爾失敗的外部服務（OS Keychain、遠程 API）。
**實踐**: 失敗時繼續使用最近一次成功的緩存響應，而非返回 null。記錄異常但不中斷用戶。

### 模式 5: Drop-In 配置目錄

**場景**: 多個團隊需要配置不同方面的企業部署。
**實踐**: 支持 `settings.d/*.json` 目錄，文件按字母排序加載併合並。使用數字前綴確定順序。

### 模式 6: lazySchema 打破循環 Schema 依賴

**場景**: 互相引用的 Zod schema。
**實踐**: 將 schema 構造函數包裝在 `lazySchema()` 工廠中，延遲到首次使用時求值，帶緩存避免重建。

### 模式 7: 父子事件傳播中的 WeakRef

**場景**: 向子級傳播取消的父 AbortController。
**實踐**: 對父→子引用使用 `WeakRef`，模塊級 `.bind()` 處理器而非閉包，`{once: true}` 事件監聽器自動清理。

---

## 源碼文件參考

| 文件 | 大小 | 角色 |
|------|------|------|
| `bootstrap/state.ts` | 56KB / 1,759 行 | 全局狀態單例，葉模塊 |
| `entrypoints/init.ts` | 14KB / 341 行 | 初始化編排器 |
| `utils/config.ts` | ~12KB | 雙層配置（Global + Project）|
| `utils/settings/settings.ts` | ~15KB | 五層設置合併 + 企業 drop-in |
| `utils/secureStorage/` | ~8KB | 平臺自適應憑證存儲 |
| `utils/signal.ts` | ~2KB | 輕量級事件原語 |
| `utils/abortController.ts` | ~5KB | 基於 WeakRef 的父子取消 |
| `utils/git/gitFilesystem.ts` | ~7KB | 文件系統級 Git 操作 |
| `utils/tokens.ts` | ~8KB | Token 計數 + 上下文估算 |
| `utils/claudemd.ts` | ~15KB | CLAUDE.md 加載 + @include 系統 |
| `memdir/*.ts` | ~10KB | 自動記憶（MEMORY.md）系統 |
| `utils/thinking.ts` | ~5KB | Thinking 模式配置 + 能力檢測 |

---

**上一篇**: [← 15 — 服務層與 API 架構](../architecture/15-services-api-layer.md) · **下一篇**: [00 — 總綱（即將推出）](../architecture/00-overview.md)
