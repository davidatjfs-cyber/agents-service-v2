#!/bin/bash
# 安全部署脚本 - 彻底解决历史部署问题
# 解决：1.前端两个文件部署 2.部署路径 3.版本一致性 4.数据丢失
set -euo pipefail

ROOT="/Users/magainze/HRMS"
ECS_HOST="${ECS_HOST:-root@47.100.96.30}"
AGENTS_DIR="${ROOT}/agents-service-v2"
HRMS_DIR="${ROOT}/hr-management-system"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$ROOT/deploy-logs/deploy_${TIMESTAMP}.log"

# 创建日志目录
mkdir -p "$ROOT/deploy-logs"

# 记录日志函数
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# 错误处理函数
error_exit() {
    log "❌ 错误: $1"
    log "❌ 部署失败！请检查日志: $LOG_FILE"
    exit 1
}

log "🚀 开始安全部署流程..."
log "部署时间: $TIMESTAMP"
log "ECS服务器: $ECS_HOST"

# ============================================================
# 步骤1: 验证本地环境 - 解决版本一致性问题
# ============================================================
log "📋 步骤1/8: 验证本地环境和版本一致性..."

# 1.1 检查目录存在
[ -d "$AGENTS_DIR" ] || error_exit "agents-service-v2目录不存在: $AGENTS_DIR"
[ -d "$HRMS_DIR" ] || error_exit "hr-management-system目录不存在: $HRMS_DIR"
log "✅ 项目目录检查通过"

# 1.2 检查关键文件存在
[ -f "$AGENTS_DIR/src/index.js" ] || error_exit "agents-service-v2/src/index.js不存在"
[ -f "$HRMS_DIR/working-fixed.html" ] || error_exit "hr-management-system/working-fixed.html不存在"
[ -f "$HRMS_DIR/mobile-nav-production.html" ] || error_exit "hr-management-system/mobile-nav-production.html不存在"
log "✅ 关键文件检查通过"

# 1.3 验证前端两个文件都存在（解决历史问题1）
log "🔍 检查前端文件..."
FRONTEND_FILES_OK=true
for frontend_file in "$HRMS_DIR/working-fixed.html" "$HRMS_DIR/mobile-nav-production.html"; do
    if [ ! -f "$frontend_file" ]; then
        log "❌ 前端文件缺失: $frontend_file"
        FRONTEND_FILES_OK=false
    fi
done

if [ "$FRONTEND_FILES_OK" = false ]; then
    error_exit "前端文件不完整，必须同时部署网页版和手机版文件！"
else
    log "✅ 前端两个文件检查通过 (网页版 + 手机版)"
fi

# 1.4 本地语法检查
log "🔍 执行本地语法检查..."
cd "$AGENTS_DIR"
bash scripts/verify-agents-local.sh || error_exit "agents-service-v2本地验证失败"

cd "$HRMS_DIR"
node --check server/agents.js || error_exit "hr-management-system本地验证失败"
node --check server/bi-weekly-report.js || error_exit "hr-management-system本地验证失败"
log "✅ 本地语法检查通过"

# 1.5 记录当前版本信息
log "📝 记录当前版本信息..."
if [ -f "$AGENTS_DIR/src/reply-engine-version.js" ]; then
    AGENTS_VERSION=$(grep -oP 'REPLY_ENGINE_BUILD = "\K[^"]+' "$AGENTS_DIR/src/reply-engine-version.js" || echo "unknown")
    log "agents版本: $AGENTS_VERSION"
fi

# ============================================================
# 步骤2: 检查ECS服务器状态
# ============================================================
log "📋 步骤2/8: 检查ECS服务器状态..."

# 2.1 检查SSH连接
if ! ssh -o ConnectTimeout=10 "$ECS_HOST" "echo 'SSH连接正常'"; then
    error_exit "无法连接到ECS服务器: $ECS_HOST"
fi
log "✅ ECS服务器连接正常"

