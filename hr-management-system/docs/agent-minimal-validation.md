---
title: Agent 最小验证脚本与提问清单
---

# 0. 前置条件

1. PostgreSQL 已启动，且 `.env` 中 `DATABASE_URL` 可连通。
2. 服务启动：

```bash
npm --workspace server run start
```

3. 已有管理员 token（下文用 `$TOKEN`）。

---

# 1. 配置接口最小验证（OP / BI / HR）

```bash
BASE="http://localhost:3001"
TOKEN="<你的管理员token>"

# 1) 读 OP 配置
curl -s "$BASE/api/admin/agents/ops-config" \
  -H "Authorization: Bearer $TOKEN" | jq .

# 2) 读 BI 配置
curl -s "$BASE/api/admin/agents/bi-config" \
  -H "Authorization: Bearer $TOKEN" | jq .

# 3) 读 HR 评级配置
curl -s "$BASE/api/admin/hr/employee-rating-config" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

期望：
- OP `scheduledTasks.randomInspections[*]` 包含 `store/brand/intervalMinHours/intervalMaxHours/assigneeRoles`。
- HR `attitude.D_min_incomplete` 存在。

---

# 2. OP 随机巡检保存/回显验证

在前端 Agent 配置中心（OP tab）执行：
1. 新增随机巡检，填写：
   - 指定门店：任意门店
   - 类型ID：`seafood_pool_temperature`
   - 随机间隔：`2 ~ 4`
   - 时间窗口：`15`
   - 指定人员角色：店长 + 出品经理
2. 点击保存。
3. 刷新页面后重新打开 OP 配置。

期望：
- 上述字段全部保留并正确回显。

---

# 3. BI 最小提问清单（飞书）

用同一门店账号在飞书向系统提问：

1. 数据源覆盖：
   - `BI现在能查哪些数据源？`
2. 桌访问题：
   - `近7天我们店最不满意的菜品是什么？`
3. 差评统计：
   - `近7天差评多少条？`
4. 开/收档统计：
   - `近7天开档多少次？收档多少次？`

期望：
- 问题 1 返回按源覆盖列表。
- 若数据源不可用，返回固定拒答 + 数据源检查（不再泛化回答）。
- 若数据源可用，返回结构化、可追溯的确定性结果。

---

# 4. OP 反馈时效验证（分钟单位）

1. 创建一条待处理 `master_tasks`（状态 `dispatched`）。
2. 不查看任务，等待超过 `firstReminder`。
3. 观察提醒是否触发；继续观察 `maxReminders` 与升级规则。

默认参考值（分钟）：
- `firstReminder=60`
- `secondReminder=90`
- `escalationDelay=120`

---

# 5. 调度状态检查

```bash
BASE="http://localhost:3001"
TOKEN="<你的管理员token>"

curl -s "$BASE/api/agents/scheduler-status" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

期望：
- 可看到 OP 定时任务下一次执行时间、最近执行时间、runCount、lastError。

---

# 6. 失败排查（优先级）

1. 数据库连通：`ECONNREFUSED 127.0.0.1:5432` 先修复数据库。
2. 配置保存成功但不生效：检查是否触发了 OP scheduler hot reload。
3. BI 回答仍泛化：检查对应数据源是否 disabled/empty，以及同步表是否有样本。
