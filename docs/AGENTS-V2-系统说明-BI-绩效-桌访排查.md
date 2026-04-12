# Agents Service V2：Agent 清单、BI 异常、绩效与「马己仙桌访」排查说明

> 文档依据仓库内 **`agents-service-v2`** 与 **`hr-management-system`** 源码整理，生成日期：2026-03-20。  
> 生产环境是否开启轮询/定时任务以实际环境变量为准。

---

## 1. Agents V2 中有哪些 Agent？

### 1.1 子 Agent（由 `dispatchToAgent` 调度）

定义位置：`agents-service-v2/src/services/agent-handlers.js` 末尾 `HANDLERS` 映射。

| 路由键 | 说明 | 实际处理函数 |
|--------|------|----------------|
| `data_auditor` | 数据审计（营收/排行/桌访/差评等） | `handleDataAuditor` |
| `ops_supervisor` | 营运督导（开收档、巡检等） | `handleOpsSupervisor` |
| `chief_evaluator` | 绩效考核 / 扣分说明 | `handleChiefEvaluator` |
| `train_advisor` | 培训与 SOP | `handleTrainAdvisor` |
| `appeal` | 申诉 | `handleAppeal` |
| `marketing_planner` | 营销策划 | `handleMarketingPlanner` |
| `marketing_executor` | 营销执行 | `handleMarketingExecutor` |
| `procurement_advisor` | 采购建议 | `handleProcurementAdvisor` |
| `master` | 总控 / 兜底 | `handleMaster` |
| `marketing` | 与 `marketing_planner` 相同 | 同 `handleMarketingPlanner` |
| `food_quality` | 与 `ops_supervisor` 相同 | 同 `handleOpsSupervisor` |

另有 **`deterministic`**：在 `message-pipeline.js` 中优先于子 Agent 执行，**不走 LLM**，直接查库拼回复。

### 1.2 路由 Agent（不单独对用户「角色扮演」，只做分类）

- 规则路由 + LLM 路由：`agents-service-v2/src/services/message-router.js`  
- 合法路由列表：`VALID_ROUTES`（含 `clarify` 等中间态由路由返回，不一定对应 `HANDLERS` 键）。

---

## 2. 各 Agent 系统提示词（Prompt）原文摘要

以下为用户消息之外的 **system** 侧主要内容（含动态插值如门店、时间、证据文本）。

### 2.1 主控路由（LLM 分类）

**文件**：`agents-service-v2/src/services/message-router.js`  

```text
你是HRMS系统的主控路由Agent。根据用户输入决定路由给哪个子Agent。
严格输出JSON: {"route":"标识符","confidence":0-1,"reason":"理由"}

可用Agent:
- data_auditor: 数据审计(营收/毛利/损耗/差评/数据查询)
- ops_supervisor: 营运督导(开市收市检查/卫生巡检/图片审核)
- chief_evaluator: HR与绩效(绩效/考核/人事流程)
- train_advisor: 培训与SOP(流程/培训/课件)
- appeal: 申诉与投诉
- marketing_planner: 营销策划(制定营销方案/活动策划/会员策略/引流拉新)
- marketing_executor: 营销执行(活动进度跟踪/效果评估/ROI/预算消耗)
- food_quality: 食品安全(食材/温度/卫生)
- master: 无法明确归类时由Master Agent综合处理
```

### 2.2 `data_auditor`

**文件**：`agent-handlers.js` → `handleDataAuditor`  

动态部分：`当前时间`、`门店`、`品牌`、`时间范围`、`businessHint`（整体生意类问题）、数据库摘要 `ds`。固定约束核心为：

- 角色：**「小年」年年有喜餐饮集团 AI 数据审计 Agent**  
- **只根据数据库内容回复**，禁止编造；无数据须写「暂无此数据」等。  
- **回复格式**：首行引导句；`- **指标名**: 值`；末段以 **总结/分析说明/简要分析** 开头；不超约 400 字。

（完整字符串见源码约 831–841 行。）

### 2.3 `ops_supervisor`

- 角色：**「小年」AI 营运督导 Agent**  
- 职责：开市/收市、卫生巡检、照片审核、标准合规、异常催办。  
- 格式：`- **项**: 值`，可附 **分析说明**；禁止编造；约 300 字内。

### 2.4 `chief_evaluator`

