# 培训认证模块设计文档

**日期：** 2026-05-19  
**状态：** 已审批，待实现  
**范围：** 独立培训模块，在现有 HRMS 内新增，不修改现有知识库逻辑

---

## 1. 背景与目标

现有知识库是一个文件浏览器，缺乏学习闭环。本模块将其升级为：

- 管理层按**岗位**定义知识点大纲，并可针对**每个员工**单独指派培训任务（可设到期日）
- 员工通过**AI对话**学习知识点，完成**3道选择题测验**（≥2/3 通过）
- 测验通过后，员工上传**实操视频/照片**，由 **Qwen-VL** AI 判定是否合格
- 管理层可**人工复核** AI 判定结果，最终颁发「已认证」标志

---

## 2. 数据库设计（4 张新表）

```sql
-- 知识点大纲（管理层维护）
CREATE TABLE training_topics (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(100) NOT NULL,         -- 如「油温控制」
  position    VARCHAR(50)  NOT NULL,          -- 如「炒锅」
  description TEXT,                           -- 富文本内容（学习材料）
  key_points  JSONB        DEFAULT '[]',      -- 核心要点数组，供AI作为context
  practice_task TEXT,                         -- 实操任务说明（拍摄要求）
  sort_order  INT          DEFAULT 0,
  is_active   BOOLEAN      DEFAULT true,
  created_by  VARCHAR(100),
  created_at  TIMESTAMP    DEFAULT NOW()
);

-- 培训指派（管理层 → 员工）
CREATE TABLE training_assignments (
  id          SERIAL PRIMARY KEY,
  employee_id INT          NOT NULL,          -- references employees(id)
  topic_id    INT          NOT NULL,
  assigned_by VARCHAR(100),
  due_date    DATE,
  note        TEXT,
  created_at  TIMESTAMP    DEFAULT NOW(),
  UNIQUE(employee_id, topic_id)
);

-- 学习会话（员工的学习进度）
CREATE TABLE training_sessions (
  id              SERIAL PRIMARY KEY,
  employee_id     INT          NOT NULL,
  topic_id        INT          NOT NULL,
  assignment_id   INT,                        -- nullable，自动匹配
  chat_history    JSONB        DEFAULT '[]',  -- [{role, content, ts}]
  quiz_questions  JSONB        DEFAULT '[]',  -- AI生成的3道题
  quiz_answers    JSONB        DEFAULT '[]',  -- 员工答案
  quiz_score      INT,                        -- 0-3
  quiz_passed     BOOLEAN      DEFAULT false,
  status          VARCHAR(20)  DEFAULT 'learning',
                                              -- learning/quiz_passed/certified/failed
  started_at      TIMESTAMP    DEFAULT NOW(),
  quiz_passed_at  TIMESTAMP,
  UNIQUE(employee_id, topic_id)               -- 每人每题一条记录，重置时更新
);

-- 实操认证（视频上传 + AI判定 + 管理层复核）
CREATE TABLE training_certifications (
  id                  SERIAL PRIMARY KEY,
  session_id          INT          NOT NULL,
  employee_id         INT          NOT NULL,
  topic_id            INT          NOT NULL,
  media_url           VARCHAR(500),
  media_type          VARCHAR(20),            -- video / image
  ai_verdict          VARCHAR(20),            -- passed / review / failed
  ai_feedback         TEXT,
  ai_raw_response     JSONB,
  manager_verdict     VARCHAR(20),            -- passed / failed（人工覆盖）
  manager_note        TEXT,
  manager_reviewed_by VARCHAR(100),
  certified_at        TIMESTAMP,
  created_at          TIMESTAMP    DEFAULT NOW()
);
```

---

## 3. API 路由

