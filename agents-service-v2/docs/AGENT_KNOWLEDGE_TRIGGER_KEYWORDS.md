# Agent 路由与知识源（RAG / Wiki / MemPalace / PG）触发说明

本文档与 `src/services/message-router.js` 中的 **规则路由** 及 `agent-handlers.js` 中的 **知识注入** 对齐，便于运营与测试复现。**未匹配规则时**会再走 LLM 路由或落入 `master`。

---

## 一、飞书发消息如何进到哪个 Agent（关键词 → 路由）

规则按 **score 高者优先**（节选常见句型；正则更全以代码为准）。

| 路由名 | 用途简述 | 典型关键词或例句（命中方向） |
|--------|-----------|------------------------------|
| **train_advisor**（培训/SOP，**会拉 PG `knowledge_base` RAG + Wiki + `agent_memory`**） | 菜单/SOP/手册/开档收档步骤 | 「菜单」「菜谱」「SOP」「操作规范」「开档需要完成哪些」「收档清单」「档口」「炒锅」「培训课件」「带教」等；与 **知识库 PDF** 强相关 |
| **data_auditor**（经营数据，**会拉 `buildExperienceBlock` = Wiki + memory + 策略统计**） | 营收/毛利/桌访/生意 | 「生意怎么样」「营收」「毛利」「差评」「桌访」「人效」「原料」「营业额趋势」等 |
| **marketing_planner**（营销策划，**MemPalace 在 ENABLE_MEMPALACE=true 时参与 recall/save**） | 活动/拉新/方案 | 「营销方案」「活动策划」「会员活动」「拉新」「引流」「如何提升营收」「促销」「制定营销计划」等 |
| **marketing_executor** | 活动执行与效果 | 「活动进度」「ROI」「预算消耗」「执行了哪些策略」「效果如何」等 |
| **chief_evaluator**（HR/绩效，**会 recall `agent_memory`**） | 人事绩效 | 「绩效」「考核」「奖金」「请假」「社保」「薪资」「转正」「调岗」等 |
| **ops_supervisor**（营运，**会 recall `agent_memory`**） | 巡检/开收档 | 「开档」「收档」「巡检」「卫生」「拍照上传」等；**纯图片**消息会强制走此路由 |
| **appeal** | 申诉 | 「申诉」「投诉」「误判」「恢复扣分」等 |
| **food_quality** | 食安 | 「食品安全」「食材过期」「温度异常」等 |
| **accept_action_plan** | 确认行动 | 「接受行动计划」「确认行动计划」等 |
| **master** | 兜底 | 无法归类时 |

> **注意**：`train_advisor` 与「开档/收档」类问法在规则里 **score 较高**，会优先于泛泛的 `ops_supervisor`「开档」类短句；若希望走营运统计而非 SOP 检索，问法需更贴近 **得分/报告/数据**（见 `data_auditor` 收档/开档 + 得分 类规则）。

---

## 二、四类「知识」分别何时起作用

| 类型 | 存储 | 何时注入回复 | 你要让它「有感觉」可以怎么做 |
|------|------|----------------|------------------------------|
| **RAG（`knowledge_base`）** | PostgreSQL | **`train_advisor`** 中 `fetchKnowledgeSnippetsForTrainAdvisor` | HRMS 上传可检索 PDF/文本；问句含菜单、SOP、档口等触发 **train_advisor** |
| **Wiki（`knowledge/wiki` 下 .md）** | 磁盘 | **`buildExperienceBlock`**：`data_auditor` 与 **`train_advisor`（本次已接入）** | 先有 `data_auditor` 等高质量结构化输出写入 md；再问同类问题走带 Wiki 的 agent |
| **MemPalace** | HTTP + JSONL | **`marketing_planner`**，`ENABLE_MEMPALACE=true` 且内容经打分满足写入门槛 | 用上表营销类句进 **marketing_planner**；环境变量打开后观察 `/api/admin/knowledge-sources` 中 `mempalace.inventory` |
| **PG `agent_memory`** | PostgreSQL | 多数 handler 内 `recallMemories`；`buildExperienceBlock` 内也会查 | 同一 agent 多轮对话后会逐渐有「近期记录」块 |

**知识图谱（`business_entity_relations`）**：主要在 **HRMS `knowledge-graph.js`** 侧构建/查询；与 agents-service-v2 飞书对话路由 **无直接关键词绑定**。体检见 `GET /api/admin/knowledge-sources` 中的 `knowledgeGraphPg`。

---

## 三、运维自检接口（P1）

- **`GET /api/admin/knowledge-sources`**（需 admin / hq_manager JWT）  
  返回：`knowledge_base` 行数与按 scope 分布、近 7 日 `agent_memory` 按 agent 计数、`agent_experience` 总行数、Wiki 目录 md 数、MemPalace 探测、可选图谱行数、以及 `envHints`（不含密钥）。

---

## 四、与「HR agent / SOP agent」名称的对应关系

本仓库 **路由名** 为英文 id，与业务俗称大致对应：

- **SOP / 培训 / 知识库问答** → **`train_advisor`**
- **HR / 绩效** → **`chief_evaluator`**
- **营销** → **`marketing_planner`**（策划） / **`marketing_executor`**（执行跟踪）
- **经营分析** → **`data_auditor`**

无单独名为 `hr_agent` 的路由；若外部文档使用别名，以上表为准。
