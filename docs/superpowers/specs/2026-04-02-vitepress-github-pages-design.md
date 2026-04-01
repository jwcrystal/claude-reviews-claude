# VitePress GitHub Pages 文檔站設計

**日期**: 2026-04-02
**狀態**: Approved

## 背景

claude-reviews-claude 是 Claude Code 架構深度分析專案，包含 17 章分析（EN / zh-CN / zh-TW 三語言）及 31 張 SVG 架構圖。目前僅有 Markdown 檔案，無任何 GitHub Pages 配置。

## 需求

- 建立可閱讀的 GitHub Pages 網站
- 支援 Mermaid 圖表渲染
- 支援 3 種語言切換（EN / zh-CN / zh-TW）
- 雙主題：Light（白底藍色強調）+ Dark（深灰底天藍強調），不用紫色
- Sidebar Navigation 經典文檔站佈局
- 目標讀者：技術決策者 + 開發者

## 技術選型

**VitePress** — 原因：
1. 原生 Mermaid 支援（vitepress-plugin-mermaid + withMermaid wrapper）
2. 內建全文搜尋（minisearch）
3. 原生 i18n 多語言
4. Vue 元件擴展能力
5. Vite 驅動，構建極快
6. GitHub Actions 部署方便

## 目錄結構

```
docs/
├── .vitepress/
│   ├── config.ts            # 主配置
│   └── theme/
│       ├── index.ts          # 自訂主題（Mermaid 插件註冊）
│       └── styles/
│           └── custom.css    # 藍色系強調色、Light/Dark 覆寫
├── index.md                  # zh-TW 首頁（root locale）
├── architecture/             # zh-TW 架構章節（root locale）
│   ├── 00-overview.md
│   ├── 01-query-engine.md
│   ├── ...                   # 17 chapters (zh-TW copies)
│   └── (assets → see public/assets/)
├── en/
│   ├── index.md              # 英文首頁
│   └── architecture/
│       ├── 00-overview.md
│       ├── ...               # 17 chapters (EN copies)
├── zh-CN/
│   ├── index.md              # 簡中首頁
│   └── architecture/
│       ├── 00-overview.md
│       ├── ...               # 17 chapters (zh-CN copies)
└── public/
    ├── favicon.svg
    └── assets/               # SVG 架構圖（三語言共用，絕對路徑引用）
```

**VitePress locale → 目錄映射**：
- `locales['/']` → `docs/` 根目錄 = zh-TW 內容
- `locales['/en/']` → `docs/en/` = 英文內容
- `locales['/zh-CN/']` → `docs/zh-CN/` = 簡中內容

zh-TW 不需要 `docs/zh-TW/` 子目錄，因為它是 root locale，檔案直接放在 `docs/` 下。

### 檔案處理策略：複製而非 Symlink

**放棄 symlink，改用構建腳本複製。** 原因：
1. 現有 Markdown 內含相對連結（如 `zh-CN/00-overview.md`、`../00-overview.md`），symlink 會導致路徑失效
2. 需要為每個檔案注入 frontmatter，無法透過 symlink 達成
3. GitHub Actions 在 Windows runner 上對 symlink 支援不佳

**構建腳本職責**（`scripts/prepare-docs.sh`）：

腳本必須 **冪等（idempotent）**：每次執行先清空目標再重建。

```
#!/bin/bash
set -euo pipefail

# Step 1: 清空生成目錄（保留手動維護的首頁檔案）
rm -rf docs/architecture docs/en/architecture docs/zh-CN/architecture
rm -rf docs/public/assets

# Step 2: 複製 Markdown — zh-TW 為 root locale
mkdir -p docs/architecture docs/en/architecture docs/zh-CN/architecture docs/public
cp architecture/zh-TW/*.md docs/architecture/
cp architecture/*.md docs/en/architecture/
cp architecture/zh-CN/*.md docs/zh-CN/architecture/

# Step 3: SVG 統一放 public（三語言共用，避免重複）
cp -r architecture/assets docs/public/assets

# Step 4: 注入 frontmatter（prepend，每次從源頭複製所以不會重複注入）
node scripts/inject-frontmatter.mjs

# Step 5: 修正連結路徑
node scripts/fix-links.mjs

# Step 6: 複製首頁（已在 repo 中手動維護，直接保留）
# docs/index.md, docs/en/index.md, docs/zh-CN/index.md 不由腳本生成
# 首頁為手動撰寫的 VitePress frontmatter，直接 commit 在 docs/ 中
```

