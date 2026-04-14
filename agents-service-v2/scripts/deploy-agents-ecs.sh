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
BITABLE_TASK_RESP_APP_ID="${BITABLE_TASK_RESP_APP_ID:-cli_a9fc0d13c838dcd6}"
BITABLE_TASK_RESP_APP_SECRET="${BITABLE_TASK_RESP_APP_SECRET:-pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN}"

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

REPO_ROOT="$(cd "${ROOT}/.." && pwd)"
MP_LOCAL="${REPO_ROOT}/mempalace"
if [[ -d "${MP_LOCAL}" && -f "${MP_LOCAL}/package.json" ]]; then
  echo ">>> rsync mempalace -> ${ECS_HOST}:/opt/mempalace/"
  rsync -avz -e ssh \
    --exclude 'node_modules' \
    --exclude '.git' \
    "${MP_LOCAL}/" "${ECS_HOST}:/opt/mempalace/"
else
  echo ">>> skip mempalace rsync (not found: ${MP_LOCAL})"
fi

# 合并为一次 SSH：固定 PORT=3101（ecosystem.config.cjs），删 pm2 后再起；仅当 3101 仍被占才 fuser
echo ">>> remote: npm install + pm2 ecosystem (3101) + health"
ssh -o ConnectTimeout=60 "${ECS_HOST}" \
  "BITABLE_TASK_RESP_APP_ID='${BITABLE_TASK_RESP_APP_ID}' BITABLE_TASK_RESP_APP_SECRET='${BITABLE_TASK_RESP_APP_SECRET}' bash -s" <<EOS
set -euo pipefail
cd "${REMOTE_DIR}"
ensure_kv() {
  local file="\$1" key="\$2" val="\$3"
  [[ -f "\$file" ]] || return 0
  if grep -q "^\${key}=" "\$file" 2>/dev/null; then
    sed -i "s|^\${key}=.*|\${key}=\${val}|" "\$file"
  else
    printf '\n# deploy-agents-ecs.sh\n%s=%s\n' "\$key" "\$val" >> "\$file"
  fi
}
if [[ -f '.env.production' ]]; then
  grep -q '^ENABLE_AUTOMATIONS=false\$' '.env.production' 2>/dev/null && sed -i 's/^ENABLE_AUTOMATIONS=false\$/ENABLE_AUTOMATIONS=true/' '.env.production' || true
  sed -i 's/^ENABLE_DB_WRITE=false\$/ENABLE_DB_WRITE=true/' '.env.production' 2>/dev/null || true
  grep -q '^ENABLE_DB_WRITE=' '.env.production' 2>/dev/null || echo 'ENABLE_DB_WRITE=true' >> '.env.production'
fi
ensure_kv .env PORT 3101
ensure_kv .env CONFIRM_PRODUCTION true
ensure_kv .env BITABLE_TASK_RESP_APP_ID "\${BITABLE_TASK_RESP_APP_ID}"
ensure_kv .env BITABLE_TASK_RESP_APP_SECRET "\${BITABLE_TASK_RESP_APP_SECRET}"
[[ -f .env.production ]] && ensure_kv .env.production PORT 3101 || true
[[ -f .env.production ]] && ensure_kv .env.production CONFIRM_PRODUCTION true || true
[[ -f .env.production ]] && ensure_kv .env.production BITABLE_TASK_RESP_APP_ID "\${BITABLE_TASK_RESP_APP_ID}" || true
[[ -f .env.production ]] && ensure_kv .env.production BITABLE_TASK_RESP_APP_SECRET "\${BITABLE_TASK_RESP_APP_SECRET}" || true
(npm ci --omit=dev 2>/dev/null || npm install --omit=dev)
node scripts/apply-analysis-sop-sql.mjs
node scripts/apply-strategy-rules-sql.mjs
node scripts/apply-strategy-rules-tags-sql.mjs
node scripts/apply-agent-experience-context-sql.mjs
node scripts/apply-anomaly-rules-v2.mjs
node scripts/apply-private-room-column.mjs

