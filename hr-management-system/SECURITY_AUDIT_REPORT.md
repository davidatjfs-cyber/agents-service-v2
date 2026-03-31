# HRMS 安全审计与架构重构报告

**审计日期**: 2026-02-22
**审计范围**: hr-management-system/server/ 全部后端代码
**审计人**: AI Security Auditor

---

## 一、问题总览

| 等级 | 数量 | 已修复 | 说明 |
|------|------|--------|------|
| 🔴 CRITICAL | 5 | 4 | 可被远程利用的安全漏洞 |
| 🟠 HIGH | 6 | 6 | 严重架构/安全问题 |
| 🟡 MEDIUM | 8 | 5 | 代码质量/潜在风险 |
| 🔵 LOW | 5 | 0 | 代码规范/可维护性（建议后续处理） |

---

## 二、🔴 CRITICAL 级别问题

### C1. SQL注入漏洞 — agent-communication-system.js:401
**位置**: `server/agent-communication-system.js` 第401行
**风险**: `timeRange` 参数直接拼接到SQL字符串，攻击者可注入任意SQL。
```javascript
// ❌ 危险代码
WHERE created_at >= NOW() - INTERVAL '${timeRange}'
```
**修复**: ✅ 已修复 — 使用白名单校验，只允许 `1d/7d/30d/90d` 四个预定义值。

### C2. SQL注入漏洞 — agents.js:3341
**位置**: `server/agents.js` 第3341行
**风险**: `config.firstReminder` 直接拼接到SQL INTERVAL。虽然当前来自内部配置，但违反安全编码原则。
```javascript
// ❌ 危险代码
AND t.created_at < NOW() - INTERVAL '${config.firstReminder} minutes'
```
**修复**: ✅ 已修复 — 使用参数化的 `make_interval(mins => $2)` 替代字符串拼接。

### C3. SQL注入漏洞 — agents.js:4823
**位置**: `server/agents.js` 第4823行
**风险**: `days` 参数直接拼接到SQL。
```javascript
// ❌ 危险代码
AND created_at >= NOW() - INTERVAL '${days} days'
```
**修复**: ✅ 已修复 — 使用参数化的 `make_interval(days => $2)` 替代字符串拼接。

### C4. 明文密码存储 — index.js:9270-9271
**位置**: `server/index.js` 第9258-9280行
**风险**: hrms_state 中的用户密码以明文存储和比较。攻击者获取数据库读权限即可获取所有用户密码。change-password 也将新密码明文写回 state。
```javascript
// ❌ 危险代码
const pwd = String(found.password || '');
if (pwd !== password) return res.status(401).json(...)
// change-password 中:
{ ...it, password: newPassword }  // 明文写入state
```
**修复**: ⚠️ 未修复 — 这是一个深层架构问题，需要迁移所有用户到 `users` 表并使用bcrypt，同时从 hrms_state 中移除密码字段。建议单独排期处理。

### C5. 硬编码后备JWT密钥 — index.js:8649, 9277, 9290
**位置**: `server/index.js` 多处
**风险**: `JWT_SECRET || 'local_dev_secret'` — 如果环境变量未设置，所有JWT使用已知密钥签发，任何人可伪造任意身份token。
```javascript
// ❌ 危险代码
jwt.verify(token, JWT_SECRET || 'local_dev_secret');
jwt.sign({...}, JWT_SECRET || 'local_dev_secret', ...);
```
**修复**: ✅ 已修复 — 移除所有 `'local_dev_secret'` 后备，JWT_SECRET未配置时拒绝请求。

---

## 三、🟠 HIGH 级别问题

### H1. 未认证API端点暴露敏感数据 — index.js
**位置**: 
- `/api/agent/feishu-table-data` (第1585行) — 无auth，可查询飞书表格数据
- `/api/agent/table-visit-data` (第10304行) — 无auth，可查询桌访记录含客户信息
- `/api/agent/table-visit-summary` (第10430行) — 无auth，可查询统计摘要

**风险**: 任何人无需登录即可访问业务敏感数据。
**修复**: ✅ 已修复 — 三个端点均已添加 `authRequired` 中间件。