### 連結重寫規則（`scripts/fix-links.mjs`）

腳本逐一掃描所有目標 `.md` 檔案，依序套用以下規則：

| # | 原始路徑模式 | 轉換規則 | 範例 |
|---|---|---|---|
| 1 | `[text](zh-CN/xx.md)` | `[text](/zh-CN/architecture/xx)` | EN→zh-CN 語言切換 |
| 2 | `[text](zh-TW/xx.md)` | 刪除整行或改為 `[text](/architecture/xx)` | zh-CN→zh-TW（root locale） |
| 3 | `[text](../xx.md)` 其中 xx 為章節編號 | `[text](./xx)` | 同語言章節互連 |
| 4 | `![img](assets/xxx.svg)` | `![img](/claude-reviews-claude/assets/xxx.svg)` | 同目錄 SVG |
| 5 | `![img](../assets/xxx.svg)` | `![img](/claude-reviews-claude/assets/xxx.svg)` | 跨目錄 SVG |
| 6 | `[English →](../00-overview.md)` | 在 en 目錄下刪除（已是 EN）；在 zh-CN 下改為 `[English →](/en/architecture/00-overview)` | 語言切換 |
| 7 | `[中文版 →](zh-CN/xx.md)` | 在非 EN 目錄下刪除；在 EN 下改為 `[中文版 →](/zh-CN/architecture/xx)` | 語言切換 |
| 8 | `[...](../README.md)` 或 `[...](../README_EN.md)` | 刪除或改為 `[...](/)` / `[...](/en/)` | 返回首頁連結 |
| 9 | `[...](../architecture/xx.md)` | 改為 `[...](/en/architecture/xx)` 或對應語言路徑 | 跨目錄章節引用 |
| 10 | 所有剩餘 `.md` 連結 | 移除 `.md` 後綴（VitePress cleanUrls） | `[text](01-query)` |

### 實際檔案清單

英文（17 章）：`00-overview` ~ `17-telemetry-privacy-operations`
zh-CN（17 章）：同上
zh-TW（17 章）：同上

注意：英文目錄下有 `14-ui-state-management.md` 和 `14-ui-state-rendering.md` 兩個檔案（對應 UI 的兩個面向），zh-CN 和 zh-TW 也有同樣結構。Sidebar 需全部列出。

## 主題設計

### 完整 CSS 變數覆寫

確保所有 UI 元素不使用紫色，統一藍色系：

```css
:root {
  /* Brand - Blue */
  --vp-c-brand-1: #3b82f6;
  --vp-c-brand-2: #2563eb;
  --vp-c-brand-3: #1d4ed8;
  --vp-c-brand-soft: rgba(59, 130, 246, 0.14);

  /* Custom block colors - use blue instead of purple */
  --vp-custom-block-tip-border: #3b82f6;
  --vp-custom-block-tip-text: #1e40af;
  --vp-custom-block-tip-bg: rgba(59, 130, 246, 0.08);

  --vp-custom-block-warning-border: #f59e0b;
  --vp-custom-block-warning-text: #92400e;

  --vp-custom-block-danger-border: #ef4444;
  --vp-custom-block-danger-text: #991b1b;

  /* Badge - blue */
  --vp-badge-tip-border: #3b82f6;
  --vp-badge-tip-text: #3b82f6;

  /* Button */
  --vp-button-brand-border: #3b82f6;
  --vp-button-brand-text: #fff;
  --vp-button-brand-bg: #3b82f6;

  /* Link */
  --vp-c-brand-1: #3b82f6;
}

.dark {
  /* Brand - Sky Blue */
  --vp-c-brand-1: #38bdf8;
  --vp-c-brand-2: #0ea5e9;
  --vp-c-brand-3: #0284c7;
  --vp-c-brand-soft: rgba(56, 189, 248, 0.14);

  --vp-custom-block-tip-border: #38bdf8;
  --vp-custom-block-tip-text: #7dd3fc;
  --vp-custom-block-tip-bg: rgba(56, 189, 248, 0.08);

  --vp-custom-block-warning-border: #fbbf24;
  --vp-custom-block-warning-text: #fde68a;

  --vp-custom-block-danger-border: #f87171;
  --vp-custom-block-danger-text: #fca5a5;

  --vp-badge-tip-border: #38bdf8;
  --vp-badge-tip-text: #38bdf8;

  --vp-button-brand-border: #38bdf8;
  --vp-button-brand-text: #0f172a;
  --vp-button-brand-bg: #38bdf8;
}
```

