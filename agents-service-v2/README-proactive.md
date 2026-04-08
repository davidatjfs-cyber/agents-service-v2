# Proactive 主动检测功能说明

## 概述

Proactive 模块实现了基于异常检测的主动分析功能。当系统检测到经营异常时，会自动触发对应的 AI Agent 进行深度分析，提供决策支持。

---

## 模块结构

```
src/services/proactive-v2/
├── config.js           # 配置管理
├── trigger-dedupe.js   # 触发去重
├── llm-decision.js      # LLM 决策引擎
├── anomaly-bridge.js    # 异常桥接
└── proactive-runner.js   # 调度器

src/services/agent-session/
├── config.js           # 会话配置
├── session-store.js     # 数据库存储层
├── session-service.js   # 业务逻辑层
└── session-middleware.js # 中间件层
```

---

## 配置说明

### 基本配置 (`proactive-v2/config.js`)

```javascript
module.exports = {
  // 是否启用 proactive 功能
  enabled: true,

  // 是否使用 LLM 进行决策判断
  useLLM: true,

  // 是否记录详细日志
  log: true,
};
```

### 会话配置 (`agent-session/config.js`)

```javascript
module.exports = {
  // 会话过期时间（分钟）
  sessionTimeoutMinutes: 30,

  // 最多连续提问轮数
  maxQuestionRounds: 3,

  // 是否启用会话功能
  enabled: true,
};
```

---

## 如何开启

### 第一阶段：不使用 LLM（快速验证）

```javascript
// 在 proactive-v2/config.js 中修改
module.exports = {
  enabled: true,
  useLLM: false,  // 不使用 LLM，直接使用 fallback 规则
  log: true,
};
```

此阶段仅使用内置的 fallback 规则：
- 营收下降 >20% → 触发
- 差评激增 ≥5条 → 触发
- 其他异常 → 不触发

### 第二阶段：使用 LLM（生产环境）

```javascript
// 在 proactive-v2/config.js 中修改
module.exports = {
  enabled: true,
  useLLM: true,  // 使用 LLM 进行智能判断
  log: true,
};
```

此阶段需要配置 LLM 提供商：

```bash
# .env 配置
OLLAMA_ENDPOINT=http://localhost:11434/api/generate
LLM_MODEL=gemma:7b
```

---

## 如何关闭

### 完全关闭 Proactive

```javascript
// 在 proactive-v2/config.js 中修改
module.exports = {
  enabled: false,
};
```

### 关闭 LLM 决策，仅使用 fallback 规则

```javascript
module.exports = {
  enabled: true,
  useLLM: false,
};
```

---

## Agent 会话功能

### 功能说明

当 Agent 需要更多信息才能给出完整答案时，可以向用户提问。系统会创建一个会话（Session），在 30 分钟内保持对话状态。

### 限制

- 同一用户只允许一个活动会话
- 最多连续提问 3 轮
- 会话 30 分钟自动过期

### 支持的 Agent

当前支持多轮对话的 Agent：
- `marketing_planner` - 营销策划（需要获取业务细节时）

### 使用示例

**用户**：帮我做一个营销方案

**System**：检测到需要更多信息，创建会话

**Marketing Planner**：请问你们有外卖业务吗？

**用户**：有的

**System**：恢复会话，继续对话

**Marketing Planner**：好的，根据外卖业务，我为您制定以下方案...

---

## 异常类型与 Agent 映射

| 异常类型 | 触发的 Agent |
|----------|--------------|
| `revenue_drop`, `revenue` | data_auditor, ops_supervisor, marketing_planner |
| `bad_review_spike`, `bad_review_service`, `bad_review_product` | food_quality, ops_supervisor |
| `gross_margin` | data_auditor, procurement_advisor |
| `labor` | ops_supervisor, data_auditor |
| `traffic` | marketing_planner, ops_supervisor |
| 其他 | data_auditor |

---

## 数据库表

### agent_sessions

| 字段 | 类型 | 说明 |
|------|------|------|
| session_id | TEXT | 会话ID（主键） |
| user_id | TEXT | 用户ID |
| store | TEXT | 门店名称 |
| agent | TEXT | Agent名称 |
| state | TEXT | 状态：active, closed, expired, replaced |
| context | JSONB | 会话上下文 |
| pending_question | TEXT | 待处理问题 |
| question_round | INTEGER | 问题轮次 |
| created_at | TIMESTAMP | 创建时间 |
| updated_at | TIMESTAMP | 更新时间 |

---

## 运行机制

### 触发流程

1. `anomaly-engine.js` 运行异常检测
2. `proactive-v2/anomaly-bridge.js` 接收异常数组
3. 对每个异常：
   - `trigger-dedupe.js` 检查去重（10分钟内不重复）
   - `llm-decision.js` 判断是否需要触发
4. 如果需要触发：
   - 调用 `agent-handlers.js` 的 `handleTrigger()` 函数
   - 串行执行对应 Agent 的分析

### 会话流程

1. `message-pipeline.js` 收到消息
2. `session-middleware.js` 检查是否有活动会话
3. 如果存在：
   - 跳过 intent/router
   - 直接调用会话中的 Agent
   - 传递会话上下文
4. Agent 返回响应：
   - `ask` → 创建/更新会话，返回问题
   - `final` → 关闭会话，返回答案

---

## 日志格式

所有新增逻辑使用统一日志格式：

```
[Proactive][Dedupe] Skipped duplicate trigger: 洪潮店/revenue (1 in 10min)
[Proactive][LLM] Decision: 马己仙店/revenue_drop -> triggered=true (450ms)
[Proactive Trigger] Type: revenue_drop, Store: 洪潮店, Severity: high
[Session][Middleware] Restored: abc-123 (marketing_planner)
```

---

## 注意事项

1. **不阻塞主流程**：所有新增逻辑都使用 try/catch，出错时不影响原有功能
2. **不 throw error**：异常只记录日志，不抛出
3. **幂等性**：同一异常在 10 分钟内不会重复触发
4. **超时控制**：LLM 调用超时 3000ms，自动使用 fallback 规则

---

## 数据库迁移

运行迁移脚本创建 `agent_sessions` 表：

```bash
npm run migrate
```

或在代码中调用：

```javascript
import { ensureTable } from './services/agent-session/session-service.js';
await ensureTable();
```
