#!/usr/bin/env bash
# 将本地 agents-service-v2 同步到阿里云 ECS 并重启 pm2。
# 部署入口 / 易错点 / 其它场景脚本：见同目录上级文档 agents-service-v2/部署到ECS-看这里.md
# 默认先跑 verify-agents-local.sh；跳过验证：SKIP_VERIFY=1
# 默认在 monorepo 下会顺带跑 ../scripts/deploy-hrms-frontend.sh；仅 agents：HRMS_FRONTEND_DEPLOY=0
# 用法：ECS_HOST=root@47.100.96.30 REMOTE_DIR=/opt/agents-service-v2 ./scripts/deploy-agents-ecs.sh
#
# 说明：若使用「密码」登录 SSH，请不要在脚本里加 BatchMode=yes（会禁止交互密码）；
#       rsync 与下面两段 ssh 可能各提示一次密码。建议配置 ssh-copy-id 免密。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "${ROOT}/.." && pwd)"
ECS_HOST="${ECS_HOST:-root@47.100.96.30}"
REMOTE_DIR="${REMOTE_DIR:-/opt/agents-service-v2}"
BITABLE_TASK_RESP_APP_ID="${BITABLE_TASK_RESP_APP_ID:-cli_a9fc0d13c838dcd6}"
BITABLE_TASK_RESP_APP_SECRET="${BITABLE_TASK_RESP_APP_SECRET:-pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN}"

# 与「部署到ECS-看这里.md」一致：src 有变更时必须同范围递增 reply-engine-version.js，否则 /health 无法反映真实发布
if [[ "${SKIP_REPLY_ENGINE_BUMP_CHECK:-0}" != "1" ]] && git -C "${REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BASE_REF="${AGENTS_DEPLOY_BASE_REF:-origin/main}"
  if git -C "${REPO_ROOT}" rev-parse "${BASE_REF}" >/dev/null 2>&1; then
    _SRC_DIFF="$(git -C "${REPO_ROOT}" diff --name-only "${BASE_REF}...HEAD" -- agents-service-v2/src/ 2>/dev/null || true)"
    if echo "${_SRC_DIFF}" | grep -q .; then
      if echo "${_SRC_DIFF}" | grep -qv '^agents-service-v2/src/reply-engine-version.js$'; then
        if ! echo "${_SRC_DIFF}" | grep -q '^agents-service-v2/src/reply-engine-version.js$'; then
          echo "::error::agents-service-v2/src 相对 ${BASE_REF} 有变更，但未在同一提交范围内修改 agents-service-v2/src/reply-engine-version.js（REPLY_ENGINE_BUILD）。" >&2
          echo "请先递增 REPLY_ENGINE_BUILD 并提交，或 SKIP_REPLY_ENGINE_BUMP_CHECK=1 跳过此检查。" >&2
          exit 1
        fi
      fi
    fi
  fi
fi

if [[ "${SKIP_VERIFY:-0}" != "1" ]]; then
  bash "${ROOT}/scripts/verify-agents-local.sh"
else
  echo ">>> SKIP_VERIFY=1 — skipped local verify"
fi

# AGENTS_DEPLOY_REQUIRE_BACKUP=1（默认）时备份失败或未生成文件则阻断发布；健康检查失败时远端尝试 AGENTS_ROLLBACK_TGZ 回滚。
AGENTS_ROLLBACK_TGZ=""
AGENTS_BACKUP_BEFORE_DEPLOY="${AGENTS_BACKUP_BEFORE_DEPLOY:-1}"
AGENTS_DEPLOY_REQUIRE_BACKUP="${AGENTS_DEPLOY_REQUIRE_BACKUP:-1}"
if [[ "${AGENTS_BACKUP_BEFORE_DEPLOY}" == "1" ]]; then
  BAK_TS="$(date +%Y%m%d%H%M%S)"
  AGENTS_ROLLBACK_TGZ="/opt/deploy-backups/agents/agents_${BAK_TS}.tar.gz"
  echo ">>> remote code backup -> ${AGENTS_ROLLBACK_TGZ}"
  if ! ssh -o ConnectTimeout=60 "${ECS_HOST}" bash -s <<EOF
set -euo pipefail
mkdir -p /opt/deploy-backups/agents
if [[ -d "${REMOTE_DIR}" ]] && [[ -f "${REMOTE_DIR}/package.json" ]]; then
  tar czf "${AGENTS_ROLLBACK_TGZ}" -C "${REMOTE_DIR}" \\
    --exclude=node_modules --exclude=.git .
