import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DOCS_DIR = join(import.meta.dirname, '..', 'docs');
const BASE = '/claude-reviews-claude';

const localeMap = {
  [join(DOCS_DIR, 'architecture')]: { prefix: '', locale: 'zh-TW' },
  [join(DOCS_DIR, 'en', 'architecture')]: { prefix: '/en', locale: 'en' },
  [join(DOCS_DIR, 'zh-CN', 'architecture')]: { prefix: '/zh-CN', locale: 'zh-CN' },
};

function fixLinks(content, dir) {
  const { prefix, locale } = localeMap[dir] || { prefix: '', locale: 'unknown' };

  // Step 1: Remove language-switch blockquotes (lines starting with "> 🌐")
  content = content.replace(/^>\s*🌐\s*\*\*.*?\*\*.*$/gm, '');

  // Step 2: <img> tags with SVG → point to /assets/ (public dir, no base needed)
  // Handle: <img src="assets/xxx.svg" ...>, <img src="../assets/xxx.svg" ...>,
  //         <img src="/claude-reviews-claude/assets/xxx.svg" ...>
  content = content.replace(
    /<img\s+([^>]*?)src=["'](?:\/claude-reviews-claude\/)?(?:\.\.\/)?assets\/([^"']+\.svg)["']([^>]*?)>/g,
    (m, pre, src, post) => {
      const attrs = (pre + post).match(/width=["'](\d+)["']/);
      const width = attrs ? ` width="${attrs[1]}"` : '';
      return `<img src="/assets/${src}"${width} />`;
    }
  );

  // Step 3: Markdown SVG image syntax → <img> HTML tag
  // VitePress treats ![...](xxx.svg) as Rollup imports which fails for SVGs
  // Using <img> HTML tags avoids this — they reference public/ directly
  content = content.replace(
    /!\[([^\]]*)\]\((?:\.\.\/)?(?:\/claude-reviews-claude\/)?assets\/([^)]+\.svg)\)/g,
    (m, alt, src) => `<img src="/assets/${src}" alt="${alt}" />`
  );

  // Step 4: Cross-directory architecture links: ../architecture/xx.md
  content = content.replace(
    /\[([^\]]+)\]\(\.\.\/architecture\/(\d{2}[^)]*)\.md\)/g,
    `[$1](${prefix}/architecture/$2)`
  );

  // Step 5: README links → homepage
  content = content.replace(
    /\[([^\]]*)\]\(\.\.\/README(_EN)?\.md\)/g,
    (m, text, isEn) => isEn ? `[${text}](/en/)` : `[${text}](/)`
  );

  // Step 6: Same-directory chapter links: ../xx.md or ./xx.md → ./xx (cleanUrls)
  content = content.replace(
    /\[([^\]]+)\]\(\.\.?\/(\d{2}[^)]*)\.md\)/g,
    `[$1](./$2)`
  );

  // Step 7: Catch-all: remaining .md link suffixes (cleanUrls)
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
