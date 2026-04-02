# 第 15 集：服務層與 API 架構 —— 神經系統

> **源碼文件**: `src/services/api/claude.ts` (~126KB, 3,420 行), `client.ts` (390 行), `withRetry.ts` (823 行), `errors.ts` (1,208 行), `src/services/mcp/client.ts` (~119KB), `src/services/analytics/growthbook.ts` (~41KB), `src/services/lsp/LSPServerManager.ts` (421 行)
>
> **一句話總結**: 服務層是 Claude Code 的神經系統——一個多提供商 API 客戶端工廠、一個 700 行的流式查詢引擎、一個久經沙場的重試策略矩陣、一個 GrowthBook 驅動的特性開關係統、MCP 協議集成和 LSP 橋接——全部通過 AsyncGenerator 管道和閉包工廠模式串聯起來。

---

## 架構總覽

```
src/services/
├── api/                    # Anthropic API 客戶端 (~300K)
│   ├── claude.ts           # 核心 queryModel 引擎 (126K, 3,420 行)
│   ├── client.ts           # 多提供商客戶端工廠 (16K)
│   ├── withRetry.ts        # 重試策略引擎 (28K, 823 行)
│   ├── errors.ts           # 錯誤分類系統 (42K)
│   ├── logging.ts          # API 遙測與診斷 (24K)
│   ├── bootstrap.ts        # 引導 API 請求
│   ├── filesApi.ts         # 文件上傳 API
│   ├── promptCacheBreakDetection.ts  # 緩存命中分析 (26K)
│   └── sessionIngress.ts   # 會話日誌持久化 (17K)
├── mcp/                    # MCP 協議集成 (~250K)
│   ├── client.ts           # MCP 客戶端生命週期 (119K)
│   ├── auth.ts             # OAuth/XAA 認證 (89K)
│   ├── MCPConnectionManager.tsx  # React 連接上下文
│   ├── types.ts            # Zod Schema 配置
│   └── config.ts           # 多源配置合併 (51K)
├── analytics/              # 特性開關與遙測
│   ├── growthbook.ts       # GrowthBook 集成 (41K)
│   ├── index.ts            # 事件分析管道
│   └── sink.ts             # Sink 架構 (DD + 1P BQ)
├── lsp/                    # Language Server Protocol
│   ├── LSPServerManager.ts # 閉包工廠管理器 (13K)
│   ├── manager.ts          # 全局單例 + 代際計數器 (10K)
│   └── passiveFeedback.ts  # 診斷通知處理器
├── compact/                # 上下文壓縮 (→ 見第 11 集)
├── oauth/                  # OAuth 2.0 客戶端
├── plugins/                # 插件市場管理
├── policyLimits/           # 組織策略限制
├── remoteManagedSettings/  # 遠程配置同步
├── teamMemorySync/         # 團隊記憶同步
└── extractMemories/        # 自動記憶提取
```

### 設計原則

五個架構不變量貫穿整個服務層：

1. **多提供商抽象** —— 單個 `getAnthropicClient()` 工廠函數為 Anthropic 1P、AWS Bedrock、Azure Foundry 和 Google Vertex 生成 SDK 實例，通過動態 `await import()` 避免將未使用的 SDK 打入包中。
2. **非關鍵服務 Fail-Open** —— 企業功能（`policyLimits`、`remoteManagedSettings`）在失敗時優雅降級。核心查詢循環永遠不會被它們阻塞。
3. **會話穩定鎖存機制** —— 一旦發送了某個 beta header（如 `fast_mode`、`afk_mode`），它將在整個會話期間保持啟用。這防止了對話中途 prompt cache 鍵的變化——單次緩存鍵翻轉可以使成本增加 12 倍。
4. **AsyncGenerator 管道** —— 核心 API 調用鏈（`queryModel → withRetry → 流處理器`）通過 `AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage>` 串聯，使調用者能在等待最終結果的同時處理中間的重試/錯誤事件。
5. **閉包工廠替代 Class** —— 有狀態的服務（LSP 管理器、緩存微壓縮）使用 `createXxxManager()` 函數配合閉包作用域的私有狀態，消除了 `this` 綁定問題。

