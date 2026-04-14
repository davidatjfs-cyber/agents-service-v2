#!/usr/bin/env bash
# Write 成功后做轻量校验：node --check；可选 jest 单文件（postToolUse）
set -euo pipefail
INPUT="$(cat)"

TOOL="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("tool_name") or "")' <<<"$INPUT" 2>/dev/null || echo "")"
[[ "$TOOL" != "Write" ]] && { echo '{}'; exit 0; }

FILE="$(python3 -c '
import json,sys
d=json.load(sys.stdin)
ti=d.get("tool_input")
if isinstance(ti, str):
    try:
        ti = json.loads(ti)
    except Exception:
        ti = {}
if not isinstance(ti, dict):
    ti = {}
for k in ("file_path", "path", "target_file", "file"):
    v = ti.get(k)
    if v:
        print(v)
        break
' <<<"$INPUT" 2>/dev/null || echo "")"

[[ -z "$FILE" || ! -f "$FILE" ]] && { echo '{}'; exit 0; }

# JS 语法检查（不依赖 node_modules）
case "$FILE" in
  *.js|*.mjs|*.cjs)
    node --check "$FILE" 2>/dev/null || true
    ;;
esac

# agents-service-v2：若改到测试或源码且存在 jest，可跑单测（较慢，仅匹配 test 路径）
if [[ "$FILE" == *"/agents-service-v2/"* ]] && [[ "$FILE" == *".test.js" || "$FILE" == *".spec.js" || "$FILE" == *"/test/"* ]]; then
  ROOT="${FILE%%/agents-service-v2/*}/agents-service-v2"
  if [[ -f "$ROOT/package.json" ]] && [[ -x "$ROOT/node_modules/.bin/jest" ]]; then
    (cd "$ROOT" && ./node_modules/.bin/jest --runTestsByPath "$FILE" --passWithNoTests 2>/dev/null) || true
  fi
fi

echo '{}'
exit 0
