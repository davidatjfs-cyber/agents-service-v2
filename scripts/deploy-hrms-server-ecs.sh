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

# 部署前远端 tar 备份；HRMS_DEPLOY_REQUIRE_BACKUP=1（默认）时备份失败或未生成文件则阻断发布。
# 健康检查失败时，远端会尝试用 HRMS_ROLLBACK_TGZ 解压回滚后再退出非 0。
HRMS_ROLLBACK_TGZ=""
HRMS_BACKUP_BEFORE_DEPLOY="${HRMS_BACKUP_BEFORE_DEPLOY:-1}"
HRMS_DEPLOY_REQUIRE_BACKUP="${HRMS_DEPLOY_REQUIRE_BACKUP:-1}"
if [[ "${HRMS_BACKUP_BEFORE_DEPLOY}" == "1" ]]; then
  BAK_TS="$(date +%Y%m%d%H%M%S)"
  HRMS_ROLLBACK_TGZ="/opt/deploy-backups/hrms/hrms_${BAK_TS}.tar.gz"
  echo ">>> remote code backup -> ${HRMS_ROLLBACK_TGZ}"
  if ! ssh -o ConnectTimeout=60 "${ECS_HOST}" bash -s <<EOF
set -euo pipefail
mkdir -p /opt/deploy-backups/hrms
if [[ -d "${REMOTE_DIR}" ]] && [[ -f "${REMOTE_DIR}/index.js" || -f "${REMOTE_DIR}/package.json" ]]; then
  tar czf "${HRMS_ROLLBACK_TGZ}" -C "${REMOTE_DIR}" \\
    --exclude=node_modules --exclude=.git --exclude=uploads .
fi
EOF
  then
    echo "::error::HRMS 远端备份失败" >&2
    HRMS_ROLLBACK_TGZ=""
    if [[ "${HRMS_DEPLOY_REQUIRE_BACKUP}" == "1" ]]; then exit 1; fi
  elif [[ -n "${HRMS_ROLLBACK_TGZ}" ]] && ! ssh -o ConnectTimeout=60 "${ECS_HOST}" "test -f '${HRMS_ROLLBACK_TGZ}'"; then
    echo "::error::备份文件未生成（目录可能为空）: ${HRMS_ROLLBACK_TGZ}" >&2
    HRMS_ROLLBACK_TGZ=""
    if [[ "${HRMS_DEPLOY_REQUIRE_BACKUP}" == "1" ]]; then exit 1; fi
  fi
fi

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
HRMS_SW_TMP="$(mktemp)"
HRMS_SW_VER="hrms-pwa-$(date +%Y%m%d%H%M%S)"
sed -E "s/^const CACHE_NAME = '[^']+'/const CACHE_NAME = '${HRMS_SW_VER}'/" "${LOCAL_WEB}/sw.js" > "$HRMS_SW_TMP"
trap 'rm -f "$HRMS_SW_TMP"' EXIT
echo "    (sw.js 部署使用 CACHE_NAME=${HRMS_SW_VER})"
rsync -avz -e ssh \
  "${LOCAL_WEB}/working-fixed.html" \
  "${LOCAL_WEB}/mobile-nav-production.html" \
  "${ECS_HOST}:${REMOTE_WEB_ROOT}/"
rsync -avz -e ssh "$HRMS_SW_TMP" "${ECS_HOST}:${REMOTE_WEB_ROOT}/sw.js"

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

# nginx root=/opt/hrms 时，浏览器请求 /uploads/* 映射到磁盘 /opt/hrms/uploads/*；
# Multer 与 Express.static 实际写入的是 /opt/hrms/server/uploads/*。
# 若两者不一致，营业日报「日结单」等图片在域名下会 404（直连 :3000 却正常）——用符号链接对齐。
# 注意：本段经未引用 heredoc 发往远端，\$ 勿用于 UP_*，应写全 \${REMOTE_WEB_ROOT} 以免本地 set -u 展开空变量。
mkdir -p "${REMOTE_WEB_ROOT}/server/uploads"
if [[ -L "${REMOTE_WEB_ROOT}/uploads" ]]; then
  rm -f "${REMOTE_WEB_ROOT}/uploads"
