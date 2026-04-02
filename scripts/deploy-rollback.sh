#!/bin/bash
# 一键回滚到上一个版本
BACKUP_DIR="/opt/deploy-backups"
LOG_FILE="$BACKUP_DIR/rollback_$(date +%Y%m%d_%H%M%S).log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始回滚流程..." | tee -a "$LOG_FILE"

# 检查备份是否存在
if [ ! -f "$BACKUP_DIR/latest.txt" ]; then
    echo "❌ 找不到备份记录文件: $BACKUP_DIR/latest.txt" | tee -a "$LOG_FILE"
    echo "请先执行至少一次成功部署" | tee -a "$LOG_FILE"
    exit 1
fi

LATEST=$(cat "$BACKUP_DIR/latest.txt")
echo "准备回滚到版本: $LATEST" | tee -a "$LOG_FILE"

# 1. 停止当前服务
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 停止当前服务..." | tee -a "$LOG_FILE"
pm2 stop agents-service-v2
pm2 stop hrms-service

# 2. 回滚agents代码
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 回滚agents代码..." | tee -a "$LOG_FILE"
if [ -f "$BACKUP_DIR/agents/agents_${LATEST}.tar.gz" ]; then
    cd /opt
    rm -rf agents-service-v2.old
    mv agents-service-v2 agents-service-v2.old
    mkdir -p agents-service-v2
    tar -xzf "$BACKUP_DIR/agents/agents_${LATEST}.tar.gz" -C /opt/agents-service-v2
    echo "✅ agents代码回滚完成" | tee -a "$LOG_FILE"
else
    echo "❌ agents代码备份文件不存在: agents_${LATEST}.tar.gz" | tee -a "$LOG_FILE"
    echo "恢复旧agents代码..." | tee -a "$LOG_FILE"
    if [ -d "/opt/agents-service-v2.old" ]; then
        rm -rf agents-service-v2
        mv agents-service-v2.old agents-service-v2
        echo "✅ 恢复旧agents代码" | tee -a "$LOG_FILE"
    fi
fi

# 3. 回滚hrms代码
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 回滚hrms代码..." | tee -a "$LOG_FILE"
if [ -f "$BACKUP_DIR/hrms/hrms_${LATEST}.tar.gz" ]; then
    cd /opt/hrms/server
    rm -rf hrms-server.old
    mv server hrms-server.old
    mkdir -p server
    tar -xzf "$BACKUP_DIR/hrms/hrms_${LATEST}.tar.gz" -C /opt/hrms/server
    echo "✅ hrms代码回滚完成" | tee -a "$LOG_FILE"
else
    echo "❌ hrms代码备份文件不存在: hrms_${LATEST}.tar.gz" | tee -a "$LOG_FILE"
    echo "恢复旧hrms代码..." | tee -a "$LOG_FILE"
    if [ -d "/opt/hrms/server.old" ]; then
        rm -rf server
        mv hrms-server.old server
        echo "✅ 恢复旧hrms代码" | tee -a "$LOG_FILE"
    fi
fi

# 4. 回滚配置文件
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 回滚配置文件..." | tee -a "$LOG_FILE"
if [ -f "$BACKUP_DIR/agents/env_${LATEST}.production" ]; then
    cp "$BACKUP_DIR/agents/env_${LATEST}.production" /opt/agents-service-v2/.env.production
    echo "✅ agents配置回滚完成" | tee -a "$LOG_FILE"
elif [ -f "$BACKUP_DIR/agents/env_${LATEST}" ]; then
    cp "$BACKUP_DIR/agents/env_${LATEST}" /opt/agents-service-v2/.env
    echo "✅ agents配置回滚完成" | tee -a "$LOG_FILE"
fi

if [ -f "$BACKUP_DIR/hrms/env_${LATEST}" ]; then
    cp "$BACKUP_DIR/hrms/env_${LATEST}" /opt/hrms/server/.env
    echo "✅ hrms配置回滚完成" | tee -a "$LOG_FILE"
