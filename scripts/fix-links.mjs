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