- 角色：**「小年」AI 绩效考核 Agent**  
- 职责：门店绩效、员工等级 A/B/C/D、扣分、奖金规则、改善建议。  
- **评级标准**：A>95，B>90，C≥85，D<85；奖金规则文案写死在 prompt 中。  
- **约束**：只能基于真实扣分记录；引用异常类别与日期。

### 2.5 `train_advisor`

- 角色：**「小年」AI 培训与 SOP 顾问**  
- 结构：SOP 类 / 培训类分段说明；禁止编造人数、薪资日期等。

### 2.6 `appeal`

- 角色：**「小年」AI 申诉处理 Agent**  
- 职责：投诉/申诉流程、核实与时间预期；禁止编造。

### 2.7 `marketing_planner` / `marketing_executor`

- 角色均为 **「小年」** 下营销策划 / 营销执行 Agent。  
- 要求基于真实营收、活动、任务数据；planner 偏方案，executor 偏进度与 ROI。

### 2.8 `master`

- 角色：**「小年」AI 助理（Master 调度中枢）**  
- 说明可协助数据审计、营运、绩效、SOP、申诉、营销引导；**禁止编造**；极简约 200 字。

### 2.9 `procurement_advisor`

**文件**：`agents-service-v2/src/services/procurement-agent.js`  

- **User 侧**：`你是餐饮采购顾问AI。根据以下门店数据生成采购建议：...` + JSON 输出格式说明。  
- **System**：`你是餐饮采购优化专家，只输出JSON`

### 2.10 异常协作（营销侧 JSON）

**文件**：`agents-service-v2/src/services/agent-collaboration.js`（异常触发后的协作链）  

- User：`你是餐饮连锁品牌的市场总监AI。门店"..."触发了...`  
- System：`你是餐饮营销专家，只输出JSON，不要任何其他文字`

### 2.11 AI 营运诊断（独立接口，非飞书对话主链路）

**文件**：`agents-service-v2/src/services/ai-operations.js`  

- 调用本地 Ollama：`你是餐饮连锁公司营运总监，不是分析师。` + 可执行动作 JSON 规则（`top_3_issues`、`actions` 等）。

### 2.12 管理后台可覆盖的 per-agent 配置

**文件**：`agents-service-v2/src/routes/admin-api.js`  

- 支持按 agent id 读取 `prompt`、`temperature` 等（存储于配置系统）；若未配置则使用上述代码内默认逻辑。

---

## 3. BI 异常触发：当前设定与是否在跑？

### 3.1 规则清单（设计文档 + 默认配置源）

- **静态说明与 10 类规则结构**：`agents-service-v2/src/config/anomaly-rules.js`（`ANOMALY_RULES`）。  
- **运行时阈值与启用状态**：来自数据库配置 **`getAnomalyRules()`**（`config-service.js`），迁移中有默认 JSON：`agents-service-v2/src/migrations/002_config_system.sql`（与前端「BI规则」保存同一套思路）。

规则类型（key）与引擎中实现对应关系见 **`anomaly-engine.js`** 的 `CHECK_FN_MAP`：

| anomaly_key | 名称（配置中） | 引擎内 frequency 过滤 |
|-------------|----------------|-------------------------|
| `revenue_achievement` | 实收营收异常 | **weekly**（与 patrol/周报调度一致） |
| `labor_efficiency` | 人效值异常 | **weekly** |
| `recharge_zero` | 充值异常 | **daily** |
| `table_visit_product` | 桌访产品异常 | **weekly**（**每周一 05:00** 上海跑周频 BI；窗口 **仅上周一～周日** `shanghaiLastCompletedWeekBounds`；菜名**仅**来自「今天不满意菜品」列，见 `dissatisfactionDishForTableVisitProductBi`；扣分按产品维度累计） |
| `table_visit_ratio` | 桌访占比异常 | **weekly** |
| `gross_margin` | 毛利率异常 | **monthly** |
| `bad_review_product` | 差评产品异常 | **weekly** |
| `bad_review_service` | 差评服务异常 | **weekly** |
| `food_safety` | 食品安全 | **realtime**（消息内容触发，非 patrol 批量） |
| `traffic_decline` | 客流/订单下滑 | **weekly** |

触发后写入 **`anomaly_triggers`** 表，并异步调用 **`onAnomalyTriggered`**（协作链）。

