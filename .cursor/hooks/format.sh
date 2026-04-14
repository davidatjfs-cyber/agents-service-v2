#!/usr/bin/env bash
# 保存后尝试 Prettier（afterFileEdit，无 stdout 约束时仍应输出合法 JSON）
set -euo pipefail
INPUT="$(cat)"

FILE="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("file_path") or "")' <<<"$INPUT" 2>/dev/null || echo "")"
[[ -z "$FILE" || ! -f "$FILE" ]] && { echo '{}'; exit 0; }

case "$FILE" in
  *.js|*.mjs|*.cjs|*.ts|*.tsx|*.jsx|*.json|*.css|*.html|*.md|*.yaml|*.yml) ;;
  *) echo '{}'; exit 0 ;;
esac

# 自文件向上查找 node_modules/.bin/prettier
DIR="$(dirname "$FILE")"
for _ in {1..20}; do
  P="$DIR/node_modules/.bin/prettier"
  if [[ -x "$P" ]]; then
    "$P" --write "$FILE" 2>/dev/null || true
    break
  fi
  [[ "$DIR" == "/" ]] && break
  DIR="$(dirname "$DIR")"
done

echo '{}'
exit 0
