# VitePress GitHub Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up a VitePress-powered GitHub Pages documentation site for the Claude Code architecture analysis series (17 chapters × 3 languages).

**Architecture:** VitePress SSG with i18n (root locale = zh-TW, `/en/`, `/zh-CN/`). Build script copies source markdown from `architecture/` into `docs/` directory structure, injects frontmatter, and fixes links. GitHub Actions deploys to GitHub Pages.

**Tech Stack:** VitePress 1.x, vitepress-plugin-mermaid, Node.js 20+, npm, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-04-02-vitepress-github-pages-design.md`

---

## File Map

### Created Files
| File | Purpose |
|------|---------|
| `package.json` | npm project with VitePress deps and scripts |
| `docs/.vitepress/config.ts` | VitePress main config (i18n, sidebar, nav, theme, mermaid) |
| `docs/.vitepress/theme/index.ts` | Custom theme registration |
| `docs/.vitepress/theme/styles/custom.css` | Blue color scheme (light + dark), no purple |
| `docs/index.md` | zh-TW homepage (root locale) |
| `docs/en/index.md` | English homepage |
| `docs/zh-CN/index.md` | Simplified Chinese homepage |
| `scripts/prepare-docs.sh` | Idempotent build script: copy, inject frontmatter, fix links |
| `scripts/inject-frontmatter.mjs` | Node script: prepend frontmatter to each .md |
| `scripts/fix-links.mjs` | Node script: rewrite markdown links for VitePress paths |
| `.github/workflows/deploy.yml` | GitHub Actions: build + deploy to GitHub Pages |
| `docs/public/favicon.svg` | Site favicon |

### Generated Files (by prepare-docs.sh, not committed)
- `docs/architecture/*.md` — zh-TW chapters (copied from `architecture/zh-TW/`)
- `docs/en/architecture/*.md` — EN chapters (copied from `architecture/`)
- `docs/zh-CN/architecture/*.md` — zh-CN chapters (copied from `architecture/zh-CN/`)
- `docs/public/assets/*.svg` — SVG diagrams (copied from `architecture/assets/`)

---

## Task 1: Initialize npm project with VitePress

**Files:**
- Create: `package.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "claude-reviews-claude-docs",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "docs:prepare": "bash scripts/prepare-docs.sh",
    "docs:dev": "npm run docs:prepare && npx vitepress dev docs",
    "docs:build": "npm run docs:prepare && npx vitepress build docs",
    "docs:preview": "npx vitepress preview docs"
  },
  "devDependencies": {
    "vitepress": "^1.6.3",
    "vitepress-plugin-mermaid": "^2.0.17",
    "mermaid": "^11.4.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`

- [ ] **Step 3: Verify VitePress is installed**

Run: `npx vitepress --version`
Expected: Version string (e.g., `1.6.3`)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: init npm project with VitePress and mermaid plugin"
```

---

## Task 2: Create prepare-docs build script

**Files:**
- Create: `scripts/prepare-docs.sh`
- Create: `scripts/inject-frontmatter.mjs`
- Create: `scripts/fix-links.mjs`

- [ ] **Step 1: Create prepare-docs.sh**

```bash
#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_DIR="$REPO_ROOT/docs"

echo "📦 Preparing docs content..."

# Step 1: Clean generated directories (preserve manually maintained homepages)
rm -rf "$DOCS_DIR/architecture" "$DOCS_DIR/en/architecture" "$DOCS_DIR/zh-CN/architecture"
rm -rf "$DOCS_DIR/public/assets"

# Step 2: Create target directories
mkdir -p "$DOCS_DIR/architecture" "$DOCS_DIR/en/architecture" "$DOCS_DIR/zh-CN/architecture" "$DOCS_DIR/public/assets"

# Step 3: Copy markdown — zh-TW is root locale
cp "$REPO_ROOT/architecture/zh-TW/"*.md "$DOCS_DIR/architecture/"
# EN chapters (architecture/ root = English)
cp "$REPO_ROOT/architecture/"*.md "$DOCS_DIR/en/architecture/"
# zh-CN chapters
cp "$REPO_ROOT/architecture/zh-CN/"*.md "$DOCS_DIR/zh-CN/architecture/"

# Step 4: Copy SVG assets to public (shared by all locales)
cp "$REPO_ROOT/architecture/assets/"* "$DOCS_DIR/public/assets/"

# Step 5: Inject frontmatter
node "$REPO_ROOT/scripts/inject-frontmatter.mjs"

# Step 6: Fix links
node "$REPO_ROOT/scripts/fix-links.mjs"

echo "✅ Docs content prepared."
```

- [ ] **Step 2: Create inject-frontmatter.mjs**

Extracts title from first H1 (`# Title`) in each markdown file and prepends VitePress frontmatter.

```javascript
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DOCS_DIR = join(import.meta.dirname, '..', 'docs');

const dirs = [
  join(DOCS_DIR, 'architecture'),
  join(DOCS_DIR, 'en', 'architecture'),
  join(DOCS_DIR, 'zh-CN', 'architecture'),
];

for (const dir of dirs) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const filePath = join(dir, file);
    const content = readFileSync(filePath, 'utf-8');
    
    // Skip if already has frontmatter
    if (content.startsWith('---')) continue;
    
    // Extract title from first H1
    const match = content.match(/^#\s+(.+)$/m);
    const title = match ? match[1].replace(/[*_`]/g, '').trim() : file.replace('.md', '');
    
    const frontmatter = `---\ntitle: ${JSON.stringify(title)}\n---\n\n`;
    writeFileSync(filePath, frontmatter + content, 'utf-8');
  }
}

console.log('✅ Frontmatter injected.');
```

- [ ] **Step 3: Create fix-links.mjs**

Rewrites markdown links for VitePress compatibility.

```javascript
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DOCS_DIR = join(import.meta.dirname, '..', 'docs');
const BASE = '/claude-reviews-claude';

// Map: directory → { prefix, locale } for context-aware link rewriting
const localeMap = {
  [join(DOCS_DIR, 'architecture')]: { prefix: '', locale: 'zh-TW' },
  [join(DOCS_DIR, 'en', 'architecture')]: { prefix: '/en', locale: 'en' },
  [join(DOCS_DIR, 'zh-CN', 'architecture')]: { prefix: '/zh-CN', locale: 'zh-CN' },
};

function fixLinks(content, dir) {
  const { prefix, locale } = localeMap[dir] || { prefix: '', locale: 'unknown' };
  
  // Step 1: Remove language-switch blockquotes (lines starting with "> 🌐")
  // These are the "Language: English | 中文版 →" lines at the top of each file.
  // In VitePress, the language switcher is in the nav bar, so these are redundant.
  content = content.replace(/^>\s*🌐\s*\*\*.*?\*\*.*$/gm, '');
  
  // Step 2: SVG asset links → absolute public path
  content = content.replace(
    /!\[([^\]]*)\]\((?:\.\.\/)?assets\/([^)]+)\)/g,
    `![$1](${BASE}/assets/$2)`
  );
  
  // Step 3: Cross-directory architecture links: ../architecture/xx.md
  content = content.replace(
    /\[([^\]]+)\]\(\.\.\/architecture\/(\d{2}[^)]*)\.md\)/g,
    `[$1](${prefix}/architecture/$2)`
  );
  
  // Step 4: README links → homepage
  content = content.replace(
    /\[([^\]]*)\]\(\.\.\/README(_EN)?\.md\)/g,
    (m, text, isEn) => isEn ? `[$1](/en/)` : `[$1](/)`
  );
  
  // Step 5: Same-directory chapter links: ../xx.md or ./xx.md → ./xx (cleanUrls)
  // Only matches 2-digit chapter numbers
  content = content.replace(
    /\[([^\]]+)\]\(\.\.?\/(\d{2}[^)]*)\.md\)/g,
    `[$1](./$2)`
  );
  
  // Step 6: Catch-all: remaining .md link suffixes (cleanUrls)
  content = content.replace(
    /\[([^\]]+)\]\(([^)]*)\.md\)/g,
    `[$1]($2)`
  );
  
  return content;
}

for (const dir of Object.keys(localeMap)) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const filePath = join(dir, file);
    const content = readFileSync(filePath, 'utf-8');
    const fixed = fixLinks(content, dir);
    if (fixed !== content) {
      writeFileSync(filePath, fixed, 'utf-8');
    }
  }
}

console.log('✅ Links fixed.');
```

- [ ] **Step 4: Make prepare-docs.sh executable**

Run: `chmod +x scripts/prepare-docs.sh`

- [ ] **Step 5: Test prepare-docs.sh**

Run: `npm run docs:prepare`

Expected: Output with `✅ Frontmatter injected.` and `✅ Links fixed.`

- [ ] **Step 6: Verify generated files exist**

Run: `ls docs/architecture/00-overview.md docs/en/architecture/00-overview.md docs/zh-CN/architecture/00-overview.md docs/public/assets/`

Expected: All files listed without error.

- [ ] **Step 7: Commit**

```bash
git add scripts/ .gitignore
git commit -m "feat: add docs prepare scripts (copy, frontmatter, link-fix)"
```

---

## Task 3: Create VitePress config and theme

**Files:**
- Create: `docs/.vitepress/config.ts`
- Create: `docs/.vitepress/theme/index.ts`
- Create: `docs/.vitepress/theme/styles/custom.css`

- [ ] **Step 1: Create config.ts**

```typescript
import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

const sidebar = {
  zhTW: [
    {
      text: '核心架構',
      collapsed: false,
      items: [
        { text: '架構總覽', link: '/architecture/00-overview' },
        { text: '查詢引擎', link: '/architecture/01-query-engine' },
        { text: '工具系統', link: '/architecture/02-tool-system' },
        { text: '多智能體協調器', link: '/architecture/03-coordinator' },
      ],
    },
    {
      text: '執行與擴展',
      collapsed: false,
      items: [
        { text: '插件系統', link: '/architecture/04-plugin-system' },
        { text: '鉤子系統', link: '/architecture/05-hook-system' },
        { text: 'Bash 執行引擎', link: '/architecture/06-bash-engine' },
        { text: '權限流水線', link: '/architecture/07-permission-pipeline' },
      ],
    },
    {
      text: '狀態與上下文',
      collapsed: false,
      items: [
        { text: 'Agent Swarms', link: '/architecture/08-agent-swarms' },
        { text: '會話持久化', link: '/architecture/09-session-persistence' },
        { text: '上下文組裝', link: '/architecture/10-context-assembly' },
        { text: '精簡系統', link: '/architecture/11-compact-system' },
      ],
    },
    {
      text: '系統服務',
      collapsed: false,
      items: [
        { text: '啟動與引導', link: '/architecture/12-startup-bootstrap' },
        { text: '橋接系統', link: '/architecture/13-bridge-system' },
        { text: 'UI 狀態管理', link: '/architecture/14-ui-state-management' },
        { text: 'UI 狀態渲染', link: '/architecture/14-ui-state-rendering' },
        { text: '服務與 API 層', link: '/architecture/15-services-api-layer' },
        { text: '基礎設施與配置', link: '/architecture/16-infrastructure-config' },
        { text: '遙測與隱私', link: '/architecture/17-telemetry-privacy-operations' },
      ],
    },
  ],
  en: [
    {
      text: 'Core Architecture',
      collapsed: false,
      items: [
        { text: 'Overview', link: '/en/architecture/00-overview' },
        { text: 'Query Engine', link: '/en/architecture/01-query-engine' },
        { text: 'Tool System', link: '/en/architecture/02-tool-system' },
        { text: 'Coordinator', link: '/en/architecture/03-coordinator' },
      ],
    },
    {
      text: 'Execution & Extension',
      collapsed: false,
      items: [
        { text: 'Plugin System', link: '/en/architecture/04-plugin-system' },
        { text: 'Hook System', link: '/en/architecture/05-hook-system' },
        { text: 'Bash Engine', link: '/en/architecture/06-bash-engine' },
        { text: 'Permission Pipeline', link: '/en/architecture/07-permission-pipeline' },
      ],
    },
    {
      text: 'State & Context',
      collapsed: false,
      items: [
        { text: 'Agent Swarms', link: '/en/architecture/08-agent-swarms' },
        { text: 'Session Persistence', link: '/en/architecture/09-session-persistence' },
        { text: 'Context Assembly', link: '/en/architecture/10-context-assembly' },
        { text: 'Compact System', link: '/en/architecture/11-compact-system' },
      ],
    },
    {
      text: 'System Services',
      collapsed: false,
      items: [
        { text: 'Startup & Bootstrap', link: '/en/architecture/12-startup-bootstrap' },
        { text: 'Bridge System', link: '/en/architecture/13-bridge-system' },
        { text: 'UI State Management', link: '/en/architecture/14-ui-state-management' },
        { text: 'UI State Rendering', link: '/en/architecture/14-ui-state-rendering' },
        { text: 'Services & API Layer', link: '/en/architecture/15-services-api-layer' },
        { text: 'Infrastructure & Config', link: '/en/architecture/16-infrastructure-config' },
        { text: 'Telemetry & Privacy', link: '/en/architecture/17-telemetry-privacy-operations' },
      ],
    },
  ],
  zhCN: [
    {
      text: '核心架构',
      collapsed: false,
      items: [
        { text: '架构总览', link: '/zh-CN/architecture/00-overview' },
        { text: '查询引擎', link: '/zh-CN/architecture/01-query-engine' },
        { text: '工具系统', link: '/zh-CN/architecture/02-tool-system' },
        { text: '多智能体协调器', link: '/zh-CN/architecture/03-coordinator' },
      ],
    },
    {
      text: '执行与扩展',
      collapsed: false,
      items: [
        { text: '插件系统', link: '/zh-CN/architecture/04-plugin-system' },
        { text: '钩子系统', link: '/zh-CN/architecture/05-hook-system' },
        { text: 'Bash 执行引擎', link: '/zh-CN/architecture/06-bash-engine' },
        { text: '权限流水线', link: '/zh-CN/architecture/07-permission-pipeline' },
      ],
    },
    {
      text: '状态与上下文',
      collapsed: false,
      items: [
        { text: 'Agent Swarms', link: '/zh-CN/architecture/08-agent-swarms' },
        { text: '会话持久化', link: '/zh-CN/architecture/09-session-persistence' },
        { text: '上下文组装', link: '/zh-CN/architecture/10-context-assembly' },
        { text: '精简系统', link: '/zh-CN/architecture/11-compact-system' },
      ],
    },
    {
      text: '系统服务',
      collapsed: false,
      items: [
        { text: '启动与引导', link: '/zh-CN/architecture/12-startup-bootstrap' },
        { text: '桥接系统', link: '/zh-CN/architecture/13-bridge-system' },
        { text: 'UI 状态管理', link: '/zh-CN/architecture/14-ui-state-management' },
        { text: 'UI 状态渲染', link: '/zh-CN/architecture/14-ui-state-rendering' },
        { text: '服务与 API 层', link: '/zh-CN/architecture/15-services-api-layer' },
        { text: '基础设施与配置', link: '/zh-CN/architecture/16-infrastructure-config' },
        { text: '遥测与隐私', link: '/zh-CN/architecture/17-telemetry-privacy-operations' },
      ],
    },
  ],
};

export default withMermaid(
  defineConfig({
    base: '/claude-reviews-claude/',
    cleanUrls: true,
    lastUpdated: true,
    title: 'Claude Code 架構深度解析',
    description: '17-chapter architecture analysis of Claude Code',

    head: [['link', { rel: 'icon', href: '/claude-reviews-claude/favicon.svg' }]],

    markdown: {
      image: { lazyLoading: true },
    },

    search: {
      provider: 'local',
    },

    locales: {
      root: {
        label: '繁體中文',
        lang: 'zh-TW',
        themeConfig: {
          nav: [
            { text: '首頁', link: '/' },
            { text: '架構分析', link: '/architecture/00-overview' },
          ],
          sidebar: sidebar.zhTW,
          outline: { label: '本頁導航' },
          docFooter: { prev: '上一頁', next: '下一頁' },
          lastUpdated: { text: '最後更新' },
          editLink: {
            pattern: 'https://github.com/jwcrystal/claude-reviews-claude/edit/main/architecture/zh-TW/:path',
            text: '在 GitHub 上編輯此頁',
          },
        },
      },
      en: {
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
          editLink: {
            pattern: 'https://github.com/jwcrystal/claude-reviews-claude/edit/main/architecture/:path',
            text: 'Edit this page on GitHub',
          },
        },
      },
      'zh-CN': {
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
          editLink: {
            pattern: 'https://github.com/jwcrystal/claude-reviews-claude/edit/main/architecture/zh-CN/:path',
            text: '在 GitHub 上编辑此页',
          },
        },
      },
    },
  }),
);
```

- [ ] **Step 2: Create theme/index.ts**

```typescript
import DefaultTheme from 'vitepress/theme';
import './styles/custom.css';

export default DefaultTheme;
```

- [ ] **Step 3: Create theme/styles/custom.css**

```css
/* Blue color scheme — Light */
:root {
  --vp-c-brand-1: #3b82f6;
  --vp-c-brand-2: #2563eb;
  --vp-c-brand-3: #1d4ed8;
  --vp-c-brand-soft: rgba(59, 130, 246, 0.14);

  --vp-custom-block-tip-border: #3b82f6;
  --vp-custom-block-tip-text: #1e40af;
  --vp-custom-block-tip-bg: rgba(59, 130, 246, 0.08);

  --vp-custom-block-warning-border: #f59e0b;
  --vp-custom-block-warning-text: #92400e;
  --vp-custom-block-warning-bg: rgba(245, 158, 11, 0.08);

  --vp-custom-block-danger-border: #ef4444;
  --vp-custom-block-danger-text: #991b1b;
  --vp-custom-block-danger-bg: rgba(239, 68, 68, 0.08);

  --vp-badge-tip-border: #3b82f6;
  --vp-badge-tip-text: #3b82f6;

  --vp-button-brand-border: transparent;
  --vp-button-brand-text: #fff;
  --vp-button-brand-bg: #3b82f6;
  --vp-button-brand-hover-border: transparent;
  --vp-button-brand-hover-text: #fff;
  --vp-button-brand-hover-bg: #2563eb;
  --vp-button-brand-active-border: transparent;
  --vp-button-brand-active-text: #fff;
  --vp-button-brand-active-bg: #1d4ed8;
}

