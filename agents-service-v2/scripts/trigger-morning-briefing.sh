#!/usr/bin/env bash
# 包装：用 Node 调登录 + 发晨报（避免 shell 拼 JSON 出错）
# 用法见 部署到ECS-看这里.md
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/trigger-morning-briefing.mjs"
