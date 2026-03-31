---
description: PostgreSQL 数据库连接配置（避免密码认证卡死）
---

# PostgreSQL 连接配置

## ⚠️ 关键问题

服务器上的 PostgreSQL 配置了 **md5 密码认证**，直接使用 `psql -U postgres` 或 `sudo -u postgres psql` 会卡住要求密码。

## ✅ 正确的连接方式

### 方式1：通过 TCP localhost（推荐，无需密码）

```bash
# 连接数据库
psql -h 127.0.0.1 -U postgres -d hrms

# 执行 SQL
psql -h 127.0.0.1 -U postgres -d hrms -c "SELECT COUNT(*) FROM users;"

# 备份数据库
pg_dump -h 127.0.0.1 -U postgres hrms > backup.sql
```

**原理**：`pg_hba.conf` 配置中 `127.0.0.1` 使用 `trust` 认证，无需密码。

### 方式2：使用应用的 DATABASE_URL（如果有密码）

```bash
# 从 .env 读取
DATABASE_URL=$(grep DATABASE_URL /opt/hrms/hr-management-system/server/.env | cut -d= -f2)
psql "$DATABASE_URL"
```

## ❌ 错误的方式（会卡住）

```bash
# ❌ 使用 Unix socket（需要 md5 密码）
psql -U postgres -d hrms

# ❌ sudo 切换用户（仍然走 Unix socket）
sudo -u postgres psql -d hrms
```

## 📋 pg_hba.conf 配置（参考）

```
# /etc/postgresql/*/main/pg_hba.conf
local   all   postgres   md5      # Unix socket 需要密码
host    all   all   127.0.0.1/32   trust   # TCP localhost 无需密码 ✅
```

## 🔧 常用操作

```bash
# 查看所有表
psql -h 127.0.0.1 -U postgres -d hrms -c "\dt"

# 查看表结构
psql -h 127.0.0.1 -U postgres -d hrms -c "\d users"

# 查看数据库大小
psql -h 127.0.0.1 -U postgres -d hrms -c "SELECT pg_size_pretty(pg_database_size('hrms'));"

# 备份数据库
pg_dump -h 127.0.0.1 -U postgres hrms | gzip > hrms_backup_$(date +%Y%m%d).sql.gz

# 恢复数据库
gunzip -c hrms_backup_20260302.sql.gz | psql -h 127.0.0.1 -U postgres hrms
```

## 📝 备份脚本配置

备份脚本已配置为使用 TCP localhost：

```bash
# /opt/hrms/hr-management-system/server/backup.sh
pg_dump -h 127.0.0.1 -U postgres hrms > backup.sql
```

每天凌晨 3:00 自动运行（crontab）。