---

## 1. 客戶端工廠 —— 四個提供商，一個接口

整個 API 子系統的入口是 `client.ts` 中的 `getAnthropicClient()`。無論底層是哪個提供商，它都返回單一的 `Anthropic` SDK 實例：

```typescript
// 源碼位置: src/services/api/client.ts:88-100
export async function getAnthropicClient({
  apiKey, maxRetries, model, fetchOverride, source,
}: { ... }): Promise<Anthropic> {
  const defaultHeaders: { [key: string]: string } = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Claude-Code-Session-Id': getSessionId(),
    ...customHeaders,
  }
  await checkAndRefreshOAuthTokenIfNeeded()
  // ... 構建 ARGS（代理、超時 600s 默認值等）
```

### 提供商分發鏈

工廠通過環境變量檢測來選擇提供商，利用動態導入將未使用的 SDK 排除在打包之外：

```
CLAUDE_CODE_USE_BEDROCK=1  → await import('@anthropic-ai/bedrock-sdk')
CLAUDE_CODE_USE_FOUNDRY=1  → await import('@anthropic-ai/foundry-sdk')
CLAUDE_CODE_USE_VERTEX=1   → await import('@anthropic-ai/vertex-sdk')
（默認）                    → new Anthropic(...)
```

每個提供商分支都返回 `as unknown as Anthropic` —— 這是一個刻意的類型謊言。Bedrock、Foundry 和 Vertex SDK 的類型簽名略有不同，但 `queryModel` 調用者統一處理。源碼中的註釋坦率得令人耳目一新：*"we have always been lying about the return type."*

### Bedrock 細節

```typescript
// 源碼位置: src/services/api/client.ts:153-189
if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
  const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
  const awsRegion =
    model === getSmallFastModel() && process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
      ? process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
      : getAWSRegion()
  // Bearer token 認證 (AWS_BEARER_TOKEN_BEDROCK) 或 STS 憑證刷新
}
```

一個小但重要的細節：Bedrock 支持按模型指定區域。`ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION` 變量允許你將 Haiku 路由到與主模型不同的區域——當你的 Opus 區域過載時非常有用。

### `buildFetch` 包裝器

```typescript
// 源碼位置: src/services/api/client.ts:358-389
function buildFetch(fetchOverride, source): ClientOptions['fetch'] {
  const inner = fetchOverride ?? globalThis.fetch
  const injectClientRequestId =
    getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
  return (input, init) => {
    const headers = new Headers(init?.headers)
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    return inner(input, { ...init, headers })
  }
}
```

這個小包裝器解決了現實中的調試痛點：當 API 請求超時時，服務器不返回請求 ID。通過在每個第一方請求中注入客戶端側的 `x-client-request-id` UUID，API 團隊仍然可以將超時與服務器日誌關聯起來。

---

## 2. queryModel —— 700 行的心臟

`claude.ts` 中的 `queryModel()` 是整個代碼庫中最重要的單個函數。約 700 行代碼編排了從 GrowthBook 熔斷檢查到流式事件累積的一切：

```
queryModel() 入口
  │
  ├─ 1. 熔斷開關檢查 (GrowthBook: tengu-off-switch)
  ├─ 2. Beta headers 組裝 (getMergedBetas)
  ├─ 3. 工具搜索過濾 (僅包含已發現的延遲加載工具)
  ├─ 4. 工具 Schema 構建 (並行生成)
  ├─ 5. 消息規範化 (normalizeMessagesForAPI)
  ├─ 6. Beta header 鎖存 (fast_mode, afk_mode, cache_editing)
  ├─ 7. paramsFromContext 閉包 (完整 API 請求構建)
  ├─ 8. withRetry 包裝器 (→ 見 §3)
  ├─ 9. 原始 SSE 流消費 (→ 見 §4)
  └─ 10. AssistantMessage 輸出
```

### 熔斷開關