/* Blue color scheme — Dark */
.dark {
  --vp-c-brand-1: #38bdf8;
  --vp-c-brand-2: #0ea5e9;
  --vp-c-brand-3: #0284c7;
  --vp-c-brand-soft: rgba(56, 189, 248, 0.14);

  --vp-custom-block-tip-border: #38bdf8;
  --vp-custom-block-tip-text: #7dd3fc;
  --vp-custom-block-tip-bg: rgba(56, 189, 248, 0.08);

  --vp-custom-block-warning-border: #fbbf24;
  --vp-custom-block-warning-text: #fde68a;
  --vp-custom-block-warning-bg: rgba(251, 191, 36, 0.08);

  --vp-custom-block-danger-border: #f87171;
  --vp-custom-block-danger-text: #fca5a5;
  --vp-custom-block-danger-bg: rgba(248, 113, 113, 0.08);

  --vp-badge-tip-border: #38bdf8;
  --vp-badge-tip-text: #38bdf8;

  --vp-button-brand-border: transparent;
  --vp-button-brand-text: #0f172a;
  --vp-button-brand-bg: #38bdf8;
  --vp-button-brand-hover-border: transparent;
  --vp-button-brand-hover-text: #0f172a;
  --vp-button-brand-hover-bg: #0ea5e9;
  --vp-button-brand-active-border: transparent;
  --vp-button-brand-active-text: #0f172a;
  --vp-button-brand-active-bg: #0284c7;
}
```

- [ ] **Step 4: Commit**

```bash
git add docs/.vitepress/
git commit -m "feat: add VitePress config, theme, and blue color scheme"
```

---

## Task 4: Create homepage files (3 languages)

**Files:**
- Create: `docs/index.md`
- Create: `docs/en/index.md`
- Create: `docs/zh-CN/index.md`

- [ ] **Step 1: Create zh-TW homepage (docs/index.md)**

```markdown
---
layout: home

