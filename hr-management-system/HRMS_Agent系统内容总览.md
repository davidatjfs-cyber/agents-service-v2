# HRMS Agent 系统内容总览

## 📊 系统架构概览

HRMS采用多Agent架构，以飞书为唯一交互通道，实现智能化的门店管理和绩效评估。

| Agent类型 | 代码标识 | 主要职责 | 核心功能 | 配置文件 |
|---------|---------|---------|---------|---------|
| **Data Auditor** | BI | 数据审计员 | 异常检测、数据源管理 | `DATA_AUDITOR_CONFIG` |
| **Ops Agent** | OP | 营运督导员 | 任务派发、图片审核 | `OPS_AGENT_CONFIG` |
| **Chief Evaluator** | OKR | 绩效考核官 | 评分计算、绩效管理 | `CHIEF_EVALUATOR_CONFIG` |
| **SOP Agent** | SOP | 标准库顾问 | 知识库检索、SOP咨询 | `SOP_AGENT_CONFIG` |
| **Appeal Agent** | REF | 申诉处理员 | 申诉处理、证据核实 | `APPEAL_AGENT_CONFIG` |
| **Master Agent** | Master | 调度中枢 | 任务路由、状态管理 | `MASTER_AGENT_CONFIG` |

---

## 🔍 Data Auditor (BI Agent) - 数据审计员

### 📋 核心职责
- **统一管理所有数据源**: ops_checklist + table_visit + daily_reports + negative_reviews + 5个新增表格
- **异常检测和分类**: 8种异常类型，High/Medium/Low分级
- **责任认定**: store_manager(6项) + store_production_manager(2项)
- **不负责评分**: 只检测，不计算扣分

### 🗂️ 数据源配置

| 数据源 | 类型 | 轮询间隔 | 表格/数据库 | 状态 |
|--------|------|----------|------------|------|
| daily_reports | database | 5分钟 | daily_reports表 | ✅ |
| ops_checklist | bitable | 1分钟 | 运营检查表 | ✅ |
| table_visit | bitable | 5分钟 | 桌访表 | ✅ |
| negative_reviews | database | 5分钟 | negative_reviews表 | ✅ |
| closing_reports | bitable | 5分钟 | 收档报告DB | ✅ 新增 |
| opening_reports | bitable | 5分钟 | 开档报告 | ✅ 新增 |
| meeting_reports | bitable | 5分钟 | 例会报告 | ✅ 新增 |
| material_majixian | bitable | 5分钟 | 马己仙原料收货日报 | ✅ 新增 |
| material_hongchao | bitable | 5分钟 | 洪潮原料收货日报 | ✅ 新增 |

### ⚠️ 异常检测规则

| 异常类型 | 阈值设置 | 数据源 | 责任角色 | 维度 |
|---------|---------|--------|----------|------|
| 实收营收异常 | High:20%, Medium:10% | daily_reports | store_manager | 成本控制 |
| 人效值异常 | 洪潮:1200/1000, 马己仙:1300/1300 | daily_reports | store_manager | 成本控制 |
| 充值异常 | 0元, 连续2天 | daily_reports | store_manager | 成本控制 |
| 桌访异常 | High:4次, Medium:2次 | table_visit | store_production_manager | 质量得分 |
| 桌访占比异常 | High:40%, Medium:50% | table_visit + daily_reports | store_manager | 质量得分 |
| 总实收毛利率异常 | 洪潮:70%/69%, 马己仙:65%/64% | daily_reports | store_production_manager | 成本控制 |
| 产品差评异常 | High:3次, Medium:1次 | negative_reviews | store_production_manager | 质量得分 |
| 服务差评异常 | High:2次, Medium:1次 | negative_reviews | store_manager | 质量得分 |

### ⚙️ 执行配置
- **轮询间隔**: 30分钟
- **批处理大小**: 100条
- **重试次数**: 3次
- **超时时间**: 30秒

---

## 👥 Ops Agent (OP Agent) - 营运督导员

### 📋 核心职责
- **任务派发和跟踪**: 通过飞书通知责任人
- **执行质量监督**: 检查任务完成质量
- **图片审核**: 4种类型审核(hygiene/plating/general/seafood_pool_temperature)
- **结果反馈给OKR**: 提供执行质量数据
- **不负责评分**: 只审核，不扣分

### 📝 任务模板配置

| 任务类型 | 洪潮检查项 | 马己仙检查项 | 执行时间 |
|---------|------------|-------------|----------|
| **开市检查** | 地面清洁无积水、设备开启、食材检查、餐具消毒、灯光音乐、空调温度、仪容仪表 | 地面清洁、设备开启、食材准备、餐具消毒、迎宾准备 | 10:30 |
| **收档检查** | 食材封存、设备关闭、垃圾清理、安全检查、门窗锁好 | 食材封存、设备关闭、垃圾清理、安全检查、门窗锁好、电源关闭 | 22:30 |
| **巡检检查** | 大厅环境、服务台规范、卫生间清洁、后厨卫生、安全设施 | 同左 | 用户触发 |