### Code Block 主題
- Light: VitePress 預設（淺色代碼區）
- Dark: VitePress 預設 Dark（已無紫色）

## VitePress 配置細節

### config.ts 關鍵設定

```typescript
export default defineConfig({
  base: '/claude-reviews-claude/',  // GitHub Pages project site
  cleanUrls: true,
  lastUpdated: true,
  title: 'Claude Code Architecture Deep Dive',
  description: '17-chapter architecture analysis of Claude Code',

  // Markdown 配置
  markdown: {
    image: { lazyLoading: true },
  },

  // 搜尋
  search: {
    provider: 'local', // minisearch
  },

  // i18n — root locale 就是 zh-TW，不做額外 redirect
  locales: {
    '/': {
      label: '繁體中文',
      lang: 'zh-TW',
      link: '/',
      themeConfig: {
        nav: [
          { text: '首頁', link: '/' },
          { text: '架構分析', link: '/architecture/00-overview' },
        ],
        sidebar: sidebar.zhTW,
        outline: { label: '本頁導航' },
        docFooter: { prev: '上一頁', next: '下一頁' },
        lastUpdated: { text: '最後更新' },
      },
    },
    '/en/': {
      label: 'English',
      lang: 'en',
      link: '/en/',
      themeConfig: {
        nav: [
          { text: 'Home', link: '/en/' },
          { text: 'Architecture', link: '/en/architecture/00-overview' },
        ],
        sidebar: sidebar.en,
        outline: { label: 'On This Page' },
        docFooter: { prev: 'Previous', next: 'Next' },
        lastUpdated: { text: 'Last updated' },
      },
    },
    '/zh-CN/': {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh-CN/',
      themeConfig: {
        nav: [
          { text: '首页', link: '/zh-CN/' },
          { text: '架构分析', link: '/zh-CN/architecture/00-overview' },
        ],
        sidebar: sidebar.zhCN,
        outline: { label: '本页导航' },
        docFooter: { prev: '上一页', next: '下一页' },
        lastUpdated: { text: '最后更新' },
      },
    },
  },
})
```

### package.json scripts

```json
{
  "scripts": {
    "docs:prepare": "bash scripts/prepare-docs.sh",
    "docs:dev": "npm run docs:prepare && vitepress dev docs",
    "docs:build": "npm run docs:prepare && vitepress build docs",
    "docs:preview": "vitepress preview docs"
  },
  "devDependencies": {
    "vitepress": "^1.6",
    "vitepress-plugin-mermaid": "^2.0"
  }
}
```

## Sidebar 導航

每種語言 sidebar 依主題分 4 組，完整對應每個檔案：

### 1. 核心架構
| # | 檔案 | 標題 |
|---|------|------|
| 00 | `00-overview` | 架構總覽 |
| 01 | `01-query-engine` | 查詢引擎 |
| 02 | `02-tool-system` | 工具系統 |
| 03 | `03-coordinator` | 多智能體協調器 |

### 2. 執行與擴展
| # | 檔案 | 標題 |
|---|------|------|
| 04 | `04-plugin-system` | 插件系統 |
| 05 | `05-hook-system` | 鉤子系統 |
| 06 | `06-bash-engine` | Bash 執行引擎 |
| 07 | `07-permission-pipeline` | 權限流水線 |

