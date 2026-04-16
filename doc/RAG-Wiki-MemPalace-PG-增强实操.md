# RAG / Wiki / MemPalace / PostgreSQL 知识能力增强实操

本文面向运营与工程，与 `agents-service-v2` 代码及 **`GET /api/admin/knowledge-sources`**（管理端「知识源体检」）对齐。更短的路由与触发词摘要见：`agents-service-v2/docs/AGENT_KNOWLEDGE_TRIGGER_KEYWORDS.md`。

---

## 一、先搞清四块「各管什么」

| 组件 | 物理位置 | 主要消费者 | 体检卡片里看什么 |
|------|-----------|------------|------------------|
| **RAG** | PG 表 `knowledge_base` | **`train_advisor`**（菜单/SOP/开档等） | 总行数、按 `scope` 分布、`last_updated` |
| **Wiki** | 磁盘目录 `knowledge/wiki/*.md`（可用 `WIKI_DATA_DIR` 覆盖） | **`data_auditor`**、`**train_advisor**`（`buildExperienceBlock`） | `.md` 数量、目录是否可读 |
| **MemPalace** | 独立 HTTP 服务（JSONL） | **`marketing_planner`**（高分策略写入/召回） | 是否可达、`/inventory` 条数、是否 `ENABLE_MEMPALACE` |
| **PG 记忆/图谱** | `agent_memory`、`agent_experience`、`business_entity_relations` 等 | 多 Agent `recallMemories`、经验块、HRMS 图谱 | 近 7 日 memory 量、图谱行数等 |

---

## 二、RAG（`knowledge_base`）— 要命中必须满足的条件

### 2.1 谁能搜到

- 只有路由到 **`train_advisor`** 时才会走 `fetchKnowledgeSnippetsForTrainAdvisor`（见 `agent-handlers.js`）。用户问法需贴近：菜单、菜谱、SOP、开档/收档清单、档口、培训课件等（详见触发词文档）。
- 行必须 **`enabled` 不为 false**（`NULL` 或 `true` 视为可用）。

### 2.2 `scope` 与角色对齐（否则整行被 SQL 过滤掉）

与 HRMS `rag-tool.js` 的 `getAllowedScopes` 对齐，例如：

- `store_manager` / `store_production_manager` / `front_manager`：**`public` + `business`**（**没有** `sensitive`）。
- `employee` / `store_staff`：仅 **`public`**。
- `admin` / `hq_manager` / `hr_manager`：**`public` + `business` + `sensitive`**。

**实操**：在 HRMS 知识库上传或后台维护时，为每条文档选对 **`scope`**；敏感制度不要标成 `public` 又给门店角色用，否则要么看不到、要么需改角色。

### 2.3 品牌 / 门店过滤（`filterKbRowsByBrandStore`）

- 系统会按门店解析**品牌**，优先保留标题/正文/`tags` 里带该品牌的内容。
- **`tags` 中含 `brand:all`（不区分大小写）** 的文档对所有门店可见。

**实操**：多品牌共用 SOP 时，在 `tags` 写 `brand:all`；单品牌专用文档在正文或标题中出现品牌名，或在 tags 里带品牌标识。

### 2.4 检索质量：不是「有 PDF 就行」

- **扫描件**：若未 OCR 出可复制文本，`content` 为空或极短，**永远搜不到**。应使用可提取文字的 PDF，或在 HRMS 侧改为文本/HTML。
- **关键词**：检索使用用户原句拆出的 `ILIKE` 模式 + 可选 **`pg_trgm` `word_similarity`**（需库中已安装扩展，见迁移 **`011`** 一类脚本）。问句尽量包含菜名、档口名、规范里的实际用词。
- **兜底**：若带 scope 的查询无行，会做一次**不限制 scope** 的降级查询；仍无则回复会提示未命中知识库。

**自检**：管理端「知识源体检」看 `knowledge_base` 行数与 `scope` 分布；用飞书同一账号发一句明确触发 `train_advisor` 的话，看回复是否出现「系统检索到的知识库原文」块。

---

## 三、Wiki（`knowledge/wiki`）— 经验从哪里来

### 3.1 写入

- 高质量结构化结论主要由 **`data_auditor`** 等 Agent 经 **`writeWikiKnowledge`** 落盘（`wiki-writer.js`），审计 JSONL 在同目录旁路记录。

### 3.2 读取

- **`buildExperienceBlock`** 会 `retrieveWikiKnowledge({ store, query })`，与 **`agent_memory`**、策略统计等拼成「引用经验」类块。

**实操**