### H2. 路由处理器语法错误（代码断裂）— agents.js:4638-4673
**位置**: `server/agents.js` 第4638-4673行
**风险**: `/api/agents/test-feishu` 路由的 handler 在第4644行被截断，紧接着嵌套了 `test-vision` 路由定义，然后在第4669行出现了孤立的 `try { ... sendLarkMessage ... }` 代码块。这导致：
1. `test-feishu` 路由永远不会返回响应（请求挂起直到超时）
2. 第4669-4673行的代码属于 `test-feishu` 的闭合但逻辑上已断裂
3. Express 路由嵌套定义可能导致不可预期行为
**修复**: ✅ 已修复 — 重新组织三个路由处理器，确保每个都有完整的 try/catch 和响应。

### H3. CORS 完全开放 — index.js:34
**位置**: `server/index.js` 第34行
**风险**: `app.use(cors())` 允许任何域名跨域请求，配合未认证端点可被第三方网站直接调用API窃取数据。
**修复**: ✅ 已修复 — 支持通过环境变量 `CORS_ORIGINS` 配置白名单。

### H4. 本地测试账号在生产环境可用 — index.js:9183-9301
**位置**: `server/index.js` 第9183-9301行
**风险**: `LOCAL_TEST_ACCOUNTS` 包含 admin/admin123 硬编码账号，在生产环境中作为最后的登录回退仍然可用。
**修复**: ✅ 已修复 — 本地测试账号仅在 `NODE_ENV !== 'production'` 时可用。

### H5. JWT过期时间过长 — index.js:9246, 9279, 9295
**位置**: 多处 `jwt.sign`
**风险**: Token有效期14天，无刷新机制。Token泄露后攻击窗口过长。
**修复**: ✅ 已修复 — 所有JWT过期时间从14天缩短到7天。

### H6. pushIssueToAssignee 重复调用 getSharedState — agents.js:2472-2543
**位置**: `server/agents.js` 第2484和2502行
**风险**: 同一函数内两次调用 `getSharedState()`（一次查hq_manager，一次查admin），每次都是数据库查询。在批量督办场景下（N个门店 × M个issue），会产生 2×N×M 次额外DB查询，可能导致数据库过载。
**修复**: ✅ 已修复 — 合并为单次 `getSharedState()` 调用，同时查找 hq_manager 和 admin。

---

## 四、🟡 MEDIUM 级别问题

### M1. 错误信息泄露内部细节 — 多处
**位置**: 多个catch块返回 `e?.message` 给客户端
**风险**: 数据库错误、文件路径等内部信息可能泄露给攻击者。
```javascript
return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
```

### M2. _conversationContext Map 无大小限制 — agents.js:820
**位置**: `server/agents.js` 第820行
**风险**: `_conversationContext` Map 只在单用户维度清理（保留最近10条），但用户数量无上限，长期运行可能导致内存泄漏。
**修复**: ✅ 已修复 — 添加 MAX_CONTEXT_USERS=500 限制，超出时淘汰最旧用户上下文。

### M3. _opsChecklistProgress Map 无过期清理 — agents.js:282
**位置**: `server/agents.js` 第282行
**风险**: 检查表进度数据永不过期，如果用户开始检查但未完成，数据永远留在内存中。
**修复**: ✅ 已修复 — 添加每30分钟定期清理，超过2小时的条目自动删除。

### M4. 文件上传大小限制过大 — index.js:3402
**位置**: `server/index.js` 第3402行
**风险**: `fileSize: 300 * 1024 * 1024` (300MB) 过大，可被用于DoS攻击。
**修复**: ✅ 已修复 — 从300MB降到50MB。

### M5. 递归setTimeout无终止条件 — agents.js:2099-2121
**位置**: `server/agents.js` 第2099和2118行
**风险**: `scheduleNextTask()` 递归调用自身设置setTimeout，如果任务配置错误可能导致无限递归。

### M6. parseInt 缺少 radix 参数 — index.js:10350, 10355, 10360
**位置**: `server/index.js` 第10350等行
**风险**: `parseInt(minRating)` 缺少第二个参数，可能导致非十进制解析。
**修复**: ✅ 已修复 — 所有 parseInt 调用均添加 radix 参数 10。

### M7. 密码强度要求过低 — index.js:9316
**位置**: `server/index.js` 第9316行
**风险**: 仅要求密码长度≥6位，无复杂度要求。

### M8. Feishu Webhook 无签名验证 — agents.js (registerAgentRoutes)
**位置**: `server/agents.js` `/api/feishu/webhook` 路由
**风险**: 飞书webhook端点无请求签名验证，任何人可伪造飞书事件。

---

## 五、🔵 LOW 级别问题

