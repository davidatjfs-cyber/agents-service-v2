# HRMS 任务系统数据结构参考

## 重要：任务数据来源

**任务数据在 `master_tasks` 表中，不是 `ops_tasks` 表！**

## master_tasks 表关键字段

| 字段名 | 数据类型 | 说明 |
|--------|----------|------|
| task_id | text | 任务ID（主键） |
| status | text | 状态：`dispatched`（已分发）、`closed`（完成）、`hr_filed`（已备案） |
| remind_count | integer | 催办次数 |
| last_reminder_at | timestamp with time zone | 最后催办时间 |
| created_at | timestamp with time zone | 创建时间 |
| closed_at | timestamp with time zone | 完成时间 |
| timeout_at | timestamp with time zone | 超时标记时间 |
| escalation_level | integer | 升级级别（0-3） |
| assignee_username | text | 分配给的用户名 |
| title | text | 任务标题 |

## 任务ID 格式

| 任务类型 | ID 格式 | 示例 |
|----------|---------|------|
| 巡检任务 | `SCHED-YYYYMMDD-XXXX` | `SCHED-20260408-8208` |
| 试味任务 | `SCHED-YYYYMMDD-XXXX` | `SCHED-20260408-7087` |
| 充值异常任务 | `MT-YYYYMMDD-XXXX` | `MT-20260407-0001` |

## 任务状态说明

| 状态 | 说明 | 是否已完成 |
|------|------|-----------|
| `dispatched` | 已分发，待处理 | ❌ |
| `open` | 已打开 | ❌ |
| `closed` | 已完成 | ✅ |
| `hr_filed` | 已备案（HR记录） | ✅ |
| `overdue` | 已超时 | ❌ |

## 催办规则

- **巡检任务**：一般在截止时间后 1-2 小时后开始催办
- **试味任务**：一般在截止时间后开始催办
- **充值异常任务**：创建后立即开始催办，最多 3 次
- **最多催办次数**：3 次

## 常用查询 SQL

### 查询某人的任务
```sql
SELECT e.name as 姓名, m.task_id as 任务ID, m.title as 任务标题, m.status as 状态, 
       m.remind_count as 催办次数, m.last_reminder_at as 最后催办时间, m.created_at as 创建时间
FROM master_tasks m
JOIN employees e ON m.assignee_username = e.username
WHERE e.username IN ('NNYXYF26','NNYXLYR04','NNYXXMJ06','NNYXWSB39')
AND DATE(m.created_at) = '2026-04-08'
ORDER BY e.name, m.created_at;
```

### 查询今天任务汇总
```sql
SELECT e.name as 姓名, COUNT(*) as 收到任务, 
       SUM(CASE WHEN m.status = 'closed' THEN 1 ELSE 0 END) as 完成,
       SUM(CASE WHEN m.status = 'hr_filed' THEN 1 ELSE 0 END) as 备案,
       SUM(m.remind_count) as 总催办次数
FROM master_tasks m
JOIN employees e ON m.assignee_username = e.username
WHERE e.username IN ('NNYXYF26','NNXLYR04','NNYXXMJ06','NNYXWSB39')
AND DATE(m.created_at) = '2026-04-08'
GROUP BY e.name;
```

## ops_tasks 与 master_tasks 的区别

| 特性 | ops_tasks | master_tasks |
|------|-----------|---------------|
| 用途 | 营运任务（旧系统） | 所有任务（新系统） |
| 催办机制 | ❌ 没有 | ✅ 有 |
| 催办字段 | ❌ 无 | ✅ `remind_count`, `last_reminder_at` |
| 任务ID | UUID | `SCHED-*`, `MT-*` |

## 今天（2026-04-08）实际数据

| 姓名 | 角色 | 收到任务 | 完成 | 备案 | 总催办次数 |
|------|------|----------|------|------|------------|
| 喻烽 | 马己仙店长 | 2 条 | 2 条 | 0 条 | 0 次 |
| 黎永荣 | 马己仙出品经理 | 2 条 | 2 条 | 0 条 | 0 次 |
| 徐曼金 | 洪潮店长 | 3 条 | 2 条 | 1 条 | 3 次 |
| 王世波 | 洪潮出品经理 | 2 条 | 2 条 | 0 条 | 1 次 |

**注意**：徐曼金的 3 次催办都是针对充值异常任务（MT-20260407-0001），巡检任务没有催办都及时完成了。