1. 多跑 **`data_auditor`** 能产出「可沉淀」的分析（同一门店、同类问题），Wiki `.md` 会逐步变多。
2. 生产环境建议设置 **`WIKI_DATA_DIR`** 指向持久数据卷，避免容器重建后 Wiki 清空；体检里 `WIKI_DATA_DIR_SET` 为 true 表示已显式配置。
3. 若 `.md` 为 0：先确认进程工作目录下 `knowledge/wiki` 或 `WIKI_DATA_DIR` 是否有文件、权限是否可读。

---

## 四、MemPalace — 营销策划「高分策略记忆」

### 4.1 环境变量（ECS / `.env`）

- **`ENABLE_MEMPALACE=true`**：业务上才会走写入/召回逻辑（与「探测是否 HTTP 可达」不同；体检仍会 `GET /health` 试连）。
- **`MEMPALACE_URL`**：例如 `http://127.0.0.1:3001` 或内网地址；不填时会尝试读 monorepo `mempalace/.active-port`（生产 ECS 上通常**应显式设置 URL**）。
- 可选：`MEMPALACE_HTTP_TOKEN` / `MEMPALACE_BEARER_TOKEN`、`MEMPALACE_HTTP_TIMEOUT_MS`。

### 4.2 写入门槛（`memory-adapter.js`）

- **`saveMemory`** 要求 `metadata.score >= 0.7` 才会 POST `/memory`；且 `wing`（门店）、`room`（agent）、`content` 非空。

**实操**

1. 用文档中的营销类例句走 **`marketing_planner`**，多轮产生高分策略后，体检中 MemPalace **条数**应随时间上升。
2. 若「可达」但条数长期为 0：检查策略打分是否低于 0.7、门店/agent 字段是否为空、MemPalace 服务日志。

---

## 五、PostgreSQL（`agent_memory` / 图谱 / `agent_experience`）

### 5.1 `agent_memory`

- 多数 Agent 在对话中会 `recallMemories`；`buildExperienceBlock` 也会查近期记忆。
- **增强**：同一 Agent、同一门店保持连续业务对话，避免每次都新话题零上下文；体检中「近 7 日总量 / 按 agent」应有合理分布。

### 5.2 `agent_experience`

- 体检会返回总行数（若表存在）。具体写入路径以你们已上的迁移与任务为准；若总为 0，需对照是否跑了初始化脚本或定时汇总任务。

### 5.3 `business_entity_relations`（知识图谱）

- 主要在 **HRMS** 侧构建与消费；agents 体检只统计**行数**用于判断「是否迁移到同一 PG」。
- **增强**：在 HRMS 跑图谱同步/导入任务，保证该表随业务增长；agents 侧无单独「关键词」绑定。

---

## 六、`replyEngine`（代码构建号）与发布验收

- 构建号定义在 **`agents-service-v2/src/reply-engine-version.js`** 的 **`REPLY_ENGINE_BUILD`**，由人工在**重要逻辑或发布前**递增；**不是** npm version、也不是 Git SHA 自动生成。
- 部署后请 **`GET /health`**（或管理端「线上版本核对」）查看 `replyEngine` 是否与刚合并的代码一致。
- 若 push 后仍不变：检查 GitHub Actions **`safe-deployment`** 是否成功、ECS 上 `pm2 restart` 是否执行、是否连错环境端口。

---

## 七、推荐运维节奏（可打印 checklist）

1. 每次发版：改 **`reply-engine-version.js`** → push → 等 CI → **`curl .../health`** 核对 `replyEngine`。
2. 每周：管理端打开「记忆」页 → **刷新知识源体检** → 看 RAG 行数、Wiki md 数、MemPalace 条数、7 日 memory。
3. 每月：抽查 `knowledge_base` 扫描件比例；抽查 `scope` 与角色；Wiki 目录是否持久化到数据卷。

---

## 八、相关接口与文件（便于跳转）

| 项目 | 路径或 URL |
|------|------------|
| 体检 API | `GET /api/admin/knowledge-sources`（需 `admin` / `hq_manager`） |
| 触发词与路由 | `agents-service-v2/docs/AGENT_KNOWLEDGE_TRIGGER_KEYWORDS.md` |
| RAG 检索实现 | `agents-service-v2/src/services/agent-handlers.js`（`fetchKnowledgeSnippetsForTrainAdvisor` 等） |
| Wiki 读写 | `agents-service-v2/src/services/knowledge/wiki-retriever.js`、`wiki-writer.js` |
| MemPalace | `agents-service-v2/src/services/memory-adapter.js` |
| 部署说明 | `agents-service-v2/部署到ECS-看这里.md` |
