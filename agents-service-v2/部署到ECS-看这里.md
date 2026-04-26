# 部署到 ECS（给非开发同事看的）

## 部署入口速查：该跑哪个脚本？

以下路径均以 **HRMS monorepo 根目录** 为基准（与 `agents-service-v2` 同级有 `hr-management-system/`、`scripts/`）。先把终端 `cd` 到你的仓库根，例如：

```bash
cd /你的路径/HRMS
export ECS_HOST=root@你的ECS公网IP或SSH别名
```

| 场景 | 实际执行的部署文件（入口） | 命令（在 monorepo 根执行） |
|------|---------------------------|---------------------------|
| **只发 Agents Service V2**（Node 服务 + pm2，**默认会顺带发 HRMS 静态**） | `agents-service-v2/scripts/deploy-agents-ecs.sh`（推荐）或薄封装 `agents-service-v2/scripts/deploy-safe.sh` | `bash agents-service-v2/scripts/deploy-agents-ecs.sh`<br>或：`cd agents-service-v2 && bash scripts/deploy-safe.sh` |
| **只发 Agents、不要动 HRMS 前端静态** | 同上，但关前端联动 | `HRMS_FRONTEND_DEPLOY=0 bash agents-service-v2/scripts/deploy-agents-ecs.sh` |
| **只发 HRMS（后端 + 前端静态，标准入口）** | `hr-management-system/scripts/deploy-hrms-safe.sh`（内部依次调用下面两行） | `cd hr-management-system && bash scripts/deploy-hrms-safe.sh` |
| **只发 HRMS 后端**（`hrms-service` pm2） | `scripts/deploy-hrms-server-ecs.sh` | `bash scripts/deploy-hrms-server-ecs.sh` |
| **只发 HRMS 前端静态**（`working-fixed.html` / `sw.js` 等到 `/opt/hrms`） | `scripts/deploy-hrms-frontend.sh` | `bash scripts/deploy-hrms-frontend.sh` |
| **全量安全发布**（数据库备份 + agents + HRMS 等，步骤多、最慢） | `scripts/deploy-safe.sh` | `bash scripts/deploy-safe.sh` |

**说明：**

- **Agents 与 HRMS 静态**：`deploy-agents-ecs.sh` 末尾若存在 `HRMS/scripts/deploy-hrms-frontend.sh`（即完整 monorepo），默认 `HRMS_FRONTEND_DEPLOY=1` 会再跑一遍 HRMS 静态部署。只改 agents 且不想碰前端时务必加 `HRMS_FRONTEND_DEPLOY=0`。
- **CI**：Agents 对应 `.github/workflows/safe-deployment.yml`；HRMS 对应 `hrms-safe-deployment.yml`（见各 workflow 内调用的脚本，与上表一致）。
- **回滚**：ECS 上 `/opt/scripts/deploy-rollback.sh`（见根目录 `scripts/deploy-safe.sh` 头部注释）。

---

## 易错清单（部署前对照）

1. **`replyEngine` 与 `admin.html` 里 `?v=` 不是一回事**：`/health` 里的 `replyEngine` 只来自 `agents-service-v2/src/reply-engine-version.js`；`public/admin.html` 里 `admin-app.js?v=…` 只影响浏览器缓存静态 JS。改了一边忘改另一边会造成「界面像新版本、健康检查仍是旧构建号」的错觉。
2. **`src/` 有改动必须递增 `REPLY_ENGINE_BUILD`**（同一推送范围内）。部署脚本默认会对比 `origin/main...HEAD`；若被误拦，先确认已提交 `reply-engine-version.js`，或紧急 `SKIP_REPLY_ENGINE_BUMP_CHECK=1`（不推荐常态使用）。
3. **在 ECS 上 `git pull` 无效**：`/opt/agents-service-v2` 一般是 **rsync 同步目录，没有 `.git`**，更新代码必须来自本机脚本或 GitHub Actions，而不是在服务器上 pull。
4. **在 ECS 家目录执行 `bash agents-service-v2/...`**：会报找不到文件；脚本应在 **本机** 从 monorepo 路径执行，或 Actions 里配置的工作目录执行。
5. **用公网域名测 `/health` 可能 404 或路径不对**：以 **ECS 本机** `curl -sS http://127.0.0.1:3101/health` 为准（或你们 nginx 已正确反代后的 URL）；不要把「未配置反代的路径」当成没部署成功。
6. **HRMS 静态必须进 `/opt/hrms/` 根**：不要只拷到 `/opt/hrms/hr-management-system/` 子目录；nginx `root` 与 `deploy-hrms-frontend.sh` 约定见该脚本头部注释。
7. **只 `pm2 restart` 不 rsync**：若本机代码未同步，重启的仍是旧磁盘文件。
8. **未配置 SSH**：`ECS_HOST` 无法连接时，只能改用 GitHub Actions 或请已配密钥的同事执行。

### `deploy-agents-ecs.sh` 常用环境变量