### 3.2 谁在调度「实际执行」？

**文件**：`agents-service-v2/src/index.js`  

- 当 **`ENABLE_AUTOMATIONS=true`** 时启动：  
  - **`startRhythmScheduler()`**（`rhythm-engine.js`）  
  - 其中 **`patrol('am'/'pm')`** 在 **11:30、16:30（Asia/Shanghai）** 调用 **`runAnomalyChecks('daily', stores)`**。  
  - **`weeklyReport()`** 在 **周一 10:00** 调用 **`runAnomalyChecks('weekly', stores)`**。  
  - **`monthlyEvaluation()`** 在 **每月 1 日 10:00** 调用 **`runAnomalyChecks('monthly', stores)`**。  

**文件**：`agents-service-v2/src/utils/safety.js`  

- **staging/production 默认不启用自动化**，除非显式 `ENABLE_AUTOMATIONS=true`。  
- **development 默认也不启用**，同样需要显式开启。

**结论**：  
- **代码路径上**：BI 异常检测**已实现**，且挂在节奏引擎的定时任务上；并支持管理员调用 **`POST /api/anomaly/run`** 手动跑。  
- **是否在你当前环境「实际在执行」**：取决于部署时是否 **`ENABLE_AUTOMATIONS=true`**、数据库是否有 **`anomaly_rules` 配置**、以及 `daily_reports` / 飞书同步是否有数据。未开自动化时，**不会自动巡检**，除非人工调 API。

---

## 4. 绩效：对门店、对员工「实际在执行」的内容

### 4.1 Agents V2 内的「绩效」相关

| 能力 | 实现方式 | 数据表 |
|------|-----------|--------|
| 对话问答 | `chief_evaluator` 拉取近 30 天 **`anomaly_triggers`** 汇总 + **`agent_scores`** 历史 + 扣分样本 | `anomaly_triggers`, `agent_scores` |
| 评分公式 API | `POST /api/scoring/calculate` → **`scoring-model.js`** | 入参为异常列表等，**不落库** |
| KPI 快照（偏「管理闭环/任务 SLA」） | 每日 **01:00** `calculateAllStoresKPI('yesterday')` → **`kpi_snapshots`** | `master_tasks` 等 |

**`kpi-calculator.js` 说明**：写入的 KPI 主要是 **TTFR/TTC、超时率、误报率、证据链、一次通过率、升级率** 等，**不是**「员工月度绩效奖金」全流程自动化。

### 4.2 门店侧

- **异常触发**：见第 3 节，`anomaly_triggers` 按门店写入。  
- **门店评分展示**：依赖 **`agent_scores`** 表有数据；**HRMS 主服务**（`hr-management-system/server/agents.js`）存在 **`INSERT INTO agent_scores`** 等业务逻辑，**Agents V2 仓库内未发现定时写入 `agent_scores` 的独立任务**。  
- **注意**：V2 `chief_evaluator` 查询列为 `role, score, rating, deduction_total, period_start, period_end`，而 HRMS 迁移 `005_agent_p0p2_tables.sql` 中 **`agent_scores` 列为 `total_score`、`period` 等**。若 V2 与 HRMS **共用库但结构为 HRMS 版**，该查询可能**列不匹配**导致无数据（需以实际库表结构为准）。

### 4.3 员工侧

- **对话**：`chief_evaluator` 使用上下文用户与门店；**培训任务**在 `train_advisor` 中查 **`training_tasks`**（表可能不存在则静默失败）。  
- **申诉**：`appeal` 会尝试 **`INSERT INTO agent_appeals`**。  
- **自动算薪/自动打员工月度分**：**不在**本 V2 服务内完整实现；以 HRMS 主系统为准。

---

## 5. 「马己仙昨天没有桌访数据」— 原因分析与本地库验证

### 5.1 本地数据库核查（`agents_v2_local`，2026-03-20 执行）

在 **`feishu_generic_records`** 中，**桌访表**（`config_key='table_visit'` / `table_id='tblpx5Efqc6eHo3L'`）存在大量记录。  
对 **门店字段含「马己」** 且 **业务日期按 `日期` 字段（13 位毫秒时间戳）换算为 UTC 日历日** 过滤 **`2026-03-19`** 的统计：**约 39 条**。