# MemPalace：与 agents 同机 HTTP 记忆服务（营销策划 recall）；未同步 /opt/mempalace 时跳过
if [[ -f /opt/mempalace/package.json ]]; then
  cd /opt/mempalace
  (npm ci --omit=dev 2>/dev/null || npm install --omit=dev)
  pm2 delete mempalace-http 2>/dev/null || true
  sleep 1
  fuser -k 3001/tcp 2>/dev/null || true
  sleep 1
  PORT=3001 pm2 start src/server.js --name mempalace-http --update-env
  sleep 2
  cd "${REMOTE_DIR}"
  ensure_kv .env MEMPALACE_URL http://127.0.0.1:3001
  [[ -f .env.production ]] && ensure_kv .env.production MEMPALACE_URL http://127.0.0.1:3001 || true
  ensure_kv .env ENABLE_MEMPALACE true
  [[ -f .env.production ]] && ensure_kv .env.production ENABLE_MEMPALACE true || true
  echo ">>> MemPalace PM2: mempalace-http (PORT=3001) + ENABLE_MEMPALACE=true"
else
  cd "${REMOTE_DIR}"
  echo ">>> MemPalace: /opt/mempalace 不存在，跳过（agents 仍可用，记忆注入关闭直至部署 mempalace）"
fi

# 彻底清理：先 PM2 delete，再杀所有孤儿 node 进程，最后释放端口
pm2 delete agents-service-v2 2>/dev/null || true
sleep 1
# Kill ALL node processes running src/index.js (orphans from bad previous deploys)
pkill -9 -f "node.*agents-service-v2/src/index" 2>/dev/null || true
pkill -9 -f "/usr/bin/node src/index.js" 2>/dev/null || true
sleep 1
fuser -k 3101/tcp 2>/dev/null || true
sleep 2
# Verify port is free
if ss -tlnp 2>/dev/null | grep -q ':3101 '; then
  echo '>>> WARNING: 3101 仍被占用，强制清理' >&2
  fuser -k 3101/tcp 2>/dev/null || true
  sleep 2
fi
pm2 start ecosystem.config.cjs --update-env
sleep 6
echo '--- health ---'
H=\$(curl -sS -m 10 http://127.0.0.1:3101/health)
echo "\$H"
echo "\$H" | grep -q '"replyEngine"' || { echo 'ERROR: /health 无 replyEngine — ss -tlnp | grep 3101 查看占用' >&2; exit 1; }
echo '--- mempalace /health (disk persistence) ---'
curl -sS -m 6 http://127.0.0.1:3001/health | grep -q '"persistence":"disk"' && echo 'OK: MemPalace persistence=disk' || echo 'WARN: MemPalace /health 未返回 persistence=disk（检查 pm2 mempalace-http）'
echo '--- verify knowledge / DeepSeek→Ollama / wiki / mempalace ---'
cd "${REMOTE_DIR}" && node scripts/verify-knowledge-llm-chain.mjs 2>&1 || echo 'WARN: verify-knowledge-llm-chain 退出非 0（见上 JSON）'
EOS
echo ""
echo "Done. replyEngine 应与 src/reply-engine-version.js 中 REPLY_ENGINE_BUILD 一致。"

# HRMS 静态入口（nginx /opt/hrms）：与 agents 同 ECS 时随本次部署一并发布；独立仓库无 ../scripts 则跳过
HRMS_FRONTEND_DEPLOY="${HRMS_FRONTEND_DEPLOY:-1}"
if [[ "${HRMS_FRONTEND_DEPLOY}" == "1" ]]; then
  HRMS_FE_SCRIPT="${REPO_ROOT}/scripts/deploy-hrms-frontend.sh"
  if [[ -f "${HRMS_FE_SCRIPT}" ]]; then
    echo ""
    echo ">>> HRMS 静态资源（working-fixed.html / sw.js 等）→ ${ECS_HOST}:/opt/hrms/"
    bash "${HRMS_FE_SCRIPT}"
  else
    echo ""
    echo ">>> skip HRMS 静态部署（未找到 ${HRMS_FE_SCRIPT}，仅 agents-service-v2 单仓时属正常）"
  fi
else
  echo ""
  echo ">>> SKIP_HRMS_FRONTEND=1 — 已跳过 HRMS 静态部署"
fi