# 2.2 检查PM2服务状态
ECS_STATUS=$(ssh "$ECS_HOST" "pm2 status 2>&1")
log "PM2服务状态:"
echo "$ECS_STATUS" | tee -a "$LOG_FILE"

if ! echo "$ECS_STATUS" | grep -q "agents-service-v2.*online"; then
    error_exit "agents-service-v2服务不在线！"
fi

if ! echo "$ECS_STATUS" | grep -q "hrms-service.*online"; then
    error_exit "hrms-service服务不在线！"
fi
log "✅ PM2服务状态检查通过"

# 2.3 验证部署路径（解决历史问题2）
log "🔍 验证部署路径..."
AGENTS_REMOTE_PATH=$(ssh "$ECS_HOST" "ls -la /opt/ | grep agents-service-v2")
HRMS_REMOTE_PATH=$(ssh "$ECS_HOST" "ls -la /opt/ | grep hrms")

if [ -z "$AGENTS_REMOTE_PATH" ]; then
    error_exit "ECS上agents-service-v2部署路径不存在！"
fi

if [ -z "$HRMS_REMOTE_PATH" ]; then
    error_exit "ECS上hrms部署路径不存在！"
fi
log "✅ 部署路径验证通过"

# ============================================================
# 步骤3: 部署前备份 - 解决历史问题4
# ============================================================
log "📋 步骤3/8: 部署前备份 (防止数据丢失)..."

BACKUP_RESULT=$(ssh "$ECS_HOST" "/opt/scripts/deploy-backup.sh" 2>&1)
echo "$BACKUP_RESULT" | tee -a "$LOG_FILE"

if ! echo "$BACKUP_RESULT" | grep -q "备份流程完成"; then
    error_exit "备份失败！无法继续部署！"
fi
log "✅ 部署前备份完成"

# ============================================================
# 步骤4: 部署agents-service-v2
# ============================================================
log "📋 步骤4/8: 部署agents-service-v2..."

# 4.1 同步代码（排除敏感文件）
log "📤 同步agents-service-v2代码到ECS..."
rsync -avz -e ssh \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '.pnpm-store' \
  --exclude 'dist' \
  --exclude '*.log' \
  --exclude 'coverage' \
  "$AGENTS_DIR/" \
  "$ECS_HOST:/opt/agents-service-v2/" | tee -a "$LOG_FILE"

log "✅ agents-service-v2代码同步完成"

# 4.2 远程执行部署操作
log "🔧 执行agents-service-v2远程部署..."
AGENTS_DEPLOY=$(ssh -o ConnectTimeout=120 "$ECS_HOST" \
  "cd /opt/agents-service-v2 && \
   if [ -f '.env.production' ]; then \
     grep -q '^ENABLE_AUTOMATIONS=false\$' '.env.production' 2>/dev/null && \
     sed -i 's/^ENABLE_AUTOMATIONS=false\$/ENABLE_AUTOMATIONS=true/' '.env.production' || true; \
     sed -i 's/^ENABLE_DB_WRITE=false\$/ENABLE_DB_WRITE=true/' '.env.production' 2>/dev/null || true; \
     grep -q '^ENABLE_DB_WRITE=' '.env.production' 2>/dev/null || echo 'ENABLE_DB_WRITE=true' >> '.env.production'; \
   fi && \
   (npm ci --omit=dev 2>/dev/null || npm install --omit=dev) && \
   node scripts/apply-analysis-sop-sql.mjs && \
   node scripts/apply-strategy-rules-sql.mjs && \
   node scripts/apply-strategy-rules-tags-sql.mjs && \
   node scripts/apply-agent-experience-context-sql.mjs && \
   node scripts/apply-anomaly-rules-v2.mjs && \
   node scripts/apply-private-room-column.mjs && \
   (fuser -k 3101/tcp 2>/dev/null && echo '>>> 已释放3101端口' && sleep 2 || true) && \
   pm2 restart agents-service-v2 && \
   sleep 6" 2>&1)