```typescript
// 源碼位置: src/services/api/claude.ts:1028-1049
if (
  !isClaudeAISubscriber() &&
  isNonCustomOpusModel(options.model) &&
  (await getDynamicConfig_BLOCKS_ON_INIT<{ activated: boolean }>(
    'tengu-off-switch', { activated: false }
  )).activated
) {
  yield getAssistantMessageFromError(
    new Error(CUSTOM_OFF_SWITCH_MESSAGE), options.model
  )
  return
}
```

這是 Claude Code 的緊急制動器。當 Opus 處於極端負載時，Anthropic 可以通過 GrowthBook 實時禁用它。檢查被 `isNonCustomOpusModel()` 和 `!isClaudeAISubscriber()` 門控，不影響訂閱用戶或自定義模型。

注意順序優化：廉價的同步檢查在 `await getDynamicConfig_BLOCKS_ON_INIT`（阻塞等待 GrowthBook 初始化 ~10ms）之前執行。

### 工具搜索過濾

```typescript
// 源碼位置: src/services/api/claude.ts:1128-1172
const deferredToolNames = new Set<string>()
if (useToolSearch) {
  for (const t of tools) {
    if (isDeferredTool(t)) deferredToolNames.add(t.name)
  }
}
// 僅包含通過 tool_reference 塊發現的延遲加載工具
const discoveredToolNames = extractDiscoveredToolNames(messages)
filteredTools = tools.filter(tool => {
  if (!deferredToolNames.has(tool.name)) return true
  if (toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME)) return true
  return discoveredToolNames.has(tool.name)
})
```

這是動態工具加載系統。不必在每次請求時發送全部 42+ 工具（消耗大量 token），標記為 `deferred` 的工具只在通過對話歷史中的 `tool_reference` 塊被「發現」後才被包含。`ToolSearchTool` 本身始終包含，以便發現更多工具。

### paramsFromContext 閉包

`queryModel` 的核心是 `paramsFromContext` 閉包（約 190 行），它構建完整的 API 請求。它是閉包而非獨立函數，因為它捕獲了整個請求構建上下文（消息、系統提示、工具、betas）：

```typescript
// 源碼位置: src/services/api/claude.ts:1538-1729
const paramsFromContext = (retryContext: RetryContext) => {
  const betasParams = [...betas]
  // ... 配置 effort、task budget、thinking、context management
  // ... 鎖存 fast_mode、afk_mode、cache_editing headers
  return {
    model: normalizeModelStringForAPI(options.model),
    messages: addCacheBreakpoints(messagesForAPI, ...),
    system, tools: allTools, betas: betasParams,
    metadata: getAPIMetadata(),
    max_tokens: maxOutputTokens, thinking,
    // ... speed, context_management, output_config
  }
}
```

為什麼要多次調用？它分別用於日誌記錄（fire-and-forget）、實際 API 請求和非流式降級重試。`RetryContext` 參數允許重試循環在上下文溢出錯誤縮小可用輸出預算時覆蓋 `maxTokensOverride`。

### Beta Header 鎖存

```typescript
// 源碼位置: src/services/api/claude.ts:1642-1689
// Fast mode：header 鎖存保持會話穩定（緩存安全），
// 但 speed='fast' 保持動態，使冷卻期仍能抑制實際的快速模式請求而不改變緩存鍵。
if (fastModeHeaderLatched && !betasParams.includes(FAST_MODE_BETA_HEADER)) {
  betasParams.push(FAST_MODE_BETA_HEADER)
}
```

鎖存模式看似簡單，實則解決了一個關鍵的成本問題：prompt cache 鍵包含 beta headers。如果 `fast_mode` 在會話中途開關切換，每次切換都會使緩存失效。系統提示約 20K token，單次緩存未命中的成本遠超提示本身。鎖存確保 header 一旦激活就保持整個會話——`speed='fast'` 參數仍然動態切換以控制行為，但緩存鍵保持穩定。

---

## 3. 重試策略引擎

`withRetry.ts`（823 行）為每個 API 調用包裝了精密的重試狀態機：

