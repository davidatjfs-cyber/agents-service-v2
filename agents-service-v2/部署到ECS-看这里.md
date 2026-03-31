# 部署到 ECS（给非开发同事看的）

## 为什么 AI（Cursor 里）不能帮你点部署？

它**没有你的服务器密码/密钥**，也**不能从你家网络 SSH 登录阿里云**，所以**永远不能代替你执行** `ssh` 或 `rsync`。  
能自动部署的只有：**GitHub Actions**（仓库里已写好 workflow）或 **你自己电脑上的脚本**。

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

看里面的 **`replyEngine`** 是否已变成你当前代码里的版本（例如 `20260322K`）。

---

### 办法 B：用 GitHub 自动部署（push 后由 GitHub 帮你 SSH 到 ECS）

1. 代码 **commit 并 push** 到 GitHub 的 **`main`** 分支。
2. 仓库 **Settings → Secrets** 里配置好 **`ECS_SSH_PRIVATE_KEY`**（以及可选 **`ECS_HOST`**）。
3. 仓库 **Settings → Variables** 里把 **`AGENTS_V2_AUTO_DEPLOY`** 设为 **`true`**（见 `.github/workflows/agents-service-v2.yml` 顶部说明）。  
   这样：**每次 push 改到 `agents-service-v2` 且 verify 通过，就会自动部署。**

若不想自动部署：到 **Actions** 里手动 **Run workflow**，勾选 **deploy_ecs**。

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
