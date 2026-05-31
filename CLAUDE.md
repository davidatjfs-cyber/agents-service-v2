# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## 5. Deployment & Server Info

- **Server**: root@47.100.96.30 (passwordless SSH)
- **Nginx serves from**: `/opt/hrms` (NOT `/root/hr-management-system/`)
- **HRMS deploy**: `scp` files to `root@47.100.96.30:/opt/hrms/` then `ssh root@47.100.96.30 "pm2 restart hrms-service"`
- **Agents-service-v2 deploy**: `scp` to `root@47.100.96.30:/opt/agents-service-v2/` then `pm2 restart agents-service-v2`（注意是 `/opt`，不是 `/root`；pm2 真实 cwd 即 `/opt/agents-service-v2`）
- **Local code**: `/Users/magainze/HRMS/hr-management-system/`
- **PM2 processes**: `hrms-service` (port 3000), `agents-service-v2` (port 3101)
- **DB**: `postgres://hrms:Abc1234567!@127.0.0.1:5432/hrms`
- **Auth token**: localStorage key `hrms_token`
- **Server files**: working-fixed.html, sw.js → `/opt/hrms/`; server/*.js → `/opt/hrms/server/`

### ⚠️ 部署前必做：核对本地与生产是否同源（血泪教训）

生产是**按文件 scp 拼装**的，不同文件可能来自不同分支——本地某个文件直接覆盖上去会删掉生产独有功能、导致服务崩溃。
（真实事故：本地 `growth-api.js` 是 `main` 分支版，生产跑的是 `claude/hungry-bell-98fbf1` 版，多了企微每日日报/`setSendGrowthAlert` 等。直接覆盖 → `index.js` 找不到导出 → 整个服务起不来。）

**每次 scp 覆盖某个 server/*.js 前，必须：**
1. **先拉生产现版对比**：`scp root@47.100.96.30:/opt/hrms/server/<file> /tmp/prod-<file>`，与本地 diff。差异异常大 → 八成不同源，停下核实，别直接覆盖。
2. **校验导入/导出契约**：被覆盖文件若被 `index.js` 等 import（如 `setSendGrowthAlert`），确认新文件仍导出这些符号，否则启动即崩。
3. **部署后必须验证服务真的起来了**（不能只看 `pm2 status` 显示 online，崩溃重启也可能短暂 online）：
   - `ssh root@47.100.96.30 "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/"` 必须返回 `200`
   - `ssh root@47.100.96.30 "pm2 logs hrms-service --err --lines 10 --nostream"` 不能有 `SyntaxError`/`does not provide an export`
4. **覆盖前先备份生产文件**：`ssh root@47.100.96.30 "cp /opt/hrms/server/<file> /opt/hrms/server/<file>.bak.$(date +%s)"`，便于秒级回滚。
5. 部署成功后，把上线版同步回本地（`md5` 校验一致），避免本地再次成为"会炸生产的旧版"。

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
