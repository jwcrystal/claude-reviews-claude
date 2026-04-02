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
        { text: '壓縮系統', link: '/architecture/11-compact-system' },
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

export default withMermaid(defineConfig({
    base: '/claude-reviews-claude/',
    cleanUrls: true,
    lastUpdated: true,
    ignoreDeadLinks: true,
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
