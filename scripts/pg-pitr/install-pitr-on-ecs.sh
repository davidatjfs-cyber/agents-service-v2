#!/bin/bash
# 在 ECS 上初始化 /opt/pg_pitr、打开 WAL 归档、安装定时任务（Ubuntu + PostgreSQL 14）
# 在 monorepo 根目录执行：bash scripts/pg-pitr/install-pitr-on-ecs.sh [user@host]
set -euo pipefail

TARGET="${1:-root@47.100.96.30}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

ssh "$TARGET" 'bash -s' <<'REMOTE'
set -euo pipefail
PITR_ROOT=/opt/pg_pitr
install -d -m 755 "$PITR_ROOT"/{wal_archive,base,weekly_export,scripts,logs}
chown postgres:postgres "$PITR_ROOT"/{wal_archive,base,weekly_export}
chmod 700 "$PITR_ROOT"/{wal_archive,base,weekly_export}

cat >"$PITR_ROOT/README_PITR.txt" <<'EOF'
HRMS PostgreSQL PITR（本机归档，无 OSS）
- WAL 目录: /opt/pg_pitr/wal_archive（默认保留 35 天，见 pg-pitr-prune-wal.sh）
- 物理基础备份: /opt/pg_pitr/base/base_*（保留 2 份）
- 周逻辑全库（可拷到 Mac）: /opt/pg_pitr/weekly_export/hrms_weekly_*.dump
- 日增量状态: /opt/hrms/server/backup-state-only.sh → /opt/hrms/backups/
- 失败告警: 配置 /opt/pg_pitr/alert.env（见 alert.env.example），并查 /opt/pg_pitr/logs/

恢复周备（逻辑）示例：
  pg_restore --clean --if-exists -h 127.0.0.1 -U postgres -d hrms_restore /path/to/hrms_weekly_xxx.dump

PITR 时间点恢复需：最新 base 目录 + 连续 WAL；生产演练前请在测试库验证。
EOF
chmod 644 "$PITR_ROOT/README_PITR.txt"

if [[ ! -f /opt/pg_pitr/alert.env ]]; then
  install -m 600 /dev/null /opt/pg_pitr/alert.env
  echo "创建空 /opt/pg_pitr/alert.env — 请填入 BACKUP_ALERT_WEBHOOK（飞书机器人 Webhook），否则失败仅写 syslog"
fi

psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
ALTER SYSTEM SET archive_mode = 'on';
ALTER SYSTEM SET archive_command = 'test ! -f /opt/pg_pitr/wal_archive/%f && cp %p /opt/pg_pitr/wal_archive/%f';
ALTER SYSTEM SET archive_timeout = '300';
SQL

systemctl restart postgresql@14-main
sleep 2
systemctl is-active --quiet postgresql@14-main
psql -h 127.0.0.1 -U postgres -d postgres -c "SHOW archive_mode;"
psql -h 127.0.0.1 -U postgres -d postgres -c "SELECT archived_count, last_archived_wal, last_failed_wal FROM pg_stat_archiver;"
REMOTE

scp "$ROOT/scripts/pg-pitr/pg-pitr-alert.sh" \
    "$ROOT/scripts/pg-pitr/pg-pitr-common.sh" \
    "$ROOT/scripts/pg-pitr/pg-pitr-backup-health.sh" \
    "$ROOT/scripts/pg-pitr/pg-pitr-prune-wal.sh" \
    "$ROOT/scripts/pg-pitr/pg-pitr-weekly-base.sh" \
    "$ROOT/scripts/pg-pitr/pg-pitr-weekly-logical-export.sh" \
    "$ROOT/scripts/pg-pitr/alert.env.example" \
    "${TARGET}:/opt/pg_pitr/scripts/"

# alert.env.example landed in scripts/ — move next to alert.env
ssh "$TARGET" 'mv -f /opt/pg_pitr/scripts/alert.env.example /opt/pg_pitr/alert.env.example 2>/dev/null || true'

ssh "$TARGET" 'chmod +x /opt/pg_pitr/scripts/*.sh'

scp "$ROOT/hr-management-system/server/backup-state-only.sh" "${TARGET}:/opt/hrms/server/backup-state-only.sh"
ssh "$TARGET" 'chmod +x /opt/hrms/server/backup-state-only.sh'

ssh "$TARGET" 'bash -s' <<'REMOTE'
set -euo pipefail
TMP=$(mktemp)
# 去掉旧 HRMS 备份与旧版 PITR cron 行，避免重复；保留其它任务（如 deploy-backup）
crontab -l 2>/dev/null \
  | grep -v '/opt/hrms/server/backup.sh' \
  | grep -v 'pg-pitr-prune-wal.sh' \
  | grep -v 'pg-pitr-weekly-base.sh' \
  | grep -v 'pg-pitr-weekly-logical-export.sh' \
  | grep -v 'pg-pitr-backup-health.sh' \
  | grep -v 'backup-state-only.sh' \
  | grep -v '^# HRMS PITR' \
  | grep -v '^# 部署备份目录保留策略' \
  | grep -v '/opt/scripts/deploy-backup.sh' \
  >"$TMP" || true
{
  cat "$TMP"
  echo '# HRMS PITR + weekly logical export (no OSS)'
  echo 'CRON_TZ=Asia/Shanghai'
  echo '15 4 * * * /opt/pg_pitr/scripts/pg-pitr-backup-health.sh'
  echo '30 3 * * * /opt/pg_pitr/scripts/pg-pitr-prune-wal.sh'
  echo '30 2 * * 0 /opt/pg_pitr/scripts/pg-pitr-weekly-base.sh'
  echo '0 3 * * 0 /opt/pg_pitr/scripts/pg-pitr-weekly-logical-export.sh'
  echo '0 12 * * * /bin/bash /opt/hrms/server/backup-state-only.sh'
  echo '# 部署备份目录保留策略（与 scripts/deploy-backup.sh 注释一致）'
  echo '0 3 * * 0 /bin/bash /opt/scripts/deploy-backup.sh --retention-only'
} | crontab -
rm -f "$TMP"
echo "--- crontab ---"
crontab -l
REMOTE

echo "install-pitr-on-ecs: done ($TARGET) — 请编辑 /opt/pg_pitr/alert.env 设置 BACKUP_ALERT_WEBHOOK"
