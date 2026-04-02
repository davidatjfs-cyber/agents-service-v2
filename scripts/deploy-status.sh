#!/bin/bash
# 部署状态和系统健康检查

echo "=== 🚀 系统部署状态检查 ==="
echo "检查时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# 1. PM2服务状态
echo "📊 PM2服务状态:"
pm2 status
echo ""

# 2. 健康检查
echo "🏥 健康检查:"
echo "agents-service-v2 (端口3101):"
AGENTS_HEALTH=$(curl -s http://127.0.0.1:3101/health)
echo "$AGENTS_HEALTH" | head -200
echo ""

echo "hrms-service (端口3000):"
HRMS_HEALTH=$(curl -s http://127.0.0.1:3000/api/health)  
echo "$HRMS_HEALTH" | head -200
echo ""

# 3. 最近备份
echo "💾 最近备份状态:"
if [ -f "/opt/deploy-backups/latest.txt" ]; then
    LATEST=$(cat /opt/deploy-backups/latest.txt)
    echo "最新备份时间: $LATEST"
    echo ""
    echo "agents备份:"
    ls -lh /opt/deploy-backups/agents/ | tail -3
    echo ""
    echo "hrms备份:"
    ls -lh /opt/deploy-backups/hrms/ | tail -3
    echo ""
    echo "数据库备份:"
    ls -lh /opt/deploy-backups/database/ | tail -3
else
    echo "⚠️  尚无备份记录"
fi
echo ""

# 4. 错误日志
echo "❌ 最近错误日志:"
echo "agents-service-v2错误:"
pm2 logs agents-service-v2 --lines 10 --nostream | grep -i error || echo "无错误"
echo ""
echo "hrms-service错误:"
pm2 logs hrms-service --lines 10 --nostream | grep -i error || echo "无错误"
echo ""

# 5. 磁盘空间
echo "💿 磁盘空间:"
df -h | grep -E "Filesystem|/opt"
echo ""

# 6. 内存使用
echo "🧠 内存使用:"
free -h
echo ""

echo "=== ✅ 检查完成 ==="