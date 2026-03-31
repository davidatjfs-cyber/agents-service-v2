# Agents-V2 总部主管型Agent — 开发计划

> 独立微服务 | Express + BullMQ + Redis + PostgreSQL | 端口3100

## Phase 1 ✅ 已完成 (2026-03-05)

| 模块 | 状态 | 说明 |
|------|------|------|
| 项目骨架 | ✅ | package.json, .env, Dockerfile, systemd service |
| DB Migration | ✅ | kpi_snapshots, anomaly_triggers, escalation_chains, acceptance_checklists, rhythm_logs |
| 10类异常检测引擎 | ✅ | revenue, labor, recharge*, table_visit_product, table_visit_ratio, gross_margin, bad_review_product, bad_review_service, traffic, food_safety |
| HQ Rhythm引擎 | ✅ | 晨检09:30, 巡检11:30/16:30, 日终21:30, 周报周一10:00, 月评每月1日 |
| KPI计算器 | ✅ | TTFR P90, TTC P90, 超时率, 误报率, 证据链完整率, 一次通过率, 升级率 |
| Redis | ✅ | 已安装在生产服务器 |
| 生产部署 | ✅ | systemd agents-v2.service, port 3100, health check OK |
| 门店名映射 | ✅ | daily_reports ↔ feishu_generic_records (store-mapping.js) |

**⚠️ 待补数据**: recharge_count 字段尚未加入 daily_reports，充值异常检测暂跳过

### API 端点
- `GET  /health` — 健康检查
- `POST /api/anomaly/run` — 手动触发异常检测 (daily/weekly)
- `GET  /api/anomaly/triggers` — 查询异常触发记录
- `POST /api/rhythm/morning|patrol|end-of-day|weekly|monthly` — 手动触发节奏
- `GET  /api/rhythm/logs` — 节奏执行日志
- `GET  /api/kpi/snapshots` — KPI快照查询
- `POST /api/kpi/calculate` — 手动触发KPI计算
- `GET  /api/config/*` — 规则/SLA/升级/推送配置

## Phase 2 🔲 (预计W2-3)

- [ ] 飞书消息推送集成 (晨报/巡检报告/红色通道告警)
- [ ] 升级链自动执行 (超时→升级→通知hq_manager/admin)
- [ ] 验收闭环 (evidence_refs上传 + 审核通过/打回)
- [ ] React Dashboard 控制面板 (异常看板 + KPI趋势 + 节奏日历)
- [ ] daily_reports 新增 recharge_count/recharge_amount 字段
- [ ] Webhook入口 (飞书事件回调 → BullMQ队列)

## Phase 3 🔲 (预计W4-6)

- [ ] Marketing Strategy Agent (营销策略建议)
- [ ] Food Quality Agent (食安巡检 + 供应商评分)
- [ ] LLM智能分析 (异常根因分析 + 改进建议生成)
- [ ] 多品牌对比看板
- [ ] 历史趋势 + 预测预警
- [ ] 自动化边界扩展 (更多auto-action)