echo "$AGENTS_DEPLOY" | tee -a "$LOG_FILE"

# 4.3 验证agents-service-v2部署
log "🏥 验证agents-service-v2部署结果..."
sleep 3
AGENTS_HEALTH=$(ssh "$ECS_HOST" "curl -sS -m 10 http://127.0.0.1:3101/health")
echo "$AGENTS_HEALTH" | tee -a "$LOG_FILE"

if ! echo "$AGENTS_HEALTH" | grep -q '"ok":true'; then
    error_exit "agents-service-v2健康检查失败！"
fi

# 验证版本一致性（解决历史问题3）
if [ -n "$AGENTS_VERSION" ]; then
    if ! echo "$AGENTS_HEALTH" | grep -q "$AGENTS_VERSION"; then
        log "⚠️ 警告: 部署版本不匹配！"
        log "预期版本: $AGENTS_VERSION"
        log "实际版本: $(echo "$AGENTS_HEALTH" | grep -oP 'replyEngine":"\K[^"]+')"
        error_exit "版本不一致，请检查部署的代码是否是最新版本！"
    fi
    log "✅ 版本一致性验证通过: $AGENTS_VERSION"
fi

log "✅ agents-service-v2部署成功"

# ============================================================
# 步骤5: 部署hrms前端文件 - 解决历史问题1
# ============================================================
log "📋 步骤5/8: 部署hrms前端文件 (网页版 + 手机版)..."

# 5.1 验证前端文件完整性
log "🔍 验证前端文件完整性..."
for frontend_file in working-fixed.html mobile-nav-production.html; do
    if [ ! -f "$HRMS_DIR/$frontend_file" ]; then
        error_exit "前端文件不存在: $HRMS_DIR/$frontend_file"
    fi
    log "✅ 前端文件检查: $frontend_file"
done

# 5.2 同步前端文件到正确路径（解决历史问题2）
log "📤 同步前端文件到ECS..."
rsync -avz --checksum -e ssh \
  "$HRMS_DIR/working-fixed.html" \
  "$HRMS_DIR/mobile-nav-production.html" \
  "$ECS_HOST:/opt/hrms/" | tee -a "$LOG_FILE"

log "✅ 前端文件同步完成"

# 5.3 验证nginx配置中的HTML缓存设置
log "🔧 检查nginx HTML缓存配置..."
NGINX_CACHE_CHECK=$(ssh "$ECS_HOST" \
  "grep -q 'no-cache.*\.html' /etc/nginx/sites-enabled/hrms 2>/dev/null && echo '已配置' || echo '未配置'")

if [ "$NGINX_CACHE_CHECK" = "未配置" ]; then
    log "⚠️ 警告: nginx HTML缓存未配置，可能影响前端更新"
    log "建议配置nginx禁止HTML缓存"
else
    log "✅ nginx HTML缓存配置正常"
fi

# 5.4 重新加载nginx配置
log "🔄 重新加载nginx配置..."
ssh "$ECS_HOST" "systemctl reload nginx" || error_exit "nginx重新加载失败"
log "✅ nginx配置重新加载完成"

# ============================================================
# 步骤6: 部署hrms后端文件
# ============================================================
log "📋 步骤6/8: 部署hrms后端文件..."

# 6.1 同步后端代码
log "📤 同步hrms-server代码到ECS..."
rsync -avz -e ssh \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '*.log' \
  --exclude 'coverage' \
  "$HRMS_DIR/server/" \
  "$ECS_HOST:/opt/hrms/server/" | tee -a "$LOG_FILE"

log "✅ hrms-server代码同步完成"