```typescript
// 源碼位置: src/services/api/withRetry.ts:170-178
export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (client: Anthropic, attempt: number, context: RetryContext) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
```

`AsyncGenerator` 返回類型是關鍵設計選擇：調用者在重試之間獲得中間 `SystemAPIErrorMessage` 事件，UI 將其渲染為「X 秒後重試...」狀態消息。

### 重試決策矩陣

| 錯誤 | 策略 | 原因 |
|------|------|------|
| **429 速率限制** | 等待 `retry-after`，或快速模式冷卻 | 遵守服務器指令 |
| **529 過載** | 最多 3 次重試 → 降級到 Sonnet | 防止級聯放大 |
| **401 未授權** | 強制刷新 OAuth token → 重試 | Token 可能已過期 |
| **403 Token 已撤銷** | `handleOAuth401Error()` → 重試 | 其他進程刷新了 token |
| **400 上下文溢出** | 減小 `max_tokens` → 重試 | 縮小輸出以適應上下文 |
| **ECONNRESET/EPIPE** | 禁用 keep-alive → 重試 | 檢測到過期的 socket |
| **非foreground 529** | 立即放棄 | 減少後端放大 |

### 前景查詢源白名單

```typescript
// 源碼位置: src/services/api/withRetry.ts:62-82
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread', 'sdk', 'agent:custom', 'agent:default',
  'compact', 'hook_agent', 'auto_mode', ...
])
```

這是一項關鍵的反放大措施。在容量級聯故障期間，每次重試將後端負載放大 3-10 倍。背景查詢（摘要、標題、分類器）遇到 529 時立即放棄——用戶永遠看不到它們失敗。只有用戶正在等待結果的前景查詢才會重試。

### 持久重試模式

```typescript
// 源碼位置: src/services/api/withRetry.ts:96-98
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000    // 最大退避 5 分鐘
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000 // 6 小時上限
const HEARTBEAT_INTERVAL_MS = 30_000                // 30 秒心跳
```

對於無人值守的 CI/CD 會話（`CLAUDE_CODE_UNATTENDED_RETRY`），重試循環無限運行。等待期間每 30 秒發出一次心跳 `SystemAPIErrorMessage`，防止宿主環境（Docker、CI 運行器）認為會話空閒並終止它。

---

## 4. 流式處理架構

### 為什麼使用原始 SSE 而非 SDK 流

```typescript
// 源碼位置: src/services/api/claude.ts:1818-1836
// 使用原始流代替 BetaMessageStream 以避免 O(n²) 的部分 JSON 解析
const result = await anthropic.beta.messages
  .create({ ...params, stream: true }, { signal, ... })
  .withResponse()
stream = result.data  // Stream<BetaRawMessageStreamEvent>
```

Anthropic SDK 的 `BetaMessageStream` 在每個 `input_json_delta` 事件上調用 `partialParse()`。對於長工具輸入，這會產生二次增長——每個 delta 都從頭重新解析累積的 JSON。Claude Code 繞過了這一點，直接消費原始 SSE 事件並手動累積內容塊。

### 流事件狀態機

```
message_start
  → 初始化 usage，捕獲 research 元數據
  → 記錄 TTFB（首字節時間）

content_block_start
  → 創建新的 block（text | thinking | tool_use | server_tool_use | connector_text）
  → 初始化累加器：text=''，thinking=''，input=''

content_block_delta
  → 增量追加：text_delta | input_json_delta | thinking_delta | signature_delta
  → 類型安全的累積（每種 delta 類型匹配其 block 類型）

content_block_stop
  → 構建完成的 content block
  → 解析 tool_use 輸入的累積 JSON：JSON.parse(accumulated)

message_delta
  → 更新 usage 計數器，捕獲 stop_reason

message_stop
  → 完成 AssistantMessage，yield 給調用者
```

### 空閒看門狗