### 3. 狀態與上下文
| # | 檔案 | 標題 |
|---|------|------|
| 08 | `08-agent-swarms` | Agent Swarms |
| 09 | `09-session-persistence` | 會話持久化 |
| 10 | `10-context-assembly` | 上下文組裝 |
| 11 | `11-compact-system` | 精簡系統 |

### 4. 系統服務
| # | 檔案 | 標題 |
|---|------|------|
| 12 | `12-startup-bootstrap` | 啟動與引導 |
| 13 | `13-bridge-system` | 橋接系統 |
| 14a | `14-ui-state-management` | UI 狀態管理 |
| 14b | `14-ui-state-rendering` | UI 狀態渲染 |
| 15 | `15-services-api-layer` | 服務與 API 層 |
| 16 | `16-infrastructure-config` | 基礎設施與配置 |
| 17 | `17-telemetry-privacy-operations` | 遙測與隱私 |

## 首頁設計

### 三語言首頁行為

- **根 `/`** = zh-TW 首頁（VitePress root locale = `docs/index.md`），**不做 redirect**
- **`/en/`** = 英文首頁（`docs/en/index.md`）
- **`/zh-CN/`** = 簡中首頁（`docs/zh-CN/index.md`）

三個首頁共用同一個版型，各自有獨立本地化文案。

### 首頁版型（`index.md` 各語言各一份）

```markdown
---
layout: home
hero:
  name: "Claude Code 架構深度解析"
  text: "17 章完整分析"
  tagline: "一個 AI 閱讀自己的源代碼"
  actions:
    - theme: brand
      text: 開始閱讀 →
      link: /architecture/00-overview     # 各語言對應路徑
features:
  - title: 📚 17 章架構分析
    details: 從 Query Engine 到 Telemetry，完整拆解 Claude Code 每個子系統
  - title: 🏗️ 互動架構圖
    details: Mermaid 圖表 + SVG 架構圖，視覺化理解系統設計
  - title: 🌐 三語言支援
    details: English / 简体中文 / 繁體中文，頂部一鍵切換
---
```

「開始閱讀」按鈕各自連到該語言的 `/architecture/00-overview`。

## Mermaid 支援

使用 `vitepress-plugin-mermaid`（透過 `withMermaid()` 包裹 config）：
- 偵測 ` ```mermaid ` 代碼區塊並渲染
- 確保現有 Markdown 中的 Mermaid 區塊可正常顯示
- 在 `.vitepress/theme/index.ts` 中註冊插件

## 部署

### GitHub Actions Workflow（`.github/workflows/deploy.yml`）

```yaml
name: Deploy VitePress site to Pages
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run docs:build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs/.vitepress/dist

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

### GitHub Pages 設定
- Source: GitHub Actions
- `base: '/claude-reviews-claude/'`
- Build output: `docs/.vitepress/dist`

## 不做的事（YAGNI）

- ❌ 評論系統
- ❌ Analytics
- ❌ 自訂 Vue 元件（首版用 VitePress 預設元件）
- ❌ 重構現有 Markdown 內容（僅注入 frontmatter + 修正連結）
- ❌ SEO 配置（VitePress 預設已處理 meta tags）
- ❌ PWA / 離線支援
- ❌ 自訂域名（使用 `.github.io/claude-reviews-claude/`）

## 成功標準（量化）

1. **Build 成功**: `npm run docs:build` 零錯誤，所有 51+ 頁面全部生成
2. **無 Broken Links**: 構建後無 404（VitePress 內建檢查）
3. **語言切換**: 頂部可切換 EN / zh-CN / zh-TW，每個語言都有完整 sidebar
4. **主題切換**: Light/Dark 可切換，所有 UI 元素無紫色
5. **Mermaid 渲染**: 至少 1 個含 mermaid 的頁面正確渲染圖表
6. **SVG 顯示**: 31 張 SVG 架構圖全部在對應頁面正確顯示
7. **搜尋功能**: 輸入關鍵字可命中正確章節
8. **響應式**: 在 375px 寬度（iPhone SE）下可正常閱讀
9. **GitHub Pages 可訪問**: `https://jwcrystal.github.io/claude-reviews-claude/` 返回 200
10. **構建時間**: 不超過 2 分鐘