hero:
  name: "Claude Code"
  text: "架構深度解析"
  tagline: "一個 AI 閱讀自己的源代碼 — 17 章完整分析"
  actions:
    - theme: brand
      text: 開始閱讀 →
      link: /architecture/00-overview
    - theme: alt
      text: GitHub
      link: https://github.com/jwcrystal/claude-reviews-claude

features:
  - icon: 📚
    title: 17 章架構分析
    details: 從 Query Engine 到 Telemetry，完整拆解 Claude Code 每個子系統的設計與實作
  - icon: 🏗️
    title: 互動架構圖
    details: Mermaid 圖表 + SVG 架構圖，視覺化理解系統設計與資料流
  - icon: 🌐
    title: 三語言支援
    details: 繁體中文、简体中文、English，頂部一鍵切換
---
```

- [ ] **Step 2: Create EN homepage (docs/en/index.md)**

```markdown
---
layout: home

hero:
  name: "Claude Code"
  text: "Architecture Deep Dive"
  tagline: "An AI reading its own source code — 17 chapters of deep analysis"
  actions:
    - theme: brand
      text: Start Reading →
      link: /en/architecture/00-overview
    - theme: alt
      text: GitHub
      link: https://github.com/jwcrystal/claude-reviews-claude

features:
  - icon: 📚
    title: 17 Chapters
    details: From Query Engine to Telemetry, a complete breakdown of every Claude Code subsystem
  - icon: 🏗️
    title: Interactive Diagrams
    details: Mermaid charts + SVG architecture diagrams for visual understanding of system design
  - icon: 🌐
    title: Multilingual
    details: Traditional Chinese, Simplified Chinese, and English — switch with one click