| 变量 | 默认 | 含义 |
|------|------|------|
| `ECS_HOST` | `root@47.100.96.30` | SSH 目标 |
| `REMOTE_DIR` | `/opt/agents-service-v2` | 远端目录 |
| `SKIP_VERIFY` | `0` | `1` 跳过本地 `verify-agents-local.sh`（紧急用） |
| `SKIP_REPLY_ENGINE_BUMP_CHECK` | `0` | `1` 跳过「src 变更必须带 version 文件」检查 |
| `AGENTS_DEPLOY_BASE_REF` | `origin/main` | 上述检查时的 git 基线 |
| `HRMS_FRONTEND_DEPLOY` | `1` | `0` 不调用 `scripts/deploy-hrms-frontend.sh` |
| `AGENTS_BACKUP_BEFORE_DEPLOY` / `AGENTS_DEPLOY_REQUIRE_BACKUP` | `1` | 远端 tar 备份；失败是否阻断 |

---

## 强制：每次更新 Agents Service V2 必须同步更新 `replyEngine`

**规则**：只要本次发布改动了 `agents-service-v2` 下的业务代码、依赖、配置逻辑或任何会影响线上行为的内容，**必须在同一提交（或紧挨着的提交）里递增** `src/reply-engine-version.js` 中的 **`REPLY_ENGINE_BUILD`**（例如 `20260415A` → `20260415B`）。

**原因**：生产验收与排障依赖 **`GET /health`** 返回的 **`replyEngine`** 与当前磁盘上的 `reply-engine-version.js` 一致；若只部署代码却忘记改构建号，**无法区分**「旧包未退」与「新包已上但无标识」，线上版本核对面板也会误导。

**操作**：编辑 `agents-service-v2/src/reply-engine-version.js` → `commit` → 再执行本文「办法 A / 办法 B」部署 → 用 `curl .../health` 或管理端「线上版本核对」确认 `replyEngine` 已变。

---

## 开发机 / Cursor 能否代跑部署？

- **可以**：当前电脑已对 ECS **配置好免密 SSH**（如 `export ECS_HOST=root@公网IP`）时，在本机项目里执行 **`bash agents-service-v2/scripts/deploy-agents-ecs.sh`** 与人工执行等价（脚本会 `rsync`、`npm install`、`pm2 restart`）。  
- **不可以**：未配置密钥、或网络访问不到 ECS、或 CI Secrets 未配时，只能走 GitHub Actions 或请同事在本机执行。

能自动部署的路径：**GitHub Actions**（`.github/workflows/safe-deployment.yml`）或 **本机脚本**（与 workflow 调用同一套 `deploy-agents-ecs.sh`）。

---

## 你在 ECS 上执行错了什么？

1. 在 `root` 家目录执行 `bash agents-service-v2/...` → 那里**没有**这个文件夹，所以报「找不到文件」。
2. 在 `/opt/agents-service-v2` 里执行 `git pull` → 报 **not a git repository** 是正常的：  
   **服务器上的目录一般是 rsync 拷上去的，不是 `git clone`，所以没有 `.git`，`git pull` 永远不会更新代码。**

---

## 正确做法（二选一）

### 办法 A：在你自己的电脑上部署（推荐，和 workflow 里脚本一致）

1. 电脑上要有完整项目（含你改过的 `agents-service-v2`）。
2. 打开终端，执行（把 `你的服务器` 换成实际 IP 或域名）：

```bash
cd /你的项目路径/HRMS/agents-service-v2
export ECS_HOST=root@你的服务器
bash scripts/deploy-agents-ecs.sh
```

脚本会做：`rsync` 把代码同步到 ECS 的 `/opt/agents-service-v2`，再远程 `npm install`、`pm2 restart`。

3. 在 ECS 上检查是否新版本：

```bash
curl -sS http://127.0.0.1:3101/health
```

看里面的 **`replyEngine`** 是否已变成你当前代码里 **`src/reply-engine-version.js`** 的版本（须与本次发布一并改过，见上文「强制」）。

---

### 办法 B：用 GitHub 自动部署（push 后由 GitHub 帮你 SSH 到 ECS）

1. 代码 **commit 并 push** 到 GitHub 的 **`main`** 分支（变更需在 `agents-service-v2/**` 下才会触发）。
2. 仓库 **Settings → Secrets** 里配置好 **`ECS_SSH_PRIVATE_KEY`**（以及可选 **`ECS_HOST`**）。
3. Workflow 文件：`.github/workflows/safe-deployment.yml`。  
   **push 到 `main` 且 verify 通过后即自动部署**（无需再设 `AGENTS_V2_AUTO_DEPLOY`）。

若不想随 push 部署：到 **Actions** 里手动 **Run workflow**（`safe-deployment`），勾选 **deploy_ecs**。

标准入口脚本与本地一致：`bash scripts/deploy-safe.sh`（在 `agents-service-v2` 目录下）。

---

## 在 ECS 上只能「重启 / 装依赖」时用什么？

若代码**已经**被办法 A 或 B 同步上来了，你只想重启服务，可在服务器执行：

```bash
cd /opt/agents-service-v2
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
pm2 restart agents-service-v2
curl -sS http://127.0.0.1:3101/health
```