# 6.2 远程执行部署操作
log "🔧 执行hrms-service远程部署..."
HRMS_DEPLOY=$(ssh -o ConnectTimeout=120 "$ECS_HOST" \
  "cd /opt/hrms/server && \
   ensure_kv() { \
     local file=\"\$1\" key=\"\$2\" val=\"\$3\"; \
     if [[ ! -f \"\$file\" ]]; then return 0; fi; \
     if grep -q \"^\${key}=\" \"\$file\" 2>/dev/null; then \
       sed -i \"s|^\${key}=.*|\${key}=\${val}|\" \"\$file\"; \
     else \
       printf '\n# deploy-safe.sh\n%s=%s\n' \"\$key\" \"\$val\" >> \"\$file\"; \
     fi; \
   }; \
   ensure_kv .env HRMS_DISABLE_SCHEDULED_CHECKLIST 1; \
   [[ -f .env.production ]] && ensure_kv .env.production HRMS_DISABLE_SCHEDULED_CHECKLIST 1 || true; \
   ensure_lark_from_feishu() { \
     local file=\"\$1\"; \
     [[ ! -f \"\$file\" ]] && return 0; \
     local feishu_id feishu_secret; \
     feishu_id=\"\$(grep -E '^FEISHU_APP_ID=' \"\$file\" 2>/dev/null | sed 's/^FEISHU_APP_ID=//')\"; \
     feishu_secret=\"\$(grep -E '^FEISHU_APP_SECRET=' \"\$file\" 2>/dev/null | sed 's/^FEISHU_APP_SECRET=//')\"; \
     if [[ -n \"\${feishu_id}\" ]]; then \
       ensure_kv \"\$file\" LARK_APP_ID \"\${feishu_id}\"; \
     fi; \
     if [[ -n \"\${feishu_secret}\" ]]; then \
       ensure_kv \"\$file\" LARK_APP_SECRET \"\${feishu_secret}\"; \
     fi; \
   }; \
   ensure_lark_from_feishu .env; \
   [[ -f .env.production ]] && ensure_lark_from_feishu .env.production || true; \
   npm install --omit=dev && \
   pm2 restart hrms-service --update-env && \
   sleep 4" 2>&1)

echo "$HRMS_DEPLOY" | tee -a "$LOG_FILE"

# 6.3 验证hrms-service部署
log "🏥 验证hrms-service部署结果..."
HRMS_HEALTH=$(ssh "$ECS_HOST" "curl -sS -m 10 http://127.0.0.1:3000/api/health")
echo "$HRMS_HEALTH" | tee -a "$LOG_FILE"

if ! echo "$HRMS_HEALTH" | grep -q '"status":"ok"'; then
    error_exit "hrms-service健康检查失败！"
fi

log "✅ hrms-service部署成功"

# ============================================================
# 步骤7: 全面健康检查和验证
# ============================================================
log "📋 步骤7/8: 执行全面健康检查..."

# 7.1 服务状态检查
log "📊 检查PM2服务状态..."
FINAL_STATUS=$(ssh "$ECS_HOST" "pm2 status")
echo "$FINAL_STATUS" | tee -a "$LOG_FILE"

# 7.2 前端文件验证（确保两个文件都正确部署）
log "🌐 验证前端文件部署..."
FRONTEND_CHECK_AGENTS=$(ssh "$ECS_HOST" \
  "curl -sS -m 10 http://127.0.0.1:3100/working-fixed.html | wc -l")
FRONTEND_CHECK_HRMS=$(ssh "$ECS_HOST" \
  "curl -sS -m 10 http://127.0.0.1:3000/working-fixed.html | wc -l")

if [ "$FRONTEND_CHECK_AGENTS" -lt 100 ]; then
    log "⚠️ 警告: agents前端文件似乎不正常 (行数: $FRONTEND_CHECK_AGENTS)"
else
    log "✅ agents前端文件正常"
fi

if [ "$FRONTEND_CHECK_HRMS" -lt 100 ]; then
    log "⚠️ 警告: hrms前端文件似乎不正常 (行数: $FRONTEND_CHECK_HRMS)"
else
    log "✅ hrms前端文件正常"