### 管理端

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/training/topics` | 知识点列表（?position=炒锅） |
| POST | `/api/training/topics` | 创建知识点 |
| PUT | `/api/training/topics/:id` | 更新知识点 |
| DELETE | `/api/training/topics/:id` | 停用知识点（软删除） |
| GET | `/api/training/assignments` | 指派列表（?employeeId=） |
| POST | `/api/training/assignments` | 指派培训给员工 |
| DELETE | `/api/training/assignments/:id` | 撤销指派 |
| GET | `/api/training/dashboard` | 团队进度看板（各知识点通过率） |
| GET | `/api/training/certifications/pending` | 待审核的实操认证列表 |
| POST | `/api/training/certifications/:id/review` | 管理层人工复核（passed/failed + note） |

### 员工端

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/training/my-topics` | 我的培训任务（含状态、到期日） |
| GET | `/api/training/topics/:id/session` | 获取或创建学习会话 |
| POST | `/api/training/sessions/:id/chat` | 发送消息，获取AI回复 |
| POST | `/api/training/sessions/:id/start-quiz` | 触发AI生成3道题 |
| POST | `/api/training/sessions/:id/submit-quiz` | 提交答案，获取得分 |
| POST | `/api/training/sessions/:id/upload-practice` | 上传实操视频/照片 |
| GET | `/api/training/my-certifications` | 我的认证记录 |

---

## 4. AI 管道

### 4a. 对话式学习（文字模型）
- 使用现有 dashscope `qwen-plus` / `qwen-turbo`
- System prompt 注入：`training_topics.description` + `key_points`
- 角色设定：餐饮培训助手，用简体中文，用具体例子解释
- 对话历史存入 `training_sessions.chat_history`
- **降级策略**：API 不可用时，返回静态内容（description 字段）供员工自读

### 4b. 测验生成（文字模型）
- 触发时机：员工点击「开始测验」
- Prompt：基于 `key_points` 生成 3 道单选题（含4个选项、正确答案、解析）
- 结果以 JSONB 存入 `quiz_questions`，正确答案不传给前端
- 服务端校验答案，计算得分
- **降级策略**：API 不可用时，允许管理员在 `training_topics` 中预置题库（key_points 中添加 quiz 字段）

### 4c. 实操视频判定（Qwen-VL 多模态）
- 输入：视频/图片 URL + `practice_task` 说明 + `key_points`
- 对视频取 3 帧（开头/中间/结尾）分别分析
- 输出三级判定：`passed` / `review`（建议人工复核）/ `failed`
- 附具体反馈文字
- **降级策略**：Qwen-VL 不可用时，自动设为 `review` 状态，转人工判定

---

## 5. 前端结构（working-fixed.html）

### 员工端（新增「培训」导航入口）
1. **培训首页**：任务卡片列表，显示状态（未开始/学习中/待认证/已认证）和到期日
2. **学习界面**：类似对话框的AI培训，底部有「开始测验」按钮（需滚动到底才可点击）
3. **测验界面**：3道单选题逐题展示，提交后显示得分和解析
4. **实操上传界面**：展示 `practice_task` 拍摄要求，文件上传区，提交后展示 AI 判定结果

### 管理后台（在现有管理标签页中新增「培训管理」tab）
1. **知识点大纲** tab：按岗位过滤，CRUD 操作，支持编辑 key_points 和 practice_task
2. **培训计划** tab：选择员工 + 知识点 + 到期日进行指派，查看现有指派
3. **进度看板** tab：各知识点通过人数/总人数，可展开查看个人状态
4. **待审核** tab：实操视频列表，内嵌视频播放，通过/不通过按钮

---

## 6. 文件上传

复用现有 `multer` 基础设施（已支持图片和视频）：
- 新增 `trainingPracticeUpload` multer 配置，存储为 `training-{uuid}.{ext}`
- 支持格式：MP4、MOV、WEBM（视频）、JPG、PNG（图片）
- 最大 200MB（与现有食谱步骤上传一致）
- 存路径：`/uploads/training/`

---

## 7. 可独立验证的核心功能（无需 AI API）

以下功能完全不依赖外部 AI API，可独立开发和测试：
- 知识点大纲 CRUD
- 培训计划指派（员工 ↔ 知识点 + 到期日）
- 学习会话创建和状态跟踪
- 实操视频上传（存储到 /uploads/training/）
- 管理层人工审核（verdict + note）
- 进度看板数据查询
- 待审核列表

AI 功能（对话、测验生成、视频判定）作为增强层，通过环境变量 `TRAINING_AI_ENABLED=true` 开关控制。

---

## 8. 实现顺序

1. 数据库 schema（4 张表）
2. 后端 API（`server/training.js` 新文件）+ 挂载到 `server/index.js`
3. 前端管理端（知识点大纲 + 培训计划 + 进度看板 + 待审核）
4. 前端员工端（培训首页 + 学习/测验/上传界面）
5. AI 对话接入（dashscope 文字模型）
6. 测验生成接入
7. Qwen-VL 实操判定接入