---
```

- [ ] **Step 3: Create zh-CN homepage (docs/zh-CN/index.md)**

```markdown
---
layout: home

hero:
  name: "Claude Code"
  text: "架构深度解析"
  tagline: "一个 AI 阅读自己的源代码 — 17 章完整分析"
  actions:
    - theme: brand
      text: 开始阅读 →
      link: /zh-CN/architecture/00-overview
    - theme: alt
      text: GitHub
      link: https://github.com/jwcrystal/claude-reviews-claude

features:
  - icon: 📚
    title: 17 章架构分析
    details: 从 Query Engine 到 Telemetry，完整拆解 Claude Code 每个子系统的设计与实现
  - icon: 🏗️
    title: 互动架构图
    details: Mermaid 图表 + SVG 架构图，可视化理解系统设计与数据流
  - icon: 🌐
    title: 三语言支持
    details: 繁體中文、简体中文、English，顶部一键切换
---
```

- [ ] **Step 4: Commit**

```bash
git add docs/index.md docs/en/index.md docs/zh-CN/index.md
git commit -m "feat: add localized homepages for zh-TW, EN, zh-CN"
```

---

## Task 5: Create favicon and .gitignore entries

**Files:**
- Create: `docs/public/favicon.svg`
- Modify: `.gitignore`

- [ ] **Step 1: Create a simple favicon.svg**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="#3b82f6"/>
  <text x="16" y="22" text-anchor="middle" font-family="system-ui" font-weight="bold" font-size="18" fill="white">C</text>
</svg>
```