**注意：这不会把新代码从 GitHub 拉下来**（没有 `.git` 时 `git pull` 无效），新代码必须来自 **本机 rsync** 或 **GitHub Actions 部署**。

---

## 完整手动部署命令（复制整段）

**在你自己的 Mac 上**（先安装好 Node.js；项目路径按实际修改）：

```bash
# 1）进入服务目录
cd /Users/magainze/HRMS/agents-service-v2

# 2）指定 ECS 登录方式（二选一）
# 方式 A：已配置 ssh 免密
export ECS_HOST=root@你的服务器公网IP或域名

# 方式 B：写在 ssh config 里则用别名，例如：
# export ECS_HOST=my-ecs

# 3）执行部署（会本地校验语法 → rsync → 远端 npm install → pm2 restart）
bash scripts/deploy-agents-ecs.sh
```

**部署完成后在 ECS 上验收版本**（SSH 登录服务器后）：

```bash
curl -sS http://127.0.0.1:3101/health
# 看 JSON 里的 replyEngine 是否与当前代码 src/reply-engine-version.js 一致
```

**仅重启、不更新代码**（代码已同步过）：

```bash
cd /opt/agents-service-v2
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
pm2 restart agents-service-v2
sleep 3
curl -sS http://127.0.0.1:3101/health
```

---

## 手动发一轮晨报（看格式 / 验收）

接口：`POST /api/briefing/send-now`，需要 **admin** 或 **hq_manager** 的 JWT。

### 方法一：脚本（推荐）

在 **Mac**（连得到服务地址时）或 **ECS 本机**：

```bash
cd /opt/agents-service-v2   # 或你 Mac 上的 agents-service-v2 目录；只要能访问到 API

# 先确认脚本已随 rsync 上到服务器（没有则说明 Mac 上未包含最新代码或未完整部署）
ls -la scripts/trigger-morning-briefing.sh scripts/trigger-morning-briefing.mjs

# 本机访问 ECS 上的服务时，把地址改成 https://你的域名 或 http://公网IP:3101
export AGENTS_BASE_URL=http://127.0.0.1:3101

# 与服务器 .env / .env.production 里一致（不要用默认弱密码上生产）
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD='你的管理员密码'

# 任选其一（推荐 .mjs，不依赖 .sh 是否可执行）
node scripts/trigger-morning-briefing.mjs
# 或：bash scripts/trigger-morning-briefing.sh
```

**若提示 `No such file or directory`：**  
说明当前 ECS 上的 `/opt/agents-service-v2/scripts/` 里**还没有**这两个文件。请在 **Mac** 上确认本机项目里存在 `agents-service-v2/scripts/trigger-morning-briefing.mjs`，再执行一次 **`bash scripts/deploy-agents-ecs.sh`** 完整同步（不要只在服务器上 `npm install`）。

### 方法一 B：不依赖脚本文件（ECS 上一条命令）

只要本机装有 **Node 18+**（与 pm2 用的 node 一致即可），可直接：

```bash
cd /opt/agents-service-v2
ADMIN_PASSWORD='你的密码' node -e "
(async()=>{
  const base='http://127.0.0.1:3101';
  const u=process.env.ADMIN_USERNAME||'admin';
  const p=process.env.ADMIN_PASSWORD||'';
  const r1=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
  const j1=await r1.json();
  if(!j1.token){console.error('登录失败',j1);process.exit(1);}
  console.log('正在发晨报…');
  const r2=await fetch(base+'/api/briefing/send-now',{method:'POST',headers:{Authorization:'Bearer '+j1.token,'Content-Type':'application/json'},body:'{}'});
  console.log(r2.status, await r2.text());
})();"
```

成功时最后会打印 `HTTP 200 {"ok":true,"message":"晨报已发送完成，请查收飞书"}`。  
然后去飞书看 **年年有喜超级助手** 推送的卡片。

### 方法二：两条 curl（无 Node 脚本时）

**第 1 步 — 登录拿 token：**

```bash
curl -sS -X POST "http://127.0.0.1:3101/api/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"你的密码"}'
```

复制返回 JSON 里的 **`token`**。

**第 2 步 — 触发晨报（把下面 TOKEN 换成上一步的 token）：**

```bash
curl -sS -X POST "http://127.0.0.1:3101/api/briefing/send-now" \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

> 若登录返回 `login_disabled`，需在服务器环境变量里开启登录（见 `isLoginEnabled()` 相关配置）。

---

## 说明：谁会收到晨报？

`sendMorningBriefing` 会给 **`feishu_users` 里已注册、且角色为** `store_manager` / `store_production_manager` / `hq_manager` / `admin` **的用户发飞书卡片**；总部账号会收到「全门店汇总」。

---

## 知识源增强文档放在哪？

仓库根目录（与 `agents-service-v2` 同级）下的 **`doc/`** 里：

- **`doc/RAG-Wiki-MemPalace-PG-增强实操.md`**（RAG / Wiki / MemPalace / PG 运维增强说明）

**不在** `agents-service-v2/` 子目录内；若单独拆仓只保留 `agents-service-v2` 目录，请把该文件同步进拆仓后的 `docs/` 或随 monorepo 一起发布。