fi

# 5. 回滚数据库
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 回滚数据库..." | tee -a "$LOG_FILE"
DATABASE_ROLLBACK_SUCCESS=0

# 尝试多个可能的数据库备份
for sql_file in "$BACKUP_DIR/database/agents_${LATEST}.sql" "$BACKUP_DIR/database/hrms_${LATEST}.sql" "$BACKUP_DIR/database/all_databases_${LATEST}.sql"; do
    if [ -f "$sql_file" ]; then
        echo "找到数据库备份: $sql_file" | tee -a "$LOG_FILE"
        
        # 从agents配置获取数据库连接信息
        if [ -f "/opt/agents-service-v2/.env" ]; then
            source /opt/agents-service-v2/.env
            if [ -n "$DATABASE_URL" ]; then
                echo "使用agents数据库配置恢复..." | tee -a "$LOG_FILE"
                if psql "$DATABASE_URL" < "$sql_file" 2>>"$LOG_FILE"; then
                    echo "✅ 数据库回滚完成: $(basename $sql_file)" | tee -a "$LOG_FILE"
                    DATABASE_ROLLBACK_SUCCESS=1
                fi
            fi
        fi
        
        # 如果agents配置失败，尝试hrms配置
        if [ "$DATABASE_ROLLBACK_SUCCESS" -eq 0 ] && [ -f "/opt/hrms/server/.env" ]; then
            source /opt/hrms/server/.env
            if [ -n "$DATABASE_URL" ]; then
                echo "使用hrms数据库配置恢复..." | tee -a "$LOG_FILE"
                if psql "$DATABASE_URL" < "$sql_file" 2>>"$LOG_FILE"; then
                    echo "✅ 数据库回滚完成: $(basename $sql_file)" | tee -a "$LOG_FILE"
                    DATABASE_ROLLBACK_SUCCESS=1
                fi
            fi
        fi
        
        break
    fi
done

if [ "$DATABASE_ROLLBACK_SUCCESS" -eq 0 ]; then
    echo "❌ 数据库回滚失败，未找到合适的备份文件" | tee -a "$LOG_FILE"
    echo "⚠️  请手动检查数据库并恢复" | tee -a "$LOG_FILE"
fi

# 6. 重新安装依赖
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 重新安装依赖..." | tee -a "$LOG_FILE"
cd /opt/agents-service-v2
npm install --omit=dev 2>>"$LOG_FILE"
echo "✅ agents依赖安装完成" | tee -a "$LOG_FILE"

cd /opt/hrms/server  
npm install --omit=dev 2>>"$LOG_FILE"
echo "✅ hrms依赖安装完成" | tee -a "$LOG_FILE"

# 7. 重启服务
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 重启服务..." | tee -a "$LOG_FILE"
pm2 restart agents-service-v2
pm2 restart hrms-service

# 8. 等待服务启动
echo "等待服务启动..." | tee -a "$LOG_FILE"
sleep 5

# 9. 健康检查
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 执行健康检查..." | tee -a "$LOG_FILE"
AGENTS_HEALTH=$(curl -s http://127.0.0.1:3101/health)
HRMS_HEALTH=$(curl -s http://127.0.0.1:3000/api/health)

echo "agents健康检查结果: $AGENTS_HEALTH" | tee -a "$LOG_FILE"
echo "hrms健康检查结果: $HRMS_HEALTH" | tee -a "$LOG_FILE"

if echo "$AGENTS_HEALTH" | grep -q '"ok":true' && echo "$HRMS_HEALTH" | grep -q '"status":"ok"'; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ 回滚成功！服务运行正常" | tee -a "$LOG_FILE"
    pm2 status
    exit 0
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ 回滚后健康检查失败！" | tee -a "$LOG_FILE"
    echo "请手动检查服务状态" | tee -a "$LOG_FILE"
    pm2 logs --lines 20
    exit 1
fi