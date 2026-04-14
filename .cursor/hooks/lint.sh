#!/usr/bin/env bash
# 保存后对单文件跑 ESLint（若存在本地 eslint）
set -euo pipefail
INPUT="$(cat)"

FILE="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("file_path") or "")' <<<"$INPUT" 2>/dev/null || echo "")"
[[ -z "$FILE" || ! -f "$FILE" ]] && { echo '{}'; exit 0; }

case "$FILE" in
  *.js|*.mjs|*.cjs|*.ts|*.tsx|*.jsx) ;;
  *) echo '{}'; exit 0 ;;
esac

DIR="$(dirname "$FILE")"
for _ in {1..20}; do
  E="$DIR/node_modules/.bin/eslint"
  if [[ -x "$E" ]]; then
    (cd "$DIR" && "$E" "$FILE" --max-warnings=0 2>/dev/null) || true
    break
  fi
  [[ "$DIR" == "/" ]] && break
  DIR="$(dirname "$DIR")"
done

echo '{}'
exit 0
