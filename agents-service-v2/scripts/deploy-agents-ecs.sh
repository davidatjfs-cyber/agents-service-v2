#!/usr/bin/env bash
# 将本地 agents-service-v2 同步到阿里云 ECS 并重启 pm2。
# 默认先跑 verify-agents-local.sh；跳过验证：SKIP_VERIFY=1
# 用法：ECS_HOST=root@47.100.96.30 REMOTE_DIR=/opt/agents-service-v2 ./scripts/deploy-agents-ecs.sh
#
# 说明：若使用「密码」登录 SSH，请不要在脚本里加 BatchMode=yes（会禁止交互密码）；
#       rsync 与下面两段 ssh 可能各提示一次密码。建议配置 ssh-copy-id 免密。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ECS_HOST="${ECS_HOST:-root@47.100.96.30}"
REMOTE_DIR="${REMOTE_DIR:-/opt/agents-service-v2}"

if [[ "${SKIP_VERIFY:-0}" != "1" ]]; then
  bash "${ROOT}/scripts/verify-agents-local.sh"
else
  echo ">>> SKIP_VERIFY=1 — skipped local verify"
fi

echo ">>> rsync -> ${ECS_HOST}:${REMOTE_DIR}/"
rsync -avz -e ssh \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '.pnpm-store' \
  --exclude 'dist' \
  "${ROOT}/" "${ECS_HOST}:${REMOTE_DIR}/"

# 合并为一次 SSH：少输一次密码；务必看到下方打印的 JSON（含 replyEngine）再关终端
echo ">>> remote: npm install + pm2 restart + health"
ssh -o ConnectTimeout=60 "${ECS_HOST}" \
  "cd '${REMOTE_DIR}' && if [ -f '.env.production' ]; then grep -q '^ENABLE_AUTOMATIONS=false\$' '.env.production' 2>/dev/null && sed -i 's/^ENABLE_AUTOMATIONS=false\$/ENABLE_AUTOMATIONS=true/' '.env.production' || true; sed -i 's/^ENABLE_DB_WRITE=false\$/ENABLE_DB_WRITE=true/' '.env.production' 2>/dev/null || true; grep -q '^ENABLE_DB_WRITE=' '.env.production' 2>/dev/null || echo 'ENABLE_DB_WRITE=true' >> '.env.production'; fi && (npm ci --omit=dev 2>/dev/null || npm install --omit=dev) && node scripts/apply-analysis-sop-sql.mjs && node scripts/apply-strategy-rules-sql.mjs && node scripts/apply-strategy-rules-tags-sql.mjs && node scripts/apply-agent-experience-context-sql.mjs && node scripts/apply-anomaly-rules-v2.mjs && node scripts/apply-private-room-column.mjs && echo '>>> 彻底清理 3101 端口占用...' && (pm2 stop agents-service-v2 2>/dev/null || true) && (pm2 delete agents-service-v2 2>/dev/null || true) && (fuser -k 3101/tcp 2>/dev/null || true) && (lsof -ti:3101 2>/dev/null | xargs -r kill -9 || true) && sleep 3 && echo '>>> 3101 端口已释放' && pm2 start '${REMOTE_DIR}/src/index.js' --name agents-service-v2 --update-env && sleep 6 && echo '--- health ---' && H=\$(curl -sS -m 10 http://127.0.0.1:3101/health) && echo \"\$H\" && echo \"\$H\" | grep -q '\"replyEngine\"' || { echo 'ERROR: /health 无 replyEngine — 常见原因：另有 node 占用 3101（非 pm2）。在服务器执行: ss -tlnp | grep 3101；若非 pm2 的 node 则 kill 该 pid 后再 pm2 restart agents-service-v2。' >&2; exit 1; }"
echo ""
echo "Done. replyEngine 应与 src/reply-engine-version.js 中 REPLY_ENGINE_BUILD 一致。"
