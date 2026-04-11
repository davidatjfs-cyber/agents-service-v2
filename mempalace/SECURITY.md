# MemPalace 安全与运维（记忆数字资产）

## 存储

- 默认数据目录：`MEMPALACE_DATA_DIR` 未设置时为 `<repo>/mempalace/data/mempalace`。
- 主文件：`memory.jsonl` 仅追加（`O_APPEND` + `fsync`），每条为 JSON v1 行。
- 轮转备份：可选 `MEMPALACE_BACKUP_EVERY_WRITES`（默认 500）、`MEMPALACE_BACKUP_KEEP`（默认 14）保留 `data/backups/memory-*.jsonl`。

## 访问控制

- 设置 `MEMPALACE_BEARER_TOKEN` 后，除 `GET /health` 外所有接口需 `Authorization: Bearer <token>`。
- **agents-service-v2** 侧请配置同名 `MEMPALACE_HTTP_TOKEN`（或 `MEMPALACE_BEARER_TOKEN`）以便 `POST /memory`、`POST /search`、`GET /inventory` 通过鉴权。

## 完整性（可选）

- `MEMPALACE_INTEGRITY_SECRET`：为每条 v1 记录写入 HMAC-SHA256；加载时若行带 `hmac` 则校验。启用前写入的无 `hmac` 历史行仍会加载；启用后新行均带签。

## 操作系统

- 建议目录权限：`chmod 700` 数据目录，进程用户专有。
- 不要将数据目录放在 Web 可下载路径；仅本机或内网访问 MemPalace HTTP。

## 密钥

- 勿将 `.env` 提交仓库；生产用密钥管理（KMS / 运维私密下发）。
