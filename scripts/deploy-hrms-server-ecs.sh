#!/usr/bin/env bash
# 将本地 hr-management-system/server 同步到阿里云 ECS 的 /opt/hrms/server 并重启 pm2 hrms-service。
# 可选：设置 HRMS_DISABLE_SCHEDULED_CHECKLIST=1 关闭 V1 定时检查单（默认开启写入 .env）
#
# 用法：
#   ./scripts/deploy-hrms-server-ecs.sh
#   DISABLE_SCHEDULED_CHECKLIST=0 ./scripts/deploy-hrms-server-ecs.sh   # 仅发代码不关停检查单
#
# 默认 ECS：root@47.100.96.30（与 agents 部署脚本一致）
set -euo pipefail
ECS_HOST="${ECS_HOST:-root@47.100.96.30}"
REMOTE_DIR="${REMOTE_DIR:-/opt/hrms/server}"
LOCAL_SRC="$(cd "$(dirname "$0")/../hr-management-system/server" && pwd)"
DISABLE_SCHEDULED_CHECKLIST="${DISABLE_SCHEDULED_CHECKLIST:-1}"

echo ">>> node --check (local agents.js + bi-weekly-report.js)"
node --check "${LOCAL_SRC}/agents.js"
node --check "${LOCAL_SRC}/bi-weekly-report.js"

echo ">>> rsync -> ${ECS_HOST}:${REMOTE_DIR}/"
rsync -avz -e ssh \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.env' \
  --exclude '.env.*' \
  "${LOCAL_SRC}/" "${ECS_HOST}:${REMOTE_DIR}/"

REMOTE_SCRIPT=$(cat <<'EOS'
set -euo pipefail
cd "$REMOTE_DIR"
ensure_kv() {
  local file="$1" key="$2" val="$3"
  if [[ ! -f "$file" ]]; then
    echo ">>> WARN: ${file} 不存在，跳过写入 ${key}（禁止创建仅含单项的 .env，避免丢失 DATABASE_URL）" >&2
    return 0
  fi
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    # 使用 | 分隔符，避免 val 中含 / 时破坏 sed
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  else
    printf '\n# deploy-hrms-server-ecs.sh\n%s=%s\n' "$key" "$val" >> "$file"
  fi
}
if [[ "${DISABLE_SCHEDULED_CHECKLIST}" == "1" ]]; then
  ensure_kv .env HRMS_DISABLE_SCHEDULED_CHECKLIST 1
  [[ -f .env.production ]] && ensure_kv .env.production HRMS_DISABLE_SCHEDULED_CHECKLIST 1 || true
  echo ">>> HRMS_DISABLE_SCHEDULED_CHECKLIST=1 已写入 .env（及 .env.production 若存在）"
fi
ensure_lark_from_feishu() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local feishu_id feishu_secret
  feishu_id="$(grep -E '^FEISHU_APP_ID=' "$file" 2>/dev/null | sed 's/^FEISHU_APP_ID=//')"
  feishu_secret="$(grep -E '^FEISHU_APP_SECRET=' "$file" 2>/dev/null | sed 's/^FEISHU_APP_SECRET=//')"
  if [[ -n "${feishu_id}" ]]; then
    ensure_kv "$file" LARK_APP_ID "$feishu_id"
  fi
  if [[ -n "${feishu_secret}" ]]; then
    ensure_kv "$file" LARK_APP_SECRET "$feishu_secret"
  fi
}
ensure_lark_from_feishu .env
[[ -f .env.production ]] && ensure_lark_from_feishu .env.production || true
pm2 restart hrms-service --update-env
sleep 4
echo "--- /api/health ---"
curl -sS -m 15 http://127.0.0.1:3000/api/health | head -c 500
echo
EOS
)

ssh -o ConnectTimeout=60 "$ECS_HOST" \
  "REMOTE_DIR='${REMOTE_DIR}' DISABLE_SCHEDULED_CHECKLIST='${DISABLE_SCHEDULED_CHECKLIST}' bash -s" <<< "$REMOTE_SCRIPT"

echo "Done."