### L1. 大量冗余注释块 — agents.js:2531-2553
**位置**: `server/agents.js` 第2531-2553行
**风险**: 连续8个相同模式的"注意：xxx已移交给 Chief Evaluator"注释，代码可读性差。

### L2. 测试/调试文件残留在项目根目录
**位置**: 项目根目录
**文件**: `db-check.js`, `db-check2.js`, `db-check3.js`, `db-check4.js`, `simple-test.js`, `test-*.js`, `debug.html`, `test.html`, `simple.html`
**风险**: 增加攻击面，暴露内部逻辑。

### L3. server.log 文件存在于代码仓库 — server/server.log
**位置**: `server/server.log`
**风险**: 日志文件可能包含敏感信息，不应纳入版本控制。

### L4. 单文件过大难以维护
**位置**: 
- `server/index.js`: 12004行 (526KB)
- `server/agents.js`: 4832行 (197KB)
- `working-fixed.html`: 1.7MB
**风险**: 极难维护、审计和测试。

### L5. agent-communication-system.js 查询不存在的表
**位置**: `server/agent-communication-system.js` 第400行
**风险**: 查询 `agent_issues_reports` 表，但数据库schema中只有 `agent_issues` 表，该查询永远失败。

---

## 六、架构问题总结

### 多模型生成导致的混乱
1. **函数重复定义**: `getBrandsFromState` 在 index.js 和 agents.js 中各有一份
2. **状态管理不一致**: getSharedState 在多个文件中各自实现
3. **命名风格混乱**: 部分用 camelCase，部分用 snake_case，部分用中文注释标记
4. **路由注册分散**: 路由分布在 index.js、agents.js (registerAgentRoutes)、master-agent.js (registerMasterRoutes)、new-scoring-api.js 四个文件中
5. **错误处理不统一**: 有的返回 `{ error: 'xxx' }`，有的返回 `{ success: false, error: 'xxx' }`，有的返回 `{ ok: false }`

---

## 七、修复汇总

### 已修复（本次审计直接修复）

| 编号 | 等级 | 文件 | 修复内容 |
|------|------|------|----------|
| C1 | CRITICAL | agent-communication-system.js | SQL注入 → 白名单校验 |
| C2 | CRITICAL | agents.js | SQL注入 → make_interval参数化 |
| C3 | CRITICAL | agents.js | SQL注入 → make_interval参数化 |
| C5 | CRITICAL | index.js | JWT硬编码密钥 → 移除后备，未配置时拒绝 |
| H1 | HIGH | index.js | 3个未认证端点 → 添加authRequired |
| H2 | HIGH | agents.js | 路由处理器断裂 → 重新组织闭合 |
| H3 | HIGH | index.js | CORS全开放 → 支持CORS_ORIGINS白名单 |
| H4 | HIGH | index.js | 测试账号 → 仅非production环境可用 |
| H5 | HIGH | index.js | JWT 14天 → 缩短到7天 |
| H6 | HIGH | agents.js | 重复DB查询 → 合并为单次调用 |
| M2 | MEDIUM | agents.js | 上下文Map无限增长 → 限制500用户 |
| M3 | MEDIUM | agents.js | 检查表Map无清理 → 30分钟定期清理 |
| M4 | MEDIUM | index.js | 上传300MB → 降到50MB |
| M6 | MEDIUM | index.js | parseInt缺radix → 添加radix=10 |

### 待修复（建议后续排期）

| 编号 | 等级 | 说明 | 建议 |
|------|------|------|------|
| C4 | CRITICAL | 明文密码存储 | 需要架构级迁移：所有用户迁移到users表+bcrypt，从hrms_state移除密码 |
| M1 | MEDIUM | 错误信息泄露 | 统一错误处理中间件，生产环境不返回e.message |
| M5 | MEDIUM | 递归setTimeout | 添加最大递归深度限制 |
| M7 | MEDIUM | 密码强度过低 | 增加复杂度要求（大小写+数字） |
| M8 | MEDIUM | Webhook无签名 | 添加飞书签名验证 |
| L1-L5 | LOW | 代码规范 | 清理测试文件、日志文件、冗余注释 |

### 部署前必须配置的环境变量

```bash
# 生产环境 .env 必须包含：
NODE_ENV=production
JWT_SECRET=<至少32位随机字符串>
DATABASE_URL=<PostgreSQL连接串>

# 推荐配置：
CORS_ORIGINS=https://your-domain.com,https://admin.your-domain.com
```

---