elif [[ -d "${REMOTE_WEB_ROOT}/uploads" ]]; then
  # Check if uploads dir has files (capture to var to avoid pipefail+SIGPIPE)
  UPLOADS_HAS_FILES=$(find "${REMOTE_WEB_ROOT}/uploads" -mindepth 1 -print -quit 2>/dev/null || true)
  if [[ -n "$UPLOADS_HAS_FILES" ]]; then
    mv "${REMOTE_WEB_ROOT}/uploads" "${REMOTE_WEB_ROOT}/uploads.bak.$(date +%s)"
  else
    rmdir "${REMOTE_WEB_ROOT}/uploads" 2>/dev/null || mv "${REMOTE_WEB_ROOT}/uploads" "${REMOTE_WEB_ROOT}/uploads.bak.$(date +%s)"
  fi
fi
ln -sfn "${REMOTE_WEB_ROOT}/server/uploads" "${REMOTE_WEB_ROOT}/uploads"
echo ">>> OK: Web 根 uploads 已指向真实目录: ${REMOTE_WEB_ROOT}/uploads -> ${REMOTE_WEB_ROOT}/server/uploads"
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
# 仅清理本目录 HRMS 入口，禁止匹配全局「node index.js」以免误杀其它 PM2 应用导致 502
pkill -9 -f "${REMOTE_DIR}/index.js" 2>/dev/null || true
sleep 1
fuser -k 3000/tcp 2>/dev/null || true
sleep 2
# Verify port is free (capture to var first to avoid pipefail+SIGPIPE)
PORT_LISTENING=$(ss -tlnp 2>/dev/null)
if echo "$PORT_LISTENING" | grep -q ':3000 '; then
  echo '>>> WARNING: 3000 仍被占用，强制清理' >&2
  fuser -k 3000/tcp 2>/dev/null || true
  sleep 2
fi
pm2 start ecosystem.config.cjs --update-env
echo "--- wait for HRMS listen on 3000 ---"
sleep 5
for i in $(seq 1 20); do
  if curl -sS -m 3 http://127.0.0.1:3000/api/health >/tmp/hrms_h.txt 2>/dev/null; then
    echo "--- /api/health (ok after ${i} tries) ---"
    head -c 500 /tmp/hrms_h.txt
    echo
    exit 0
  fi
  sleep 3
done
echo "::error::HRMS /api/health 未就绪（20 次重试）"
RB="${HRMS_ROLLBACK_TGZ:-}"
if [[ -n "$RB" ]] && [[ -f "$RB" ]]; then
  echo ">>> canary 失败：尝试从部署前备份回滚 $RB"
  pm2 delete hrms-service 2>/dev/null || true
  sleep 1
  cd "$REMOTE_DIR" || exit 1
  tar xzf "$RB" --overwrite 2>/dev/null || true
  (npm ci --omit=dev 2>/dev/null || npm install --omit=dev 2>/dev/null) || true
  pm2 start ecosystem.config.cjs --update-env
  sleep 8
  if curl -sS -m 4 http://127.0.0.1:3000/api/health >/tmp/hrms_rb.txt 2>/dev/null; then
    echo "::warning::回滚后 /api/health 已恢复；请检查本次发布内容与 pm2 日志"
    head -c 400 /tmp/hrms_rb.txt
    echo
  fi
fi
echo "::error::HRMS /api/health 未就绪，请 pm2 logs hrms-service"
curl -sS -m 5 http://127.0.0.1:3000/api/health | head -c 500 || true
echo
exit 1
EOS
)

ssh -o ConnectTimeout=60 "$ECS_HOST" \
  "REMOTE_DIR='${REMOTE_DIR}' DISABLE_SCHEDULED_CHECKLIST='${DISABLE_SCHEDULED_CHECKLIST}' BITABLE_TASK_RESP_APP_ID='${BITABLE_TASK_RESP_APP_ID}' BITABLE_TASK_RESP_APP_SECRET='${BITABLE_TASK_RESP_APP_SECRET}' HRMS_ROLLBACK_TGZ='${HRMS_ROLLBACK_TGZ}' bash -s" <<< "$REMOTE_SCRIPT"

echo "Done."