```typescript
// 源碼位置: src/services/api/claude.ts:1874-1928
const STREAM_IDLE_TIMEOUT_MS = parseInt(...) || 90_000  // 默認 90 秒
const STREAM_IDLE_WARNING_MS = STREAM_IDLE_TIMEOUT_MS / 2  // 45 秒警告

streamIdleTimer = setTimeout(() => {
  streamIdleAborted = true
  releaseStreamResources()
}, STREAM_IDLE_TIMEOUT_MS)
```

靜默斷開的連接是 SSE 流的真實問題。SDK 的請求超時只覆蓋初始的 `fetch()`，不覆蓋流式 body。看門狗監控 chunk 間隔：45 秒時發出警告，90 秒時中止。沒有這個，掛起的流會無限期阻塞會話。

---

## 5. Prompt 緩存 —— 三層策略

```typescript
// 源碼位置: src/services/api/claude.ts:358-374
export function getCacheControl({ scope, querySource } = {}) {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}
```

| 層級 | TTL | 範圍 | 資格 |
|------|-----|------|------|
| **臨時** | 5 分鐘（默認） | 單用戶 | 所有人 |
| **1 小時** | 1h | 單用戶 | 訂閱者 + GrowthBook 白名單匹配 |
| **全局** | 5 分鐘 | 跨用戶 | MCP 工具穩定時的系統提示 |

### 1h TTL 資格與鎖存

```typescript
// 源碼位置: src/services/api/claude.ts:393-434
function should1hCacheTTL(querySource?: QuerySource): boolean {
  // 資格在首次評估時鎖存到 bootstrap state
  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible = process.env.USER_TYPE === 'ant' ||
      (isClaudeAISubscriber() && !currentLimits.isUsingOverage)
    setPromptCache1hEligible(userEligible)  // 鎖存！
  }
  // 白名單也鎖存，防止會話中途混用 TTL
  let allowlist = getPromptCache1hAllowlist()
  if (allowlist === null) {
    const config = getFeatureValue_CACHED_MAY_BE_STALE('tengu_prompt_cache_1h_config', {})
    allowlist = config.allowlist ?? []
    setPromptCache1hAllowlist(allowlist)  // 鎖存！
  }
  // 支持尾部 * 通配符的模式匹配
  return allowlist.some(pattern =>
    pattern.endsWith('*')
      ? querySource.startsWith(pattern.slice(0, -1))
      : querySource === pattern
  )
}
```

資格和白名單在首次評估時都鎖存到 bootstrap state。這防止了會話中途的超額翻轉（訂閱者用完配額）改變緩存 TTL——每次翻轉會造成 ~20K token 的服務端緩存失效懲罰。

---

## 6. 錯誤分類系統

`errors.ts`（1,208 行）是 API 目錄中最大的文件，為每種 API 失敗模式提供結構化的錯誤分類：

```typescript
// 源碼位置: src/services/api/errors.ts:85-96
export function parsePromptTooLongTokenCounts(rawMessage: string) {
  const match = rawMessage.match(
    /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i
  )
  return {
    actualTokens: match ? parseInt(match[1]!, 10) : undefined,
    limitTokens: match ? parseInt(match[2]!, 10) : undefined,
  }
}
```

### 錯誤分類層級

```
getAssistantMessageFromError(error, model)
  ├─ APIConnectionTimeoutError → "請求超時"
  ├─ ImageSizeError → "圖片太大"
  ├─ 熔斷開關消息 → "Opus 負載高，切換到 Sonnet"
  ├─ 429 速率限制
  │   ├─ 有統一 headers → getRateLimitErrorMessage(limits)
  │   └─ 無 headers → 通用 "請求被拒絕 (429)"
  ├─ prompt too long → PROMPT_TOO_LONG_ERROR_MESSAGE + errorDetails
  ├─ PDF 錯誤 → 太大 / 密碼保護 / 無效
  ├─ 圖片超限 / 多圖限制 → 尺寸錯誤消息
  ├─ tool_use/tool_result 不匹配 → 併發錯誤 + /rewind 提示
  ├─ 組織已禁用 → 過期 API 密鑰指引
  └─ （默認）→ 格式化的 API 錯誤字符串
```