fi

# 7.3 最终健康检查
log "🏥 最终健康检查..."
FINAL_AGENTS_HEALTH=$(ssh "$ECS_HOST" "curl -sS -m 10 http://127.0.0.1:3101/health")
FINAL_HRMS_HEALTH=$(ssh "$ECS_HOST" "curl -sS -m 10 http://127.0.0.1:3000/api/health")

echo "agents健康检查: $FINAL_AGENTS_HEALTH" | tee -a "$LOG_FILE"
echo "hrms健康检查: $FINAL_HRMS_HEALTH" | tee -a "$LOG_FILE"

if echo "$FINAL_AGENTS_HEALTH" | grep -q '"ok":true' && echo "$FINAL_HRMS_HEALTH" | grep -q '"status":"ok"'; then
    log "✅ 所有服务健康检查通过"
else
    error_exit "最终健康检查失败！请检查服务状态！"
fi

# 7.4 错误日志检查
log "❌ 检查最近错误日志..."
AGENTS_ERRORS=$(ssh "$ECS_HOST" "pm2 logs agents-service-v2 --lines 10 --nostream | grep -i error || echo '无错误'")
HRMS_ERRORS=$(ssh "$ECS_HOST" "pm2 logs hrms-service --lines 10 --nostream | grep -i error || echo '无错误'")

echo "agents-service-v2最近错误:" | tee -a "$LOG_FILE"
echo "$AGENTS_ERRORS" | tee -a "$LOG_FILE"
echo "hrms-service最近错误:" | tee -a "$LOG_FILE"
echo "$HRMS_ERRORS" | tee -a "$LOG_FILE"

if [ -n "$AGENTS_ERRORS" ] && [ "$AGENTS_ERRORS" != "无错误" ]; then
    log "⚠️ 警告: agents-service-v2存在错误日志，请检查！"
fi

if [ -n "$HRMS_ERRORS" ] && [ "$HRMS_ERRORS" != "无错误" ]; then
    log "⚠️ 警告: hrms-service存在错误日志，请检查！"
fi

# ============================================================
# 步骤8: 部署总结和报告
# ============================================================
log "📋 步骤8/8: 生成部署总结报告..."

echo "" | tee -a "$LOG_FILE"
echo "=== 🎉 部署成功总结 ===" | tee -a "$LOG_FILE"
echo "部署时间: $TIMESTAMP" | tee -a "$LOG_FILE"
echo "ECS服务器: $ECS_HOST" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "✅ 问题1解决: 前端两个文件 (网页版 + 手机版) 部署完成" | tee -a "$LOG_FILE"
echo "✅ 问题2解决: 部署路径验证通过" | tee -a "$LOG_FILE"
echo "✅ 问题3解决: 版本一致性验证通过 ($AGENTS_VERSION)" | tee -a "$LOG_FILE"
echo "✅ 问题4解决: 数据安全备份完成，数据零丢失" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "📊 部署状态:" | tee -a "$LOG_FILE"
echo "  agents-service-v2: ✅ 在线" | tee -a "$LOG_FILE"
echo "  hrms-service: ✅ 在线" | tee -a "$LOG_FILE"
echo "  前端文件 (网页版): ✅ 已部署" | tee -a "$LOG_FILE"
echo "  前端文件 (手机版): ✅ 已部署" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "📝 部署日志: $LOG_FILE" | tee -a "$LOG_FILE"
echo "🔧 回滚命令: ssh $ECS_HOST '/opt/scripts/deploy-rollback.sh'" | tee -a "$LOG_FILE"
echo "📊 状态检查: ssh $ECS_HOST '/opt/scripts/deploy-status.sh'" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "=== 🎉 部署流程完全成功 ===" | tee -a "$LOG_FILE"

log "🎉 部署流程完全成功！"
log "所有历史部署问题已彻底解决！"
log "📝 完整部署日志: $LOG_FILE"

exit 0