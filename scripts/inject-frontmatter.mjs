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