### 🖼️ 图片审核能力

| 审核类型 | 专家角色 | 检查重点 | 质量阈值 |
|---------|----------|----------|----------|
| hygiene | 卫生检查专家 | 清洁卫生、食品安全 | confidence > 0.7, clarity > 0.6 |
| plating | 出品专家 | 菜品摆盘、色泽 | confidence > 0.7, clarity > 0.6 |
| general | 营运督导 | 综合检查 | confidence > 0.7, clarity > 0.6 |
| seafood_pool_temperature | 海鲜池专家 | 温度记录 | confidence > 0.7, clarity > 0.6 |

### 🛡️ 反作弊机制
- **SHA256图片去重**: 重复图片扣7分
- **Exif时间验证**: 检查拍摄时间
- **GPS位置检查**: 验证拍摄地点
- **质量阈值**: confidence > 0.7, clarity > 0.6

### ⚙️ 执行配置
- **任务超时**: 1小时
- **提醒间隔**: 15分钟
- **最大提醒**: 3次
- **质量监控**: 失败率>15%或重复率>10%自动报告

---

## 🏆 Chief Evaluator (OKR Agent) - 绩效考核官

### 📋 核心职责
- **统一管理评分规则**: 所有扣分规则集中管理
- **品牌评分模型**: 洪潮+马己仙差异化评分
- **计算最终绩效**: 基于异常数据和执行质量
- **生成绩效报告**: 周考核+月度报告
- **管理品牌模型**: 评分模型配置和权重

### 📊 统一扣分规则

| 异常类型 | 责任角色 | 高扣分 | 中扣分 | 低扣分 | 维度 |
|---------|----------|--------|--------|--------|------|
| 实收营收异常 | store_manager | 5分 | 3分 | 1分 | 成本控制 |
| 人效值异常 | store_manager | 5分 | 3分 | 1分 | 成本控制 |
| 充值异常 | store_manager | 5分 | 3分 | 1分 | 成本控制 |
| 桌访异常 | store_production_manager | 5分 | 3分 | 1分 | 质量得分 |
| 桌访占比异常 | store_manager | 5分 | 3分 | 1分 | 质量得分 |
| 总实收毛利率异常 | store_production_manager | 5分 | 3分 | 1分 | 成本控制 |
| 产品差评异常 | store_production_manager | 5分 | 3分 | 1分 | 质量得分 |
| 服务差评异常 | store_manager | 5分 | 3分 | 1分 | 质量得分 |

### 🖼️ 图片审核扣分规则

| 审核结果 | 扣分 | 描述 | 维度 | 责任角色 |
|---------|------|------|------|----------|
| fail | 3分 | 图片审核失败 | 响应速度 | store_manager |
| duplicate | 7分 | 重复图片（作弊） | 响应速度 | store_manager |

### 🎯 品牌评分模型

#### 洪潮品牌
- **质量得分(40%)**: 桌访异常+差评异常，每项扣8分
- **成本控制(30%)**: 营收异常+毛利率异常，每项扣10分  
- **响应速度(30%)**: 图片审核失败，每次扣10分

#### 马己仙品牌
- **出餐效率(40%)**: 差评异常，每项扣10分
- **成本控制(40%)**: 营收异常+毛利率异常，每项扣10分
- **基础执行(20%)**: 审核失败扣8分，重复图片扣15分

### ⏰ 评分周期配置
- **周考核**: 每周一9:00自动计算
- **月考核**: 每月1日9:00自动计算
- **基础分**: 100分
- **评分范围**: 0-200分

---

## 📚 SOP Agent (SOP Agent) - 标准库顾问

### 📋 核心职责
- **知识库检索**: RAG知识检索，支撑判罚依据
- **SOP标准咨询**: 提供操作指导和标准答案
- **品牌差异化支持**: 洪潮vs马己仙的差异化SOP
- **操作指导**: 实时解答员工操作疑问

### 🗂️ 知识库配置
- **默认限制**: 5条结果
- **最大限制**: 20条结果
- **搜索字段**: title, content, tags
- **品牌过滤**: 启用品牌差异化

### 🏪 品牌差异化配置

| 品牌 | SOP要点 | 特色要求 |
|------|---------|----------|
| **洪潮** | 传统潮汕菜工艺标准、海鲜食材处理规范、古法烹饪技术要求、传统服务礼仪 | 传承传统工艺 |
| **马己仙** | 广东小馆出品标准、粤菜基础工艺要求、现代服务流程、成本控制规范 | 现代化管理 |

### ⚙️ 响应配置
- **最大令牌**: 800
- **温度参数**: 0.05 (稳定输出)
- **响应格式**: 结构化
- **语言风格**: 专业