**结论（针对本机库）**：**系统库中可以有「马己仙 / 马己仙大宁店」维度的昨日桌访数据**；若线上提示「没有」，多为 **上下文门店为空、日期解析不一致、或线上库未同步**，而非业务侧一定无记录。

### 5.2 代码层面常见原因

1. **`ctx.store` 为空**  
   - **确定性桌访**：`deterministic-replies.js` 中 `buildTableVisitReply` 在 **`!store` 时直接返回空字符串**，不会回答桌访。  
   - **`data_auditor` 桌访分支**：`agent-handlers.js` 中 **`if (store && /桌访|桌数|桌访情况/.test(text))`** — **无门店则不走桌访确定性分支**，后续主要依赖 LLM + 可能为空的 `ds`，易出现「暂无」类表述。  
   - **总部账号**：若 `feishu_users` 中没有任何门店名可供 **`extractStoreFromText`** 从「马己仙」反推到完整店名，可能导致 **`store` 仍为空**。

2. **业务日期与「昨天」不一致**  
   - 确定性路径里桌访日期使用 **`bitableDate(f['日期']||f['提交时间'], row.created_at)`**，**未包含 `记录日期`**；而 `buildDeterministicTableVisitReply` 使用了 **`记录日期`**。两条路径不一致时，可能出现**一条有话术、一条无数据**。  
   - 若飞书 **`日期` 为空**，会回落到 **`created_at`**：同步若跨日，用户口中的「昨天」（业务日）可能与 **`created_at` 日历日**不一致。

3. **门店名称**  
   - 飞书侧多为 **`马己仙大宁店`**，HRMS 侧可能为 **`马己仙上海音乐广场店`**。`sameStore` / 关键字包含逻辑在多数情况下可对齐，但若字段异常或仅写简称且库中无映射，仍可能过滤掉。

4. **同步与自动化**  
   - 飞书轮询 **`startBitablePolling`** 同样受 **`ENABLE_AUTOMATIONS`** 控制；未开启时依赖 HRMS 或其它通道写入 `feishu_generic_records`。

### 5.3 建议排查步骤（运维）

1. 用管理端或 SQL 查 **`feishu_generic_records`**：`config_key='table_visit'`，`fields->>'所属门店'` / `门店`，以及 **`日期` 类型与值**。  
2. 查当时飞书用户 **`feishu_users.store`** 与角色是否为总部、是否从话术里解析出门店。  
3. 确认环境 **`ENABLE_AUTOMATIONS`** 与飞书同步是否正常。  

---

## 6. 相关源码索引（便于跳转）

| 主题 | 路径 |
|------|------|
| 子 Agent 与 HANDLERS | `agents-service-v2/src/services/agent-handlers.js` |
| 路由与 ROUTE_SYSTEM_PROMPT | `agents-service-v2/src/services/message-router.js` |
| 确定性回复（含桌访） | `agents-service-v2/src/services/deterministic-replies.js` |
| 飞书消息管线 | `agents-service-v2/src/services/message-pipeline.js` |
| 异常引擎 | `agents-service-v2/src/services/anomaly-engine.js` |
| 节奏与定时 | `agents-service-v2/src/services/rhythm-engine.js` |
| 服务入口与 cron | `agents-service-v2/src/index.js` |
| 自动化开关 | `agents-service-v2/src/utils/safety.js` |
| 门店名映射（日报 vs 飞书） | `agents-service-v2/src/config/store-mapping.js` |
| HRMS 写入 agent_scores | `hr-management-system/server/agents.js` |

---

*本文档由代码阅读与本地只读 SQL 验证生成；生产环境以实际配置与数据为准。*

---

## 7. 2026-03-20 更新（实现项）

