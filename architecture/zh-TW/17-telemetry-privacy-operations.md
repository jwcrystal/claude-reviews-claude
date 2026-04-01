# 17 — 遙測、隱私與運營控制：生產環境的暗面

> 🌐 **語言**: [English →](../17-telemetry-privacy-operations.md) | 中文版

> **範圍**: `services/analytics/`（9 個模塊，~148KB）、`utils/undercover.ts`、`utils/attribution.ts`、`utils/commitAttribution.ts`、`utils/fastMode.ts`、`services/remoteManagedSettings/`、`constants/prompts.ts`、`buddy/`、`voice/`、`tasks/DreamTask/`
>
> **一句話**: 你看不見的生產基礎設施——雙通道遙測管道、模型代號隱匿、遠程緊急開關，以及隱藏在編譯時門控背後的未來功能。

---

## 目錄

1. [雙通道遙測管道](#1-雙通道遙測管道)
2. [數據採集全景：究竟收集了什麼](#2-數據採集全景究竟收集了什麼)
3. [退出困境：用戶能否關閉遙測](#3-退出困境用戶能否關閉遙測)
4. [模型代號體系](#4-模型代號體系)
5. [Feature Flag 混淆命名](#5-feature-flag-混淆命名)
6. [臥底模式：隱匿 AI 署名](#6-臥底模式隱匿-ai-署名)
7. [遠程控制與緊急開關](#7-遠程控制與緊急開關)
8. [內外有別的雙層體驗](#8-內外有別的雙層體驗)
9. [未來路線圖：源碼中的證據](#9-未來路線圖源碼中的證據)

---

## 1. 雙通道遙測管道

**源碼座標**: `src/services/analytics/`（9 個文件，合計 ~148KB）

每一次工具調用、每一次 API 請求、每一次會話啟動——都會產生遙測事件，流經**雙通道管道**。一條通道直連 Anthropic 自有後端；另一條通向第三方可觀測性平臺。兩者共同構成了 CLI 工具領域最全面的分析系統之一。

### 1.1 通道 A：第一方直連（Anthropic 自有）

```typescript
// 源碼: src/services/analytics/firstPartyEventLogger.ts:300-302
const DEFAULT_LOGS_EXPORT_INTERVAL_MS = 10000    // 10 秒批量刷新
const DEFAULT_MAX_EXPORT_BATCH_SIZE = 200         // 每批最多 200 事件
const DEFAULT_MAX_QUEUE_SIZE = 8192               // 內存隊列上限 8K
```

第一方管道使用 **OpenTelemetry 的 `LoggerProvider`**——不是全局實例（那個服務於客戶的 OTLP 遙測），而是一個專用的內部 Provider。事件被序列化為 Protocol Buffers，發往：

```
POST https://api.anthropic.com/api/event_logging/batch
```

**容錯機制極為激進**。導出器（`FirstPartyEventLoggingExporter`，27KB）實現了：
- 二次退避重試，可配置最大重試次數
- **磁盤持久化**——失敗的批次寫入 `~/.claude/telemetry/`，進程崩潰後下次啟動時自動重試
- 批次配置可通過 GrowthBook（`tengu_1p_event_batch_config`）遠程調整，即 Anthropic 無需發版即可修改刷新間隔、批次大小甚至目標端點

**熱插拔安全性**值得關注：

```typescript
// 源碼: src/services/analytics/firstPartyEventLogger.ts:396-449
// 當 GrowthBook 在會話中途更新批次配置時：
// 1. 先將 logger 置空——併發調用在守衛處 bail out
// 2. forceFlush() 排空舊處理器的緩衝區
// 3. 切換到新 Provider；舊的在後臺關閉
// 4. 磁盤持久化重試文件使用穩定鍵名(BATCH_UUID + sessionId)
//    新導出器自動接管舊導出器的失敗記錄
```

### 1.2 通道 B：Datadog（第三方可觀測性）

```typescript
// 源碼: src/services/analytics/datadog.ts:12-17
const DATADOG_LOGS_ENDPOINT = 'https://http-intake.logs.us5.datadoghq.com/api/v2/logs'
const DATADOG_CLIENT_TOKEN = 'pubbbf48e6d78dae54bceaa4acf463299bf'
const DEFAULT_FLUSH_INTERVAL_MS = 15000   // 15 秒刷新
const MAX_BATCH_SIZE = 100
```

Datadog 通道更加嚴格。只有 **64 種預批准事件類型**能通過白名單過濾。

**三種基數縮減技術**防止 Datadog 成本爆炸：

1. **MCP 工具名歸一化**：以 `mcp__` 開頭的工具統一折疊為 `"mcp"`
2. **模型名歸一化**：未知模型摺疊為 `"other"`
3. **用戶分桶**：通過 `SHA256(userId) % 30` 將用戶哈希到 30 個桶中，實現近似唯一用戶告警

### 1.3 事件採樣：GrowthBook 控制的音量旋鈕

```typescript
// 源碼: src/services/analytics/firstPartyEventLogger.ts:38-85
export function shouldSampleEvent(eventName: string): number | null {
  const config = getEventSamplingConfig()           // 來自 GrowthBook
  const eventConfig = config[eventName]
  if (!eventConfig) return null                     // 無配置 → 100% 採集
  const sampleRate = eventConfig.sample_rate
  if (sampleRate >= 1) return null                  // 1.0 → 全量採集
  if (sampleRate <= 0) return 0                     // 0.0 → 全量丟棄
  return Math.random() < sampleRate ? sampleRate : 0  // 概率採樣
}
```

> → 交叉引用: [第 16 集: 基礎設施](16-infrastructure-config.md) 瞭解 GrowthBook 集成細節

---

## 2. 數據採集全景：究竟收集了什麼

**源碼座標**: `src/services/analytics/metadata.ts`（33KB——最大的分析文件）

每個遙測事件攜帶三層元數據，由 `getEventMetadata()` 組裝：

### 2.1 第一層：環境指紋

```
┌─────────────────────────────────────────────────────────────────┐
│  環境指紋（14+ 字段）                                            │
├──────────────────┬──────────────────────────────────────────────┤
│ 運行時            │ platform, arch, nodeVersion                  │
│ 終端              │ 終端類型 (iTerm2 / Terminal.app / ...)        │
│ 開發環境          │ 已安裝的包管理器和運行時                        │
│ CI/CD            │ CI 檢測, GitHub Actions 元數據                 │
│ 操作系統          │ WSL 版本, Linux 發行版, 內核版本                │
│ 版本控制          │ VCS 類型                                      │
│ Claude Code      │ 版本號, 構建時間戳                              │
└──────────────────┴──────────────────────────────────────────────┘
```

### 2.2 第二層：進程健康指標

```
┌─────────────────────────────────────────────────────────────────┐
│  進程指標（8+ 指標）                                             │
├──────────────────┬──────────────────────────────────────────────┤
│ 計時              │ 進程運行時間                                   │
│ 內存              │ rss, heapTotal, heapUsed, external, arrays    │
│ CPU              │ 使用時間, 百分比                                │
└──────────────────┴──────────────────────────────────────────────┘
```

### 2.3 第三層：用戶與會話身份

```
┌─────────────────────────────────────────────────────────────────┐
│  用戶與會話追蹤                                                   │
├──────────────────┬──────────────────────────────────────────────┤
│ 模型              │ 當前活躍模型名                                 │
│ 會話              │ sessionId, parentSessionId                    │
│ 設備              │ deviceId（跨會話持久化）                        │
│ 賬戶              │ accountUUID, organizationUUID                 │
│ 訂閱              │ 套餐層級 (max, pro, enterprise, team)          │
│ 倉庫              │ 遠端 URL 哈希（SHA256，取前 16 字符）            │
└──────────────────┴──────────────────────────────────────────────┘
```

**倉庫指紋**值得關注——系統對遠端 URL 取 SHA256 後截斷為 16 位十六進制。這不是匿名化，而是**偽匿名化**。知道目標倉庫 URL 的人可以輕鬆計算哈希並匹配。

### 2.4 Bash 命令擴展名追蹤

當執行涉及 17 種特定命令（`rm`、`mv`、`cp`、`touch`、`mkdir`、`chmod`、`chown`、`cat`、`head`、`tail`、`sort`、`stat`、`diff`、`wc`、`grep`、`rg`、`sed`）的操作時，系統會提取並記錄參數中的**文件擴展名**，形成你的工作模式畫像。

---

## 3. 退出困境：用戶能否關閉遙測

**源碼座標**: `src/services/analytics/firstPartyEventLogger.ts:141-144`

### 3.1 分析功能何時禁用

```typescript
// 源碼: src/services/analytics/config.ts
// isAnalyticsDisabled() 僅在以下情況返回 true：
// 1. 測試環境 (NODE_ENV !== 'production')
// 2. 第三方雲供應商 (Bedrock, Vertex)
// 3. 全局遙測退出標誌
```

對於直連 Anthropic API 的用戶（絕大多數），`isAnalyticsDisabled()` 返回 `false`。**沒有設置面板、沒有 CLI 參數、沒有環境變量**能讓普通用戶在保持完整產品功能的同時禁用第一方事件記錄。

### 3.2 遠程關閉開關

諷刺的是，Anthropic **自己可以**遠程禁用分析——但這個能力不屬於用戶：

```typescript
// 源碼: src/services/analytics/sinkKillswitch.ts
const SINK_KILLSWITCH_CONFIG_NAME = 'tengu_frond_boric'
// GrowthBook 標誌，可遠程禁用分析通道
```

### 3.3 合規影響

（1）無用戶側退出機制、（2）持久化設備和會話追蹤、（3）倉庫指紋、（4）組織級識別——這四者組合創建的數據集完全落入 GDPR 第 6 條和 CCPA §1798.100 的管轄範圍。

> → 設計模式: **失敗時仍投遞**（stale-while-error）策略——磁盤持久化 + 重試優先保證投遞完整性，而非用戶控制權。

---

## 4. 模型代號體系

**源碼座標**: `src/utils/undercover.ts:48-49`、`src/constants/prompts.ts`、`src/migrations/migrateFennecToOpus.ts`、`src/buddy/types.ts`

Anthropic 為內部模型版本分配**動物代號**——源碼揭示了具體代號、演化譜系，以及為防止洩露而構建的精密機制。

### 4.1 四個已知代號

| 代號 | 動物 | 角色 | 證據 |
|------|------|------|------|
| **Capybara** | 水豚 | Sonnet 系列，當前 v8 | 模型字符串中的 `capybara-v2-fast[1m]` |
| **Tengu** | 天狗 | 產品/遙測前綴 | 250+ 分析事件和功能標誌均使用 `tengu_*` |
| **Fennec** | 耳廓狐 | Opus 4.6 的前身 | 遷移腳本: `fennec-latest → opus` |
| **Numbat** | 袋食蟻獸 | 下一代未發佈模型 | 註釋: `"Remove this section when we launch numbat"` |

### 4.2 代號保護機制

三層防線阻止代號洩露到外部構建中：

**第一層: 構建時掃描器** — `scripts/excluded-strings.txt` 包含構建輸出中會被 CI 掃描的模式，匹配則構建失敗。

**第二層: 運行時混淆** — 代號在用戶可見字符串中被主動遮蔽（`cap***** -v2-fast`）。

**第三層: 源碼級碰撞規避** — Buddy 寵物系統的"capybara"物種名與模型代號掃描器衝突。解決方案：運行時用 `String.fromCharCode` 逐字符編碼。

### 4.3 Capybara v8：五個已記錄的行為缺陷

| # | 缺陷 | 影響 | 源碼位置 |
|---|------|------|---------|
| 1 | 停止序列誤觸發 | 當 `<functions>` 出現在提示詞尾部時約 10% 概率 | `prompts.ts` |
| 2 | 空 tool_result 零輸出 | 收到空白工具結果時模型不生成任何內容 | `toolResultStorage.ts:281` |
| 3 | 過度註釋 | 需要專門的反註釋提示詞補丁 | `prompts.ts:204` |
| 4 | 高錯誤聲稱率 | 29-30% FC 率 vs Capybara v4 的 16.7% | `prompts.ts:237` |
| 5 | 驗證不充分 | 需要"徹底性反制"提示詞注入 | `prompts.ts:210` |

代碼庫包含 **8+ 個 `@[MODEL LAUNCH]` 標記**，涵蓋：默認模型名、家族 ID、知識截止日期、定價表、上下文窗口配置等。

---

## 5. Feature Flag 混淆命名

**源碼座標**: `src/services/analytics/growthbook.ts`（41KB）

### 5.1 Tengu 命名約定

每個功能標誌和分析事件遵循 `tengu_<詞1>_<詞2>` 的命名模式，詞彙對從受限詞庫中選取——對內部人員可記憶，對外部觀察者不透明。

| 標誌名 | 解碼後的用途 | 類別 |
|--------|-------------|------|
| `tengu_frond_boric` | 分析通道緊急關閉 | 緊急開關 |
| `tengu_amber_quartz_disabled` | 語音模式緊急關閉 | 緊急開關 |
| `tengu_turtle_carbon` | Ultrathink 門控 | 功能門控 |
| `tengu_marble_sandcastle` | 快速模式（Penguin）門控 | 功能門控 |
| `tengu_onyx_plover` | Auto-Dream（後臺記憶）| 功能門控 |
| `tengu_event_sampling_config` | 按事件採樣率 | 配置 |
| `tengu_1p_event_batch_config` | 1P 批處理器配置 | 配置 |
| `tengu_ant_model_override` | 內部模型覆蓋 | 內部 |

### 5.2 三層標誌解析架構

```
┌─────────────────────────────────────────────────────────────────┐
│  第 1 層: 編譯時死代碼消除 (DCE)                                  │
│  機制: feature('FLAG_NAME') via bun:bundle                      │
│  效果: 代碼分支在構建時被完全移除                                   │
├─────────────────────────────────────────────────────────────────┤
│  第 2 層: 運行時環境變量檢查                                      │
│  機制: process.env.USER_TYPE === 'ant'                          │
│  效果: 代碼存在但對外部用戶被跳過                                   │
├─────────────────────────────────────────────────────────────────┤
│  第 3 層: 運行時 GrowthBook 標誌                                  │
│  機制: getFeatureValue('tengu_*') via GrowthBook SDK            │
│  效果: 可按用戶、按會話、按實驗動態變更                              │
└─────────────────────────────────────────────────────────────────┘
```

部分功能使用**雙重門控**——第 1 層編譯時門控 + 第 3 層運行時標誌。在外部構建中，`feature('ULTRATHINK')` 為 `false`，整個函數體被死代碼消除。

### 5.3 通道緊急開關的循環依賴

`tengu_frond_boric` 的實現揭示了一個**循環依賴陷阱**：GrowthBook 初始化調用 `is1PEventLoggingEnabled()`，後者如果調用 `isSinkKilled()` 又會調用 GrowthBook——無限遞歸。解決方案：在**每個事件分發點**檢查緊急開關，而非在全局啟用檢查中。

> → 交叉引用: [第 16 集: 基礎設施](16-infrastructure-config.md) §1.3

---

## 6. 臥底模式：隱匿 AI 署名

**源碼座標**: `src/utils/undercover.ts`（90 行）、`src/utils/attribution.ts`（394 行）

當 Anthropic 員工使用 Claude Code 向開源倉庫貢獻代碼時，一套專用系統會自動激活，擦除所有 AI 參與痕跡。

### 6.1 激活邏輯

```typescript
// 源碼: src/utils/undercover.ts:28-37
export function isUndercover(): boolean {
  if (process.env.USER_TYPE === 'ant') {          // 僅限 Anthropic 員工
    if (isEnvTruthy(process.env.CLAUDE_CODE_UNDERCOVER)) return true  // 強制開啟
    return getRepoClassCached() !== 'internal'    // 非內部倉庫 → 自動開啟
  }
  return false  // 外部用戶: 始終關閉（生產構建中被 DCE）
}
```

關鍵設計決策：**沒有強制關閉選項**。如果系統無法確認當前倉庫在 Anthropic 內部白名單上，臥底模式自動激活。

### 6.2 臥底提示詞

激活後，模型收到七條明確的隱匿指令，禁止在 commit 消息和 PR 中出現：
- 內部模型代號（Capybara、Tengu 等動物名）
- 未發佈模型版本號
- 內部倉庫或項目名稱
- 內部工具、Slack 頻道或短鏈接
- "Claude Code"或任何 AI 相關表述
- Co-Authored-By 行或任何其他署名

### 6.3 署名擦除

```typescript
// 源碼: src/utils/attribution.ts:52-55
export function getAttributionTexts(): AttributionTexts {
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    return { commit: '', pr: '' }  // 空字符串 = 無署名
  }
}
```

正常模式下 commit 附帶 `Co-Authored-By: Claude Opus 4.6`，PR 附帶 `🤖 Generated with Claude Code`。臥底模式下兩者均返回空字符串。

### 6.4 增強版 PR 署名（非臥底模式）

非臥底狀態下，署名系統生成豐富的統計信息：

```
🤖 Generated with Claude Code (93% 3-shotted by claude-opus-4-5, 2 memories recalled)
```

包含：Claude 代碼貢獻百分比、提示詞輪次（N-shotted）、模型名、記憶文件訪問次數。

### 6.5 倫理思考

臥底模式引發關於 AI 透明度的根本性問題：貢獻者真實性、開源許可證合規性、社區信任、以及與 EU AI Act 第 50 條的潛在衝突。

> → 設計模式: **失敗時隱匿**（Fail-safe concealment）——不確定時默認隱藏，需顯式白名單才會暴露。

---

## 7. 遠程控制與緊急開關

**源碼座標**: `src/services/remoteManagedSettings/`（5 個文件，~43KB）

Claude Code 不僅是本地工具——它維持著與 Anthropic 服務器的持久連接，Anthropic 可以遠程改變其行為、執行策略或關閉功能。

### 7.1 遠程託管設置

```typescript
// 源碼: src/services/remoteManagedSettings/index.ts:52-54
const SETTINGS_TIMEOUT_MS = 10000     // 10 秒超時
const DEFAULT_MAX_RETRIES = 5         // 最多 5 次重試
const POLLING_INTERVAL_MS = 3600000   // 每小時後臺輪詢
```

獲取生命週期實現了 **stale-while-revalidate** 語義：
1. **啟動時緩存優先**：有磁盤緩存則立即應用
2. **後臺獲取**：5 次指數退避重試
3. **ETag 緩存**：SHA256 校驗和支持 HTTP 304
4. **每小時輪詢**：後臺定時檢查設置變更
5. **失敗開放**：所有獲取失敗則繼續使用陳舊緩存

### 7.2 "接受或退出"對話框

當遠程設置包含"危險"變更時，出現**阻塞式安全對話框**：

```typescript
// 源碼: src/services/remoteManagedSettings/securityCheck.tsx:67-73
export function handleSecurityCheckResult(result: SecurityCheckResult): boolean {
  if (result === 'rejected') {
    gracefulShutdownSync(1)   // 退出碼 1 —— 進程終止
    return false
  }
  return true
}
```

用戶只有兩個選擇：接受新設置，或進程以退出碼 1 終止。沒有"稍後再說"選項。在非交互模式（CI/CD）下，安全檢查被完全跳過——危險設置靜默應用。

### 7.3 六大緊急開關

| # | 開關 | 機制 | 觸發效果 |
|---|------|------|---------|
| 1 | **權限體系旁路** | `bypassPermissionsKillswitch.ts` | 禁用整個權限系統 |
| 2 | **自動模式斷路器** | `autoModeDenials.ts` | 緊急中斷自主執行 |
| 3 | **快速模式(Penguin)** | `tengu_marble_sandcastle` + API | 切換到更便宜的模型 |
| 4 | **分析通道** | `tengu_frond_boric` | 禁用 Datadog/1P 日誌 |
| 5 | **代理團隊** | `tengu_amber_flint` | 門控多代理協作 |
| 6 | **語音模式** | `tengu_amber_quartz_disabled` | 緊急禁用語音輸入 |

### 7.4 Penguin 模式（快速模式遠程控制）

Anthropic 可遠程將用戶從昂貴模型切換到更便宜的替代品。結合 GrowthBook A/B 分配和獨立緊急開關，用戶請求所使用的模型可在會話中途根據 Anthropic 的運營決策而改變。

> → 交叉引用: [第 16 集: 基礎設施](16-infrastructure-config.md) 瞭解五層設置合併系統

---

## 8. 內外有別的雙層體驗

**源碼座標**: `src/constants/prompts.ts`、`src/tools/`、`src/commands.ts`

Anthropic 員工與外部用戶體驗著根本不同版本的 Claude Code。差異橫跨提示詞、工具、命令和模型行為。

### 8.1 提示詞差異：六個維度

| 維度 | 外部用戶 | Anthropic 員工 (`ant`) |
|------|---------|----------------------|
| **輸出風格** | 標準格式 | GrowthBook 覆蓋 |
| **錯誤聲稱緩解** | Capybara v8 補丁 | 同上 + 數值錨定提示 |
| **驗證機制** | 標準驗證 | 驗證代理 + 徹底性反制 |
| **註釋控制** | 標準指導 | 專用反過度註釋補丁 |
| **主動糾錯** | 標準行為 | 增強型"果斷性反制"(PR #24302) |
| **模型感知** | 無法看到代號 | 可見內部模型名 + 調試工具 |

### 8.2 內部專用工具（5 個）

| 工具 | 用途 | 門控層級 |
|------|------|---------|
| **REPLTool** | 內聯代碼執行 | 第 2 層（環境變量） |
| **TungstenTool** | 內部調試診斷 | 第 2 層 |
| **VerifyPlanTool** | 計劃驗證代理 | 第 3 層（`tengu_hive_evidence`） |
| **SuggestBackgroundPR** | 後臺 PR 建議 | 第 1 層（`feature()`） |
| **Nested Agent** | 進程內子代理 | 第 2 層 |

### 8.3 隱藏命令（7 個）

| 命令 | 用途 | 訪問權限 |
|------|------|---------|
| `/btw` | 旁白注入 | 僅內部 |
| `/stickers` | 終端貼紙/藝術 | 可解鎖 |
| `/thinkback` | 回放上次思維鏈 | 調試模式 |
| `/effort` | 調整思維深度 | 僅內部 |
| `/buddy` | 召喚虛擬夥伴（見 §9） | `feature()` 門控 |
| `/good-claude` | 正向強化 | 僅內部 |
| `/bughunter` | 激活 Bug 獵手模式 | 僅內部 |

---

## 9. 未來路線圖：源碼中的證據

**源碼座標**: `src/tasks/DreamTask/`、`src/buddy/`、`src/voice/`、`src/coordinator/`

源碼包含大量編譯時門控但架構上已完整的功能實現。

### 9.1 Numbat：下一代模型

`prompts.ts` 中的 `@[MODEL LAUNCH]` 標記引用了 `opus-4-7` 和 `sonnet-4-8` 等模型 ID，強烈暗示 Numbat 是下一代主要模型家族的代號。

### 9.2 KAIROS：自主代理模式

`feature('KAIROS')` 背後存在完整的自主執行模式——基於心跳的 tick 驅動、焦點感知、OS 推送通知、GitHub PR 訂閱、定時休眠/喚醒。

### 9.3 語音模式

`feature('VOICE_MODE')` 背後：按鍵說話、WebSocket 實時語音轉文字（21KB）、mTLS 認證、OAuth 限制、技術術語自定義詞表。

### 9.4 Buddy 虛擬夥伴系統

最具趣味性的功能——完整的虛擬寵物系統（6 個文件，~76KB）：

**18 個物種**（全部通過 `String.fromCharCode` 編碼以規避代號掃描器）：
```
duck, goose, blob, cat, dragon, octopus, owl, penguin,
turtle, snail, ghost, axolotl, capybara, cactus, robot,
rabbit, mushroom, chonk
```

**5 個稀有度等級**（加權分佈）：Common(60%) → Uncommon(25%) → Rare(10%) → Epic(4%) → Legendary(1%)

**閃光變體**：~1% 概率，由 `hash(userId)` 確定性決定，防止用戶"刷號"。

每個夥伴有**靈魂**（模型生成的名字和性格，存儲在配置中）和**骨架**（物種、稀有度、屬性，每次讀取從 `hash(userId)` 重新生成）——確保用戶無法通過編輯配置文件升級到傳說級。

### 9.5 未發佈工具（11 個）

| 工具 | 用途 | 門控 |
|------|------|------|
| SleepTool | 定時暫停/恢復 | `feature('KAIROS')` |
| PushNotificationTool | OS 通知推送 | `feature('KAIROS')` |
| SubscribePRTool | GitHub PR 訂閱 | `feature('KAIROS')` |
| DaemonTool | 後臺進程管理 | `feature('DAEMON')` |
| CoordinatorTool | 多代理協調 | `feature('COORDINATOR_MODE')` |
| MorerightTool | 上下文窗口擴展 | `feature('MORERIGHT')` |
| DreamConsolidationTool | 後臺記憶整合 | `feature('AUTO_DREAM')` |
| DxtTool | DXT 插件打包 | `feature('DXT')` |
| UltraplanTool | 高級多步規劃 | `feature('ULTRAPLAN')` |
| VoiceInputTool | 語音轉文字輸入 | `feature('VOICE_MODE')` |
| BuddyTool | 虛擬夥伴召喚 | `feature('BUDDY')` |

### 9.6 三大戰略方向

未發佈功能聚集為三個清晰的戰略方向：

1. **自主代理**（KAIROS + Dream + Coordinator）：從被動工具邁向主動代理
2. **多模態輸入**（Voice + Computer Use 增強）：突破純文本交互
3. **社交/情感**（Buddy + Stickers + Team Memory）：創建參與循環和團隊協作

這些方向表明 Claude Code 的長期願景不是"更好的代碼補全"，而是"具備社交功能的自主軟件工程代理"。

---

## 源碼座標彙總

| 組件 | 關鍵文件 | 規模 |
|------|---------|:----:|
| 分析管道 | `services/analytics/`（9 個文件） | 148KB |
| 臥底模式 | `utils/undercover.ts` | 3.7KB |
| 署名系統 | `utils/attribution.ts` + `commitAttribution.ts` | 44KB |
| 遠程設置 | `services/remoteManagedSettings/`（5 個文件） | 43KB |
| 快速模式 | `utils/fastMode.ts` | 18KB |
| GrowthBook | `services/analytics/growthbook.ts` | 41KB |
| Buddy 系統 | `buddy/`（6 個文件） | 76KB |
| 語音系統 | `voice/` + `services/voice*.ts` | 45KB |

---

## 可複用設計模式

| 模式 | 應用場景 | 要點 |
|------|---------|------|
| **雙通道分析** | 1P + Datadog | 內外分析通道使用不同保留策略 |
| **基數縮減** | 用戶分桶、MCP 歸一化 | 哈希分桶 (mod N) 實現近似唯一用戶計數 |
| **熱插拔重配置** | 1P 日誌器重建 | 置空守衛 → 刷新 → 切換 → 後臺關閉 |
| **失敗時隱匿** | 臥底模式 | 默認最大程度隱匿；需顯式白名單才暴露 |
| **接受或退出** | 安全對話框 | 無"稍後再說"防止無限期推遲安全決策 |
| **三層功能門控** | DCE + env + GrowthBook | 編譯時、構建時、運行時三層縱深防禦 |
| **代號碰撞規避** | Buddy 物種編碼 | `String.fromCharCode` 防止靜態掃描器誤報 |
| **陳舊時仍驗證** | 遠程設置 | 緩存優先啟動 + 後臺刷新最小化用戶可感知延遲 |

---

> **下一集**: [第 00 集: 總綱 — 三萬英尺高空](00-overview.md)
>
> **上一集**: [第 16 集: 基礎設施與配置](16-infrastructure-config.md)

