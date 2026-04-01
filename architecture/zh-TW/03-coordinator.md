> 🌐 **語言**: [English →](../03-coordinator.md) | 中文

# 多智能體協調器 (Coordinator)：Claude Code 如何編排並行工作線程

> **源文件**：`coordinator/coordinatorMode.ts` (370 行), `tools/AgentTool/` (14 個文件), `tools/SendMessageTool/`, `tools/TeamCreateTool/`, `tools/TeamDeleteTool/`, `tools/TaskStopTool/`

## 太長不看，一句話總結

Claude Code 不僅僅是一個單智能體（Single-agent）的命令行工具。它擁有一個隱藏的**協調者模式 (Coordinator mode)**，可以將其轉化為一個多智能體編排器 —— 負責分發並行工作智能體、在它們之間路由消息並彙總結果。這一功能被隱藏在編譯時標誌之後，在官方文檔中並無提及。

---

## 1. 兩種模式

Claude Code 運行在兩種模式之一，由 `bun:bundle` 特性標誌控制：

| 模式 | 行為 |
|------|----------|
| **Normal (普通模式)** | 具有完整工具訪問權限的單個智能體 —— 標準的 CLI 體驗。 |
| **Coordinator (協調者模式)** | 充當編排器，分發 Worker，本身無法直接使用文件或 Bash 工具。 |

模式在啟動時由編譯標誌 `COORDINATOR_MODE`（編譯期開關）和環境變量 `CLAUDE_CODE_COORDINATOR_MODE`（運行期開關）共同決定。

---

## 2. 架構：協調者與工作線程 (Worker)

```mermaid
graph TB
    USER["👤 用戶"] -->|"自然語言"| COORD["🧠 協調者 (Coordinator)<br/>(編排模式)"]

    COORD -->|"AgentTool"| W1["🔧 Worker 1<br/>研究任務"]
    COORD -->|"AgentTool"| W2["🔧 Worker 2<br/>實現任務"]
    COORD -->|"AgentTool"| W3["🔧 Worker 3<br/>驗證任務"]

    W1 -->|"task-notification"| COORD
    W2 -->|"task-notification"| COORD
    W3 -->|"task-notification"| COORD

    COORD -->|"SendMessageTool"| W1
    COORD -->|"TaskStopTool"| W2
```

### 核心原則：完全的上下文隔離
**Worker 無法看到協調者的對話歷史。** 每個 Worker 啟動時都是零上下文的。協調者必須編寫自包含的 Prompt，包括 Worker 所需的一切：文件路徑、行號、錯誤信息以及“完成”的標準。

這種隔離是架構層面強制執行的，而非僅僅是約定。

### 協調者的工具箱
在協調者模式下，智能體的工具集受到嚴格限制：
- `AgentTool`：產生新的 Worker。
- `SendMessageTool`：向現有 Worker 發送後續指令。
- `TaskStopTool`：終止正在運行的 Worker。
協調者會將所有“髒活累活”（Bash、讀寫文件）委託給 Worker。

---

## 3. Worker 生命週期

### 3.1 產生 Worker
Worker 通過 `AgentTool` 產生。每個 Worker 都是一個擁有獨立工具集的子進程。
根據是否開啟 `Simple` 模式，Worker 會獲得核心的文件操作權或全量的標準工具權。

### 3.2 XML 通知機制
當 Worker 執行完畢時，結果會通過帶有 XML 標籤的“用戶角色消息”傳遞給協調者：
```xml
<!-- 源碼位置: src/coordinator/coordinatorMode.ts:180-192 -->
<task-notification>
  <task-id>{agentId}</task-id>
  <status>completed|failed|killed</status>
  <summary>{狀態摘要}</summary>
  <result>{Worker 的最終文本響應}</result>
</task-notification>
```
這種設計非常優雅：通知看起來像用戶消息，但通過自定義標籤讓協調者能夠識別並無縫處理。