1. **桌访（马己仙无数据）**：`feishu_generic_records` 查询改为先按门店 **ILIKE 模式**（含 HRMS 全称 ↔ 飞书简称）过滤，再 `LIMIT`，避免洪潮高频同步占满 `ORDER BY updated_at LIMIT 3000` 窗口。涉及 `deterministic-replies.js`、`agent-handlers.js`（`buildDeterministicTableVisitReply`）。  
2. **销售毛利估算**：新增 `services/margin-from-sales.js`，用 **`sales_raw` + `dish_library_costs`**（飞书菜品库/外卖库同步表）估算毛利率；在 `data_auditor` 中识别「毛利率/菜品成本」类问题触发。  
3. **绩效读数**：`chief_evaluator` / `appeal` 对 **`anomaly_triggers`、`agent_scores`** 的列名与真实表结构对齐（`anomaly_key`、`total_score`、`period` 等）。  
4. **周度门店评分**：新增 `services/periodic-scoring.js`，**每周一 08:25（Asia/Shanghai）** cron 跑 `runWeeklyStoreScoring`，按当周 `anomaly_triggers` 汇总扣分并写入 **`agent_scores`**（店长 / 出品经理维度；未绑定时可为占位账号）。说明：旧文档曾误写「02:15」，以代码 `cron.schedule(..., { timezone: 'Asia/Shanghai' })` 为准。HRMS `pushScoresToFeishu` 为 **每 5 分钟**重试未通知行；`anomaly_rollups_v2` 的「绩效考核周报」飞书卡与即时「BI异常情况扣分」卡解耦时，以 `agents.js` 内「仅上海周一推送」逻辑为准。  
5. **环境变量**：本地 `.env` 示例见 `agents-service-v2/.env.example`；需同时 **`ENABLE_AUTOMATIONS=true`** 与 **`ENABLE_DB_WRITE=true`** 才能跑定时任务并写入评分。

---

## 8. 2026-03-21 更新（生意/桌访/开档与时区）

1. **「昨天生意」与「前天生意」不一致**：原先 Master Planner 用 `extractTimeRangeFromText`（服务器本地日）拦截「昨天+生意」，与确定性回复用的 **Asia/Shanghai** 日历不一致，易导致营收查错日、显示 ¥0。现 **纯生意问询不再走 Planner**，与「前天」一样走 `buildDailyReportReply`；同时 **`data-executor.js` 中今/昨/前及周范围解析已改为上海日历**。
2. **营业日报缺「经营建议」**：`buildDailyReportReply` 在单日/多日/sales_raw 兜底分支末尾追加 **确定性「经营建议」** 区块（不依赖 LLM）。
3. **桌访条数偏少**：统计时 **业务日期字段在范围内或入库日（created_at）在范围内** 任一命中即计入；去重优先 **`record_id`**；`LIMIT` 提至 12000。
4. **开档/收档「今天没记录」**：原先用全表 `ORDER BY updated_at LIMIT 3000` 再按门店过滤，易被高频门店挤出；已改为 **SQL 侧 `ILIKE ANY(门店模式)` + 180 天 + LIMIT 12000**。无数据时文案提示依赖 **飞书 Webhook `bitable.record.changed`** 或 **手动同步**（见 HRMS `POST /api/feishu/sync-manual`）。
5. **飞书同步节奏**：**不是固定间隔全量**；以多维表 **变更事件 Webhook** 为主写入 `feishu_generic_records`。若刚填表但 DB 无行，先查 Webhook 是否打到生产 HRMS、再用手动同步补数。

6. **20260321c**：`GET /health` 增加 **`replyEngine`**（与 `reply-engine-version.js` 一致）用于确认 ECS 已 `pm2 restart` 加载新代码；营业日报回退 **`sales_raw`** 时门店条件改为与 `daily_reports` 相同的 **`LIKE`**，避免「昨天无日报行」时误显示无数据。

7. **20260321d（桌访条数）**：飞书助理原只统计 **`feishu_generic_records`**，与 HRMS **`table_visit_records`**（Webhook 主写入）不同步时会出现「飞书里很多条、助理只认 2 条」。现桌访确定性回复 **合并两表**，并按 **`feishu_record_id` / `record_id` 去重**，条数与 HRMS BI `loadUnifiedTableVisitRowsByStore` 口径对齐。

8. **20260321e（仍显示 2 条）**：`message-pipeline` 在部分话术下仍先走 **`data_auditor`** 的 `buildDeterministicTableVisitReply`，其内部曾 **仅查飞书缓存 + 严格业务日**（无 `created_at` 回退），与 `deterministic-replies.buildTableVisitReply` 的合并口径不一致。现已抽出 **`fetchMergedTableVisitEntries`**（`table_visit_records` 按 **业务日或上海入库日** OR 命中 + 飞书 `visitRowInDateRange`），**V1 图格式与 📋 格式共用同一合并结果**；`master-planner` 的异常触发词收窄为 **桌访率/占比/翻台/桌访产品**，避免泛泛「桌访」触发 Planner 抢先返回导致条数偏少。