---

## ⚖️ Appeal Agent (REF Agent) - 申诉处理员

### 📋 核心职责
- **申诉处理**: 处理员工申诉请求
- **证据核实**: 验证申诉证据真实性
- **人工仲裁**: 复杂情况的人工介入
- **结果反馈**: 申诉结果通知和记录

### ⚖️ 申诉处理配置
- **响应SLA**: 24小时内响应
- **审核要求**: 必须人工审核
- **自动批准**: 禁用自动批准
- **升级阈值**: 3次申诉后升级

### 📋 仲裁规则配置

| 申诉理由 | 有效理由 | 必需证据 |
|---------|----------|----------|
| 数据错误 | ✅ | 系统截图、数据报告 |
| 系统误判 | ✅ | 操作记录、现场照片 |
| 外部因素 | ✅ | 证明文件、第三方说明 |
| 特殊情况 | ✅ | 情况说明、相关证明 |

### ⚙️ 执行配置
- **最大申诉时长**: 7天
- **通知启用**: 是
- **报告生成**: 是

---

## 🎛️ Master Agent (Master Agent) - 调度中枢

### 📋 核心职责
- **消息路由**: Agent间消息路由和分发
- **任务状态流转**: 状态机管理任务生命周期
- **全局上下文管理**: 维护系统全局状态
- **Agent协调调度**: 协调各Agent工作

### 🔄 状态流转配置

| 当前状态 | 可转下一状态 | 处理Agent | 说明 |
|---------|-------------|-----------|------|
| pending_audit | auditing | data_auditor | 待审计 |
| auditing | pending_dispatch/closed | data_auditor | 审计中 |
| pending_dispatch | dispatched | master | 待派发 |
| dispatched | pending_response | ops_supervisor | 已派发 |
| pending_response | pending_review | master | 待响应 |
| pending_review | resolved/rejected | ops_supervisor | 待审核 |
| resolved | pending_settlement | master | 已解决 |
| rejected | pending_dispatch | master | 已拒绝 |
| pending_settlement | settled | chief_evaluator | 待结算 |
| settled | closed | master | 已结算 |
| closed | - | - | 已关闭 |

### 🎯 责任人映射配置

| 问题类型 | 责任角色 | 说明 |
|---------|----------|------|
| 厨房/出品问题 | store_production_manager | 出品经理负责 |
| 前厅/服务问题 | store_manager | 店长负责 |
| 财务/成本问题 | store_manager | 店长负责 |
| 安全/卫生问题 | store_manager | 店长负责 |
| 设备/维护问题 | store_manager | 店长负责 |

### ⚙️ 执行配置
- **轮询间隔**: 30秒
- **最大并发任务**: 100个
- **任务超时**: 24小时
- **重试次数**: 3次

---

## 📊 系统集成状态

### 🔄 Agent协作流程
1. **Data Auditor** 发现异常 → 创建任务
2. **Master Agent** 路由任务 → 派发给责任人
3. **Ops Agent** 执行任务 → 飞书通知+审核
4. **责任人** 在飞书回复 → 提供证据/说明
5. **Ops Agent** 审核反馈 → 质量检查
6. **Chief Evaluator** 计算绩效 → 扣分/评分
7. **Appeal Agent** 处理申诉 → 仲裁核实
8. **Master Agent** 最终通知 → 任务关闭

### 📈 监控指标
- **异常检测率**: Data Auditor每30分钟扫描
- **任务完成率**: Ops Agent实时监控
- **评分准确率**: Chief Evaluator每周校准
- **申诉处理率**: Appeal Agent 24小时SLA
- **系统响应时间**: Master Agent 30秒轮询

### 🗄️ 数据库表结构
- **master_tasks**: 任务状态管理
- **master_events**: 事件审计日志
- **agent_messages**: Agent通信记录
- **agent_issues**: 异常问题记录
- **bitable_submissions**: 飞书表格数据

---

## 🚀 系统特性

### ✨ 核心优势
- **飞书优先架构**: 统一交互通道，用户体验一致
- **多Agent协作**: 专业化分工，高效处理
- **实时数据同步**: 5个飞书表格实时对接
- **智能异常检测**: 8种异常类型自动识别
- **差异化评分**: 洪潮vs马己仙品牌模型
- **闭环申诉机制**: 完整的申诉处理流程

### 🔧 技术特点
- **事件驱动架构**: 异步处理，高并发
- **状态机管理**: 任务状态清晰可控
- **反作弊机制**: 图片去重、时间验证
- **知识库RAG**: 智能检索，精准回答
- **统一配置管理**: 集中化配置，易于维护

---

**更新时间**: 2026年2月21日  
**系统版本**: HRMS v2.0  
**Agent数量**: 6个  
**数据源**: 9个  
**异常类型**: 8种  
**品牌模型**: 2个