### 3.3 Worker 的延續與終止
協調者可以根據上下文決定是讓 Worker “繼續執行”新指令，還是銷燬它併產生一個“全新（Fresh）”的 Worker：
- **研究任務**：通常延續，因為 Worker 已經加載了相關文件。
- **驗證任務**：通常產生全新 Worker，以確保獨立性和“旁觀者清”。

---

## 4. 協調者的工作流模型

系統提示詞定義了一個經典的四階段工作流：
1. **研究 (Research)**：並行分發 Worker 調研代碼庫。
2. **綜合 (Synthesis)**：協調者讀取調研結果，理解問題並制定具體的規範（禁止模稜兩可）。
3. **實現 (Implementation)**：Worker 根據綜合規範進行代碼修改。
4. **驗證 (Verification)**：產生全新的 Worker 進行獨立驗證。

---

## 5. 暫存區 (Scratchpad)：跨 Worker 的共享狀態

雖然 Worker 之間是隔離的，但它們需要共享數據。解決方案是一個 **Scratchpad 目錄**：
- 這是一個所有 Worker 都可以讀寫的特定目錄。
- 在該目錄下的操作**不需要用戶確認**。
- 這為多智能體協作提供了持久化的知識中轉站。

---

## 6. Fork 機制：上下文共享優化

除了標準 Worker 之外，還存在一種 **Fork (派生)** 機制：
- **普通 Worker**：零上下文，冷啟動。
- **Fork**：集成父級的完整對話上下文和 Prompt 緩存。
Fork 是一種性能優化手段，旨在節省 Token 並複用父級的思考過程，適用於需要深入理解當前上下文的研究任務。

---

## 可遷移設計模式

> 以下模式可直接應用於其他多智能體編排系統。

### 模式 1：編譯時特性門控
**場景：** 部分功能僅面向特定用戶群體，需要在構建時隔離代碼路徑。
**實踐：** 使用 `feature()` 編譯標誌 + 打包器死代碼消除，未激活功能整個模塊從二進制中移除。
**Claude Code 中的應用：** `feature('COORDINATOR_MODE')` 為 false 時，整個協調器模塊在打包階段被剔除。

### 模式 2：XML 通知嵌入用戶消息
**場景：** 異步子任務完成後需要將結果注入到主對話流中。
**實踐：** 將結構化數據包裝為 XML 標籤嵌入用戶角色消息，LLM 自然理解其語義，無需專用消息通道。
**Claude Code 中的應用：** Worker 完成後的 `<task-notification>` 以用戶消息形式發送給協調者。

### 模式 3：架構級上下文隔離
**場景：** 多個並行智能體可能互相"汙染"上下文，導致推理質量下降。
**實踐：** 每個 Worker 作為獨立子進程啟動，從零上下文開始，強制協調者編寫自包含 Prompt。
**Claude Code 中的應用：** Worker 不繼承父級對話歷史，協調者必須顯式傳遞所有必要信息。

### 模式 4：綜合作為一等公民
**場景：** 多層委託中指令在傳遞過程中容易退化。
**實踐：** 在系統提示詞中明確要求協調者親自完成理解和綜合，禁止向 Worker 推卸理解責任。
**Claude Code 中的應用：** 協調者 Prompt 中明確禁止使用 "based on your findings" 等推卸用語。

---

## 8. 總結

| 維度 | 細節 |
|--------|--------|
| **激活方式** | `COORDINATOR_MODE` 構建標誌 + 環境變量 |
| **工具受限** | 協調者無法直接訪問 Bash/文件，只能調度 |
| **隔離性** | Worker 之間、Worker 與協調者之間完全上下文隔離 |
| **通信協議** | 用戶角色消息中的 XML `<task-notification>` |
| **共享狀態** | 通過 Scratchpad 目錄實現跨智能體知識傳遞 |
| **工作流** | 研究 → 綜合 → 實現 → 驗證 |
| **核心信條** | “永遠不要委託‘理解’過程” —— 協調者負責思考，Worker 負責執行 |
