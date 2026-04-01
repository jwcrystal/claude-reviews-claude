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

# Step 6: Copy homepage files (manually maintained, not generated)
# docs/index.md, docs/en/index.md, docs/zh-CN/index.md are committed directly

echo "✅ Docs content prepared."