錯誤系統身兼雙職：它為終端 UI 提供用戶可讀消息，同時為響應式壓縮的重試邏輯提供機器可讀的 `errorDetails` 字符串。`getPromptTooLongTokenGap()` 從 `errorDetails` 解析實際值與限制值的差距，讓壓縮系統在一次重試中跳過多個消息組，而不是逐個剝離。

---

## 7. GrowthBook 特性開關

`growthbook.ts`（1,156 行）集成了 GrowthBook 特性開關平臺，作為 Claude Code 的遠程配置骨幹。

### 兩種讀取模式

```typescript
// 非阻塞：立即返回緩存/過期值
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(feature, defaultValue): T {
  // 優先級：環境變量覆蓋 → 配置覆蓋 → 內存載荷 → 磁盤緩存 → 默認值
}

// 阻塞：等待 GrowthBook 初始化完成
export async function getDynamicConfig_BLOCKS_ON_INIT<T>(feature, defaultValue): Promise<T> {
  const growthBookClient = await initializeGrowthBook()  // 阻塞 ~10ms
}
```

`CACHED_MAY_BE_STALE` 是熱路徑首選——在渲染循環、權限檢查和模型選擇中每次會話調用數百次。它首先從內存 Map 讀取，然後回退到磁盤緩存（`~/.claude.json`）。`BLOCKS_ON_INIT` 保留給關鍵路徑決策，如熔斷開關，在這些場景中錯誤答案會造成嚴重後果。

### 用戶屬性與定向

```typescript
// 源碼位置: src/services/analytics/growthbook.ts:32-47
export type GrowthBookUserAttributes = {
  id: string                    // 設備 ID（跨會話穩定）
  sessionId: string             // 單次會話唯一 ID
  platform: 'win32' | 'darwin' | 'linux'
  organizationUUID?: string     // 企業組織定向
  userType?: string             // 'ant'（內部）| 'external'
  subscriptionType?: string     // Pro, Max, Enterprise 等
  rateLimitTier?: string        // 速率限制等級（漸進發布）
  appVersion?: string           // 按版本門控特性
}
```

### Remote Eval 變通方案

GrowthBook 的遠程評估模式在服務端評估 flag（讓定向規則保持私密），但 SDK 返回 `{ value: ... }` 而期望 `{ defaultValue: ... }`。Claude Code 通過 `processRemoteEvalPayload()` 變通處理，將值緩存到內存 Map 和磁盤中，確保跨進程穩定性。

---

## 8. LSP 集成 —— 閉包工廠模式

LSP（語言服務器協議）集成展示了 Claude Code 對閉包工廠優於類的偏好：

```typescript
// 源碼位置: src/services/lsp/LSPServerManager.ts:59-65
export function createLSPServerManager(): LSPServerManager {
  const servers: Map<string, LSPServerInstance> = new Map()
  const extensionMap: Map<string, string[]> = new Map()
  const openedFiles: Map<string, string> = new Map()
  // ... 360 行閉包方法
  return { initialize, shutdown, getServerForFile, ensureServerStarted, sendRequest, ... }
}
```

### 基於文件擴展名的路由

當 Claude Code 讀取或編輯文件時，LSP 管理器根據文件擴展名將通知路由到正確的語言服務器。

### 代際計數器

```typescript
// 源碼位置: src/services/lsp/manager.ts:32-36
let initializationGeneration = 0

const currentGeneration = ++initializationGeneration
lspManagerInstance.initialize().then(() => {
  if (currentGeneration === initializationGeneration) {
    initializationState = 'success'
  }
})
```

這解決了一個微妙的競態條件：如果在前一次初始化仍在進行時調用 `reinitializeLspServerManager()`，代際計數器確保過期初始化的 `.then()` 處理器被靜默丟棄。

---

## 9. MCP 集成要點

MCP（模型上下文協議）子系統在[第 4 集：插件系統](04-plugin-system.md)中詳細介紹，但其服務層方面值得在此提及。

### 六種傳輸類型