- [ ] **Step 2: Add VitePress generated dirs to .gitignore**

Append to `.gitignore`:
```
# VitePress generated content
docs/architecture/
docs/en/architecture/
docs/zh-CN/architecture/
docs/public/assets/
node_modules/
docs/.vitepress/dist/
docs/.vitepress/cache/
.superpowers/
```

- [ ] **Step 3: Commit**

```bash
git add docs/public/favicon.svg .gitignore
git commit -m "feat: add favicon and gitignore for VitePress generated content"
```

---

## Task 6: Create GitHub Actions deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Create deploy.yml**

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
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - uses: actions/configure-pages@v4
      - run: npm ci
      - run: npm run docs:build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs/.vitepress/dist

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: add GitHub Actions workflow for VitePress deployment"
```

---

## Task 7: Verify local build

- [ ] **Step 1: Run full build**

Run: `npm run docs:build`

Expected: Build completes with zero errors. Output shows generated pages count.

- [ ] **Step 2: Check for broken links**

Run: `npm run docs:build 2>&1 | grep -i "not found\|404\|error"` 

Expected: No output (no broken links or errors).

- [ ] **Step 3: Start dev server for visual check**

Run: `npm run docs:dev`

Expected: Dev server starts on `http://localhost:5173/claude-reviews-claude/`

