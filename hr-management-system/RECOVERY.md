# HRMS 系统恢复手册

> 服务器：47.100.96.30（阿里云 ECS，Ubuntu 20.04）  
> 服务：hrms.service（systemd）  
> 数据库：PostgreSQL / hrms  
> 备份目录：/opt/hrms/backups/  
> 最后更新：2026-03-02

---

## 快速状态检查

```bash
ssh root@47.100.96.30
systemctl status hrms.service
curl -s http://127.0.0.1:3000/api/health | python3 -m json.tool
journalctl -u hrms.service --since "30 minutes ago" | tail -50
```

---

## 场景一：服务崩溃 / 进程挂掉

**症状**：用户无法访问系统，飞书机器人无响应

```bash
# 1. 检查服务状态
systemctl status hrms.service

# 2. 重启服务
systemctl restart hrms.service
sleep 5
systemctl status hrms.service

# 3. 检查日志定位原因
journalctl -u hrms.service -n 100 --no-pager

# 4. 验证恢复
curl -s http://127.0.0.1:3000/api/health
```

**预期恢复时间**：< 5 分钟

---

## 场景二：服务器宕机（无法 SSH）

**症状**：SSH 超时，网站无法访问

```bash
# 1. 登录阿里云控制台
#    https://ecs.console.aliyun.com
#    找到实例 47.100.96.30 → 点击「重启」

# 2. 等待 2-3 分钟后 SSH 登录
ssh root@47.100.96.30

# 3. 检查服务是否自动恢复
systemctl status hrms.service

# 4. 若未自动启动（systemd 有 Restart=always，正常会自动恢复）
systemctl start hrms.service

# 5. 验证
curl -s http://127.0.0.1:3000/api/health
```

**预期恢复时间**：< 30 分钟

---

## 场景三：数据库损坏 / 数据误删

**症状**：服务日志出现 `database connection failed` 或数据异常

```bash
# 1. 先停止应用（避免继续写入损坏数据）
systemctl stop hrms.service

# 2. 备份当前（损坏的）状态
pg_dump -U postgres hrms > /tmp/hrms_broken_$(date +%Y%m%d).sql

# 3. 查看可用备份列表
ls -lth /opt/hrms/backups/

# 4. 删除损坏的数据库并重建
psql -U postgres -c "DROP DATABASE IF EXISTS hrms;"
psql -U postgres -c "CREATE DATABASE hrms OWNER hrms;"

# 5. 恢复最近的备份（替换为实际文件名）
LATEST=$(ls -t /opt/hrms/backups/hrms_*.sql.gz | head -1)
echo "恢复备份: $LATEST"
gunzip -c "$LATEST" | psql -U postgres hrms

# 6. 重启应用
systemctl start hrms.service
sleep 5
curl -s http://127.0.0.1:3000/api/health

# 7. 验证关键表数据
psql -U postgres -d hrms -c "SELECT COUNT(*) FROM users;"
psql -U postgres -d hrms -c "SELECT COUNT(*) FROM sales_raw;"
psql -U postgres -d hrms -c "SELECT MAX(date) FROM sales_raw;"
```

**预期恢复时间**：< 60 分钟（取决于数据库大小）  
**最大数据损失**：24 小时（最近一次备份）

---

## 场景四：飞书 API Token 失效

**症状**：飞书机器人无响应，日志出现 `feishu auth error` 或 `token expired`

```bash
# 1. 确认问题
journalctl -u hrms.service --since "1 hour ago" | grep -i "feishu\|token\|auth"

# 2. 登录飞书开放平台重新获取 Token
#    https://open.feishu.cn/app
#    找到 HRMS 应用 → 凭证与基础信息 → 复制 App ID / App Secret

# 3. 更新服务器 .env 文件
nano /opt/hrms/hr-management-system/server/.env
# 修改 FEISHU_APP_ID 和 FEISHU_APP_SECRET

# 4. 重启服务（Token 是运行时自动获取的）
systemctl restart hrms.service

# 5. 验证
journalctl -u hrms.service --since "1 minute ago" | grep -i "feishu"
```

**预期恢复时间**：< 15 分钟

---

## 场景五：LLM API 失效（AI 无响应）

**症状**：Agent 回复「服务暂时不可用」，日志出现 `LLM all providers failed`

```bash
# 1. 检查日志
journalctl -u hrms.service --since "1 hour ago" | grep -i "llm\|openai\|claude\|all providers"

# 2. 系统有自动 fallback（OpenAI ↔ Claude），通常会自动恢复
#    如需手动验证：
curl -s http://127.0.0.1:3000/api/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['agents']['llmHealthy'])"

# 3. 若需要更新 API Key
nano /opt/hrms/hr-management-system/server/.env
# 修改 OPENAI_API_KEY 或 ANTHROPIC_API_KEY
systemctl restart hrms.service
```

**预期恢复时间**：自动恢复，或 < 10 分钟人工处理

---

## 场景六：磁盘空间不足

**症状**：服务启动失败，日志出现 `no space left on device`

```bash
# 1. 检查磁盘空间
df -h
du -sh /opt/hrms/backups/*
du -sh /var/log/

# 2. 清理旧备份（只保留最近 3 个）
ls -t /opt/hrms/backups/hrms_*.sql.gz | tail -n +4 | xargs rm -f

# 3. 清理日志
journalctl --vacuum-size=500M

# 4. 重启服务
systemctl restart hrms.service
```

---

## 定期维护清单（每月执行）

```bash
# 1. 验证备份可用性
LATEST=$(ls -t /opt/hrms/backups/hrms_*.sql.gz | head -1)
gunzip -c "$LATEST" | psql -U postgres hrms_test 2>&1 | tail -5

# 2. 检查磁盘空间
df -h /opt/hrms

# 3. 检查心跳状态
psql -U postgres -d hrms -c "SELECT task_name, last_beat, run_count FROM scheduler_heartbeat ORDER BY last_beat DESC;"

# 4. 检查定时任务日志
tail -50 /var/log/hrms-backup.log

# 5. 更新系统包（谨慎操作）
apt list --upgradable
```

---

## 重要文件位置

| 文件 | 路径 |
|------|------|
| 应用目录 | `/opt/hrms/hr-management-system/server/` |
| 环境变量 | `/opt/hrms/hr-management-system/server/.env` |
| systemd 配置 | `/etc/systemd/system/hrms.service` |
| 备份目录 | `/opt/hrms/backups/` |
| 备份脚本 | `/opt/hrms/hr-management-system/server/backup.sh` |
| 备份日志 | `/var/log/hrms-backup.log` |
| 应用日志 | `journalctl -u hrms.service` |

---

## 紧急联系

- 阿里云控制台：https://ecs.console.aliyun.com
- 飞书开放平台：https://open.feishu.cn/app
- OpenAI 控制台：https://platform.openai.com
- Anthropic 控制台：https://console.anthropic.com