```typescript
// 源碼位置: src/services/mcp/types.ts
export const TransportSchema = z.enum([
  'stdio',    // 本地子進程（stdin/stdout）—— 最常見
  'sse',      // Server-Sent Events（遠程）
  'http',     // Streamable HTTP（MCP 2025 規範）
  'ws',       // WebSocket（IDE 擴展）
  'sdk',      // 進程內 SDK 控制傳輸
  'sse-ide',  // 通過 IDE 橋接的 SSE
])
```

MCP 連接生命週期通過 React Context 管理，支持在不重啟會話的情況下熱重載 MCP 服務器。React Compiler 使用 `_c(6)` memo 插槽優化此組件。

---

## 可遷移設計模式

> 以下模式可直接應用於其他 Agentic 系統或 CLI 工具。

### 模式 1: 會話穩定鎖存

**場景:** 特性開關或 beta header 控制的行為同時也是緩存鍵的一部分。
**問題:** 會話中途切換標誌會使緩存失效，造成嚴重的成本放大。
**實踐:** 在首次評估時鎖存標誌值。鎖存在 bootstrap state 中存儲布爾值；一旦設為 `true`，在會話內不再恢復。

**Claude Code 將此應用於:** `fast_mode`、`afk_mode`、`cache_editing` beta headers，1h prompt cache 資格，以及 GrowthBook 白名單。

### 模式 2: AsyncGenerator 重試管道

**場景:** 長時間運行的操作需要重試邏輯，但調用者也需要重試狀態的可見性。
**問題:** 傳統重試包裝器阻塞直到成功或最終失敗。調用者無法顯示「重試中...」UI。
**實踐:** 將重試包裝器設為 `AsyncGenerator`，在嘗試之間 `yield` 狀態事件，最終 `return` 結果。

### 模式 3: 帶代際計數器的閉包工廠

**場景:** 可能需要重新初始化的單例服務（如插件刷新後）。
**問題:** 異步初始化可能重疊：`init_1` 啟動，`reinit` 啟動 `init_2`，但 `init_1` 後完成並覆蓋 `init_2` 的狀態。
**實踐:** 每次初始化時遞增代際計數器。`.then()` 回調在更新狀態前檢查其代際是否仍為當前值。

### 模式 4: foreground/background重試分類

**場景:** 服務遭遇級聯故障（如 API 過載）。
**問題:** 重試所有查詢會按每層重試放大過載 3-10 倍。
**實踐:** 維護一個「前景」查詢源白名單（用戶在等待）。背景查詢（摘要、分類器、標題）在過載錯誤時立即放棄。這是設計層面的反放大。

---

## 源碼座標

| 組件 | 路徑 | 行數 | 核心函數 |
|------|------|------|----------|
| 客戶端工廠 | `services/api/client.ts` | 390 | `getAnthropicClient()` |
| 查詢引擎 | `services/api/claude.ts` | 3,420 | `queryModel()` L1017 |
| 重試引擎 | `services/api/withRetry.ts` | 823 | `withRetry()` L170 |
| 錯誤系統 | `services/api/errors.ts` | 1,208 | `getAssistantMessageFromError()` L425 |
| 緩存控制 | `services/api/claude.ts` | — | `getCacheControl()` L358 |
| GrowthBook | `services/analytics/growthbook.ts` | 1,156 | `getFeatureValue_CACHED_MAY_BE_STALE()` L734 |
| LSP 管理器 | `services/lsp/LSPServerManager.ts` | 421 | `createLSPServerManager()` L59 |
| LSP 單例 | `services/lsp/manager.ts` | 290 | `initializeLspServerManager()` L145 |
| MCP 客戶端 | `services/mcp/client.ts` | ~3,000 | MCP 生命週期管理 |
| 分析 | `services/analytics/index.ts` | — | `logEvent()`，PII 保護 |

---

*服務層是 Claude Code 的雄心與現實世界故障模式交匯的地方。下一集：[第 16 集 —— 基礎設施與配置系統](16-infrastructure-config.md)*

[← 第 14 集 —— UI 與狀態管理](14-ui-state-management.md)