fi
EOF
  then
    echo "::error::agents 远端备份失败" >&2
    AGENTS_ROLLBACK_TGZ=""
    if [[ "${AGENTS_DEPLOY_REQUIRE_BACKUP}" == "1" ]]; then exit 1; fi
  elif [[ -n "${AGENTS_ROLLBACK_TGZ}" ]] && ! ssh -o ConnectTimeout=60 "${ECS_HOST}" "test -f '${AGENTS_ROLLBACK_TGZ}'"; then
    echo "::error::备份文件未生成: ${AGENTS_ROLLBACK_TGZ}" >&2
    AGENTS_ROLLBACK_TGZ=""
    if [[ "${AGENTS_DEPLOY_REQUIRE_BACKUP}" == "1" ]]; then exit 1; fi
  fi
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
# 未加引号 heredoc 会在本机展开 ${VERIFY_KNOWLEDGE_STRICT}；配合 set -u 必须先有默认值。
VERIFY_KNOWLEDGE_STRICT="${VERIFY_KNOWLEDGE_STRICT:-0}"
echo ">>> remote: npm install + pm2 ecosystem (3101) + health"
ssh -o ConnectTimeout=60 "${ECS_HOST}" \
  "BITABLE_TASK_RESP_APP_ID='${BITABLE_TASK_RESP_APP_ID}' BITABLE_TASK_RESP_APP_SECRET='${BITABLE_TASK_RESP_APP_SECRET}' AGENTS_ROLLBACK_TGZ='${AGENTS_ROLLBACK_TGZ}' bash -s" <<EOS
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
[[ -n "\${ADMIN_PASSWORD:-}" ]] && ensure_kv .env ADMIN_PASSWORD "\${ADMIN_PASSWORD}" || true
ensure_kv .env BITABLE_TASK_RESP_APP_ID "\${BITABLE_TASK_RESP_APP_ID}"
ensure_kv .env BITABLE_TASK_RESP_APP_SECRET "\${BITABLE_TASK_RESP_APP_SECRET}"
[[ -f .env.production ]] && ensure_kv .env.production PORT 3101 || true
[[ -f .env.production ]] && ensure_kv .env.production CONFIRM_PRODUCTION true || true
[[ -f .env.production ]] && [[ -n "\${ADMIN_PASSWORD:-}" ]] && ensure_kv .env.production ADMIN_PASSWORD "\${ADMIN_PASSWORD}" || true
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
if ! echo "\$H" | grep -q '"replyEngine"'; then
  echo 'ERROR: /health 无 replyEngine — 尝试回滚' >&2
  RB="${AGENTS_ROLLBACK_TGZ:-}"
  if [[ -n "\$RB" ]] && [[ -f "\$RB" ]]; then
    pm2 delete agents-service-v2 2>/dev/null || true
    sleep 1
    cd "${REMOTE_DIR}" || exit 1
    tar xzf "\$RB" --overwrite 2>/dev/null || true
    (npm ci --omit=dev 2>/dev/null || npm install --omit=dev) || true
    pm2 start ecosystem.config.cjs --update-env
    sleep 6
    H2=\$(curl -sS -m 10 http://127.0.0.1:3101/health)
    echo "\$H2"
    echo "\$H2" | grep -q '"replyEngine"' && echo 'WARN: 回滚后 /health 已恢复 replyEngine' >&2 || true
  fi
  exit 1
fi
# --- pm2 错误日志尾采（关卡0：可观测性基线）---
echo '--- pm2 最近错误日志（agents-service-v2）---'
AGENTS_ERR_LOG=\$(ls -t /root/.pm2/logs/agents-service-v2-error-*.log 2>/dev/null | head -1)
if [[ -n "\$AGENTS_ERR_LOG" ]]; then
  tail -15 "\$AGENTS_ERR_LOG" 2>/dev/null || echo '（无错误日志）'
else
  echo '（无错误日志文件）'
fi
echo '--- pm2 最近错误日志（hrms-service）---'
HRMS_ERR_LOG=\$(ls -t /root/.pm2/logs/hrms-service-error-*.log 2>/dev/null | head -1)
if [[ -n "\$HRMS_ERR_LOG" ]]; then
  tail -15 "\$HRMS_ERR_LOG" 2>/dev/null || echo '（无错误日志）'
else
  echo '（无错误日志文件或 hrms-service 未运行）'
fi
# --- 日志尾采结束 ---
echo '--- mempalace /health (disk persistence) ---'
curl -sS -m 6 http://127.0.0.1:3001/health | grep -q '"persistence":"disk"' && echo 'OK: MemPalace persistence=disk' || echo 'WARN: MemPalace /health 未返回 persistence=disk（检查 pm2 mempalace-http）'
echo '--- verify knowledge / DeepSeek→Ollama / wiki / mempalace ---'
VERIFY_KNOWLEDGE_STRICT="${VERIFY_KNOWLEDGE_STRICT:-0}"
if cd "${REMOTE_DIR}" && node scripts/verify-knowledge-llm-chain.mjs 2>&1; then
  echo 'OK: verify-knowledge-llm-chain'
else
  if [[ "${VERIFY_KNOWLEDGE_STRICT}" == "1" ]]; then
    echo 'ERROR: verify-knowledge-llm-chain 失败且 VERIFY_KNOWLEDGE_STRICT=1，阻断发布' >&2
    exit 1
  else
    echo 'WARN: verify-knowledge-llm-chain 退出非 0；设置 VERIFY_KNOWLEDGE_STRICT=1 可在 CI/发布中阻断' >&2
  fi
fi
EOS
echo ""
LOCAL_RE="$(grep -oE "REPLY_ENGINE_BUILD = '[^']+'" "${ROOT}/src/reply-engine-version.js" | sed "s/.*'\([^']*\)'.*/\1/")"
echo "Done. 本次包内 REPLY_ENGINE_BUILD=${LOCAL_RE}；远端 /health 的 replyEngine 应与之相同。"

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
