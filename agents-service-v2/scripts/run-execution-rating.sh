#!/usr/bin/env bash
# 管理端手动触发「一日评」：POST /api/rhythm/execution-rating
#
# 用法（在 agents-service-v2 目录或任意目录）：
#   export AGENTS_SERVICE_URL=https://你的域名或IP:3101
#   export ADMIN_USERNAME=admin
#   export ADMIN_PASSWORD='你的密码'
#   bash scripts/run-execution-rating.sh
# 可选：指定业务日（默认由服务端按「昨天·上海」计算）
#   export RATING_DATE=2026-04-08
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

BASE="${AGENTS_SERVICE_URL:-http://127.0.0.1:${PORT:-3101}}"
BASE="${BASE%/}"

if ! command -v curl >/dev/null 2>&1; then
  echo "需要 curl" >&2
  exit 1
fi

if [[ -z "${ADMIN_USERNAME:-}" || -z "${ADMIN_PASSWORD:-}" ]]; then
  echo "请设置 ADMIN_USERNAME 与 ADMIN_PASSWORD（与 /api/login 一致，admin 账号见 ADMIN_USERNAME/ADMIN_PASSWORD 环境变量）" >&2
  exit 1
fi

LOGIN_JSON=$(curl -sS -X POST "${BASE}/api/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${ADMIN_USERNAME}\",\"password\":\"${ADMIN_PASSWORD}\"}")

TOKEN=$(printf '%s' "$LOGIN_JSON" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "登录失败，响应: $LOGIN_JSON" >&2
  exit 1
fi

BODY='{}'
if [[ -n "${RATING_DATE:-}" ]]; then
  BODY=$(printf '{"date":"%s"}' "$RATING_DATE")
fi

echo ">>> POST ${BASE}/api/rhythm/execution-rating  body=${BODY}"
curl -sS -X POST "${BASE}/api/rhythm/execution-rating" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "$BODY"
echo