- [ ] **Step 4: Verify key pages in browser**

Check these URLs:
- `/claude-reviews-claude/` — zh-TW homepage
- `/claude-reviews-claude/architecture/00-overview` — zh-TW overview chapter
- `/claude-reviews-claude/en/` — EN homepage
- `/claude-reviews-claude/en/architecture/00-overview` — EN overview
- `/claude-reviews-claude/zh-CN/` — zh-CN homepage

Expected: All pages render correctly, sidebar visible, language switcher works, Light/Dark toggle works.

- [ ] **Step 5: Verify SVG images display**

Open a chapter that references SVG diagrams (e.g., overview or query-engine).
Expected: SVG images render in the page.

- [ ] **Step 6: Fix any issues found during verification**

Address build errors, broken links, or rendering issues.

- [ ] **Step 7: Final commit if fixes needed**

```bash
git add -A
git commit -m "fix: address issues found during local build verification"
```

---

## Task 8: Push and verify deployment

- [ ] **Step 1: Push branch to remote**

Run: `git push origin claude/setup-github-pages-UM6RO`

- [ ] **Step 2: Create pull request**

```bash
gh pr create \
  --title "feat: set up VitePress GitHub Pages documentation site" \
  --body "## Summary
- VitePress documentation site with i18n (zh-TW root, EN, zh-CN)
- Blue color scheme (light + dark), no purple
- Build scripts to prepare markdown content from architecture/ directory
- Mermaid diagram support
- GitHub Actions deployment workflow
- Full-text search (minisearch)

## Test Plan
- [ ] Local build succeeds (\`npm run docs:build\`)
- [ ] All 51+ pages render correctly
- [ ] Language switcher works
- [ ] Light/Dark theme toggle works
- [ ] SVG diagrams display
- [ ] Mermaid diagrams render
- [ ] Search works
- [ ] Mobile responsive"
```

- [ ] **Step 3: Merge PR, then enable GitHub Pages**

After merge: Go to repo Settings → Pages → Source: GitHub Actions

- [ ] **Step 4: Trigger deployment**

Push to main or manually trigger the workflow. Verify at `https://jwcrystal.github.io/claude-reviews-claude/`
