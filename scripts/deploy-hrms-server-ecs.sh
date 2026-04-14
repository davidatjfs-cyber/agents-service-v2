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
LOCAL_WEB="$(cd "$(dirname "$0")/../hr-management-system" && pwd)"
DISABLE_SCHEDULED_CHECKLIST="${DISABLE_SCHEDULED_CHECKLIST:-1}"
BITABLE_TASK_RESP_APP_ID="${BITABLE_TASK_RESP_APP_ID:-cli_a9fc0d13c838dcd6}"
BITABLE_TASK_RESP_APP_SECRET="${BITABLE_TASK_RESP_APP_SECRET:-pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN}"
REMOTE_WEB_ROOT="${REMOTE_WEB_ROOT:-/opt/hrms}"
REMOTE_WEB_ROOT_ALT="${REMOTE_WEB_ROOT_ALT:-/var/www/hrms}"

echo ">>> node --check (local index.js + agents.js + bi-weekly-report.js)"
node --check "${LOCAL_SRC}/index.js"
node --check "${LOCAL_SRC}/agents.js"
node --check "${LOCAL_SRC}/bi-weekly-report.js"

echo ">>> rsync -> ${ECS_HOST}:${REMOTE_DIR}/"
rsync -avz -e ssh \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.env' \
  --exclude '.env.*' \
  "${LOCAL_SRC}/" "${ECS_HOST}:${REMOTE_DIR}/"

echo ">>> rsync web (nginx root) -> ${ECS_HOST}:${REMOTE_WEB_ROOT}/ (+ optional alt)"
# Express `webRootDir` is `path.resolve(__dirname, '..')` relative to server/index.js,
# which maps to `/opt/hrms` on ECS (NOT `/opt/hrms/server`). If we only rsync server/,
# frontend HTML changes will never reach production.
rsync -avz -e ssh \
  "${LOCAL_WEB}/working-fixed.html" \
  "${LOCAL_WEB}/mobile-nav-production.html" \
  "${ECS_HOST}:${REMOTE_WEB_ROOT}/"

# Keep legacy mirror paths in sync if they exist on the host (best-effort).
ssh -o ConnectTimeout=60 "${ECS_HOST}" "bash -s" <<EOS2
set -euo pipefail
mkdir -p "${REMOTE_WEB_ROOT}/hr-management-system" || true
cp -f "${REMOTE_WEB_ROOT}/working-fixed.html" "${REMOTE_WEB_ROOT}/hr-management-system/working-fixed.html" || true
cp -f "${REMOTE_WEB_ROOT}/mobile-nav-production.html" "${REMOTE_WEB_ROOT}/hr-management-system/mobile-nav-production.html" || true
if [[ -d "${REMOTE_WEB_ROOT_ALT}" ]]; then
  cp -f "${REMOTE_WEB_ROOT}/working-fixed.html" "${REMOTE_WEB_ROOT_ALT}/working-fixed.html" || true
  cp -f "${REMOTE_WEB_ROOT}/mobile-nav-production.html" "${REMOTE_WEB_ROOT_ALT}/mobile-nav-production.html" || true
fi
EOS2

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
ensure_kv .env PORT 3000
ensure_kv .env BITABLE_TASK_RESP_APP_ID "$BITABLE_TASK_RESP_APP_ID"
ensure_kv .env BITABLE_TASK_RESP_APP_SECRET "$BITABLE_TASK_RESP_APP_SECRET"
[[ -f .env.production ]] && ensure_kv .env.production PORT 3000 || true
[[ -f .env.production ]] && ensure_kv .env.production BITABLE_TASK_RESP_APP_ID "$BITABLE_TASK_RESP_APP_ID" || true
[[ -f .env.production ]] && ensure_kv .env.production BITABLE_TASK_RESP_APP_SECRET "$BITABLE_TASK_RESP_APP_SECRET" || true
# 数据中心健康条合并 agents-service /health（MemPalace、Wiki 等）
ensure_kv .env AGENTS_SERVICE_HEALTH_URL http://127.0.0.1:3101/health
[[ -f .env.production ]] && ensure_kv .env.production AGENTS_SERVICE_HEALTH_URL http://127.0.0.1:3101/health || true
# 彻底清理：先 PM2 delete，再杀所有孤儿 node 进程，最后释放端口
pm2 delete hrms-service 2>/dev/null || true
sleep 1
pkill -9 -f "node.*hrms/server/index" 2>/dev/null || true
pkill -9 -f "node index.js" 2>/dev/null || true
sleep 1
fuser -k 3000/tcp 2>/dev/null || true
sleep 2
if ss -tlnp 2>/dev/null | grep -q ':3000 '; then
  echo '>>> WARNING: 3000 仍被占用，强制清理' >&2
  fuser -k 3000/tcp 2>/dev/null || true
  sleep 2
fi
pm2 start ecosystem.config.cjs --update-env
echo "--- wait for HRMS listen on 3000 ---"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sS -m 2 http://127.0.0.1:3000/api/health >/tmp/hrms_h.txt 2>/dev/null; then
    echo "--- /api/health (ok after ${i}s) ---"
    head -c 500 /tmp/hrms_h.txt
    echo
    exit 0
  fi
  sleep 2
done
echo "::error::HRMS /api/health 未就绪（10 次重试），请 pm2 logs hrms-service"
curl -sS -m 5 http://127.0.0.1:3000/api/health | head -c 500 || true
echo
exit 1
EOS
)

ssh -o ConnectTimeout=60 "$ECS_HOST" \
  "REMOTE_DIR='${REMOTE_DIR}' DISABLE_SCHEDULED_CHECKLIST='${DISABLE_SCHEDULED_CHECKLIST}' BITABLE_TASK_RESP_APP_ID='${BITABLE_TASK_RESP_APP_ID}' BITABLE_TASK_RESP_APP_SECRET='${BITABLE_TASK_RESP_APP_SECRET}' bash -s" <<< "$REMOTE_SCRIPT"

echo "Done."
