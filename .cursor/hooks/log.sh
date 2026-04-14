#!/usr/bin/env bash
# 终端命令审计日志（afterShellExecution，JSON Lines）
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$SCRIPT_DIR/shell-audit.logl"
INPUT="$(cat)"

export LOG_FILE
printf '%s' "$INPUT" | python3 -c '
import json, sys, datetime, os
path = os.environ.get("LOG_FILE", "")
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    d = {"parse_error": True, "raw": (raw or "")[:800]}
line = json.dumps(
    {
        "ts": datetime.datetime.utcnow().isoformat() + "Z",
        "command": d.get("command"),
        "duration": d.get("duration"),
        "sandbox": d.get("sandbox"),
    },
    ensure_ascii=False,
)
if path:
    with open(path, "a", encoding="utf-8") as f:
        f.write(line + "\n")
'

echo '{}'
exit 0
