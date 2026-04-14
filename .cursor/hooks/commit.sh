#!/usr/bin/env bash
# 会话结束：默认只写提示；设置 CURSOR_HOOK_AUTO_COMMIT=1 时才尝试 git commit（sessionEnd）
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
NOTE="$SCRIPT_DIR/session-commit-hint.log"

ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if git -C "$ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  ROOT="$(git -C "$ROOT" rev-parse --show-toplevel)"
fi

{
  echo "[$STAMP] sessionEnd — workspace: $ROOT"
  if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$ROOT" status --short || true
  else
    echo "(not a git repo)"
  fi
  echo "---"
} >>"$NOTE" 2>/dev/null || true

if [[ "${CURSOR_HOOK_AUTO_COMMIT:-}" == "1" ]] && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  if [[ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]]; then
    git -C "$ROOT" add -A
    git -C "$ROOT" commit -m "chore(cursor): auto commit after session ${STAMP}" || true
  fi
fi

exit 0
