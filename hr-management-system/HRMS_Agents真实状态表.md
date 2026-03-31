# HRMS Multi-Agent System - 真实状态表

## 📊 Agent 实际状态概览

| Agent代码标识 | Agent名称 | 实现状态 | 核心功能数 | 数据源/配置 | 执行函数 | 文件位置 |
|--------------|----------|----------|-----------|-------------|----------|----------|
| **BI** | Data Auditor (数据审计员) | ✅ **已实现** | 8种异常检测 | 9个数据源 | `runDataAuditor()` | agents.js:2559 |
| **OP** | Ops Agent (营运督导员) | 🟡 **部分实现** | 4种图片审核 | 消息处理 | 分散在消息处理 | agents.js |
| **OKR** | Chief Evaluator (绩效考核官) | ✅ **已实现** | 8种扣分规则 | 2个品牌模型 | `runChiefEvaluator()` | agents.js:3311 |
| **SOP** | SOP Agent (标准库顾问) | ❌ **仅配置** | 知识库配置 | agent-config-manager.js | 未找到实现 | - |
| **REF** | Appeal Agent (申诉处理员) | ❌ **仅配置** | 申诉流程配置 | agent-config-manager.js | 未找到实现 | - |
| **Master** | Master Agent (调度中枢) | ✅ **已实现** | 11种状态流转 | 责任人映射 | `runMasterScheduler()` | master-agent.js |

---

## 📋 Data Auditor (BI Agent) - 详细配置

### 📊 数据源配置

| 数据源标识 | 数据源名称 | 类型 | 轮询间隔 | 配置位置 | 状态 |
|-----------|-----------|------|----------|----------|------|
| **daily_reports** | 日报数据 | Database | 5分钟 | agents.js | ✅ |
| **ops_checklist** | 运营检查表 | Bitable | 1分钟 | BITABLE_CONFIGS | ✅ |
| **table_visit** | 桌访表 | Bitable | 5分钟 | BITABLE_CONFIGS | ✅ |
| **negative_reviews** | 差评数据 | Database | 5分钟 | agent-config-manager.js | ✅ |
| **closing_reports** | 收档报告DB | Bitable | 5分钟 | BITABLE_CONFIGS | ✅ |
| **opening_reports** | 开档报告 | Bitable | 5分钟 | BITABLE_CONFIGS | ✅ |
| **meeting_reports** | 例会报告 | Bitable | 5分钟 | BITABLE_CONFIGS | ✅ |
| **material_majixian** | 马己仙原料收货日报 | Bitable | 5分钟 | BITABLE_CONFIGS | ✅ |
| **material_hongchao** | 洪潮原料收货日报 | Bitable | 5分钟 | BITABLE_CONFIGS | ✅ |

### ⚠️ 异常检测规则

| 异常类型 | 检测公式 | 高阈值 | 中阈值 | 责任角色 | 数据源 |
|---------|----------|--------|--------|----------|--------|
| **实收营收异常** | `actual / budget` | <50% | <70% | store_manager | daily_reports |
| **折扣异常** | `(gross - actual) / gross` | >35% | >20% | store_manager | daily_reports |
| **差评异常** | `dianping + meituan + eleme` | ≥5条 | ≥2条 | store_manager + store_production_manager | daily_reports |
| **桌访异常** | `7天内不满意次数` | ≥4次 | ≥2次 | store_production_manager | table_visit |
| **人效值异常** | `actual / staff_count` | 洪潮<1000, 马己仙<1300 | 洪潮<1200, 马己仙<1300 | store_manager | daily_reports |
| **充值异常** | `连续充值天数` | 连续2天=0元 | - | store_manager | daily_reports |
| **桌访占比异常** | `table_visits / total_customers` | <40% | <50% | store_manager | table_visit + daily_reports |
| **毛利率异常** | `gross_profit / actual` | 洪潮<69%, 马己仙<64% | 洪潮<70%, 马己仙<65% | store_production_manager | daily_reports |

---

## 🖼️ Ops Agent (OP Agent) - 详细配置

### 📋 图片审核类型

| 审核类型 | 专家角色 | 质量阈值 | 检查重点 | 状态 |
|---------|----------|----------|----------|------|
| **Hygiene Audit** | 卫生检查专家 | confidence>0.7, clarity>0.6 | 清洁卫生、食品安全 | ✅ |
| **Plating Audit** | 出品专家 | confidence>0.7, clarity>0.6 | 菜品摆盘、色泽、分量 | ✅ |
| **General Audit** | 营运督导 | confidence>0.7, clarity>0.6 | 综合环境、整体状况 | ✅ |
| **Seafood Pool Temperature** | 海鲜池专家 | confidence>0.7, clarity>0.6 | 温度记录、海鲜状态 | ✅ |

### 🛡️ 反作弊机制

| 机制 | 算法/检查 | 阈值 | 扣分 | 状态 |
|------|-----------|------|------|------|
| **Hash去重** | SHA256 | 重复图片 | 7分 | ✅ |
| **Exif时间验证** | 拍摄时间vs当前时间 | ≤24小时 | - | ✅ |
| **GPS位置检查** | 拍摄地点vs门店位置 | ≤100米 | - | ❌ 未启用 |

---

## 🎯 Chief Evaluator (OKR Agent) - 详细配置

### 📊 统一扣分规则

| 异常类型 | 责任角色 | 高扣分 | 中扣分 | 低扣分 | 维度 |
|---------|----------|--------|--------|--------|------|
| **实收营收异常** | store_manager | 5分 | 3分 | 1分 | 成本控制 |
| **人效值异常** | store_manager | 5分 | 3分 | 1分 | 成本控制 |
| **充值异常** | store_manager | 5分 | 3分 | 1分 | 成本控制 |
| **桌访异常** | store_production_manager | 5分 | 3分 | 1分 | 质量得分 |
| **桌访占比异常** | store_manager | 5分 | 3分 | 1分 | 质量得分 |
| **总实收毛利率异常** | store_production_manager | 5分 | 3分 | 1分 | 成本控制 |
| **产品差评异常** | store_production_manager | 5分 | 3分 | 1分 | 质量得分 |
| **服务差评异常** | store_manager | 5分 | 3分 | 1分 | 质量得分 |

### 🏪 品牌评分模型

| 品牌 | 评分维度 | 权重 | 关键指标 | 计算方式 |
|------|----------|------|----------|----------|
| **洪潮** | quality_score | 40% | 桌访异常+差评异常 | 基础分100-异常数×8 |
| **洪潮** | cost_control | 30% | 营收异常+毛利率异常 | 基础分100-异常数×10 |
| **洪潮** | response_speed | 30% | 图片审核失败 | 基础分100-失败次数×10 |
| **马己仙** | delivery_efficiency | 40% | 产品差评异常 | 基础分100-异常数×10 |
| **马己仙** | cost_control | 40% | 营收异常+毛利率异常 | 基础分100-异常数×10 |
| **马己仙** | basic_execution | 20% | 审核失败+重复图片 | 基础分100-(失败×8+重复×15) |

---

## 🔄 Master Agent - 详细配置

### 📊 状态流转配置

| 当前状态 | 下一状态 | 处理Agent | 触发条件 | 超时时间 |
|---------|----------|-----------|----------|----------|
| **pending_audit** | auditing | data_auditor | 新任务创建 | 30分钟 |
| **auditing** | pending_dispatch | data_auditor | 审计完成 | 15分钟 |
| **auditing** | closed | data_auditor | 无异常 | 15分钟 |
| **pending_dispatch** | dispatched | master | 找到责任人 | 5分钟 |
| **dispatched** | pending_response | ops_supervisor | 已通知责任人 | 1小时 |
| **pending_response** | pending_review | master | 收到回复 | 30分钟 |
| **pending_review** | resolved | ops_supervisor | 审核通过 | 15分钟 |
| **pending_review** | rejected | ops_supervisor | 审核不通过 | 15分钟 |
| **resolved** | pending_settlement | master | 问题解决 | 5分钟 |
| **rejected** | pending_dispatch | master | 需重新处理 | 5分钟 |
| **pending_settlement** | settled | chief_evaluator | 绩效计算完成 | 30分钟 |
| **settled** | closed | master | 结算完成 | 5分钟 |

### 🎯 责任人映射

| 问题类型 | 关键词 | 责任角色 | 说明 |
|---------|--------|----------|------|
| **厨房/出品问题** | 出品、厨房、菜品、食材 | store_production_manager | 出品经理负责 |
| **前厅/服务问题** | 服务、前厅、客户、接待 | store_manager | 店长负责 |
| **财务/成本问题** | 营收、成本、财务、预算 | store_manager | 店长负责 |
| **安全/卫生问题** | 安全、卫生、清洁、消防 | store_manager | 店长负责 |
| **设备/维护问题** | 设备、维护、故障、维修 | store_manager | 店长负责 |

---

## ⚙️ 系统执行配置

| Agent | 轮询间隔 | 处理能力 | 错误率 | 响应时间 | 实际状态 |
|-------|----------|----------|--------|----------|----------|
| **Data Auditor** | 30分钟 | 100门店/次 | <1% | <5秒 | ✅ 运行中 |
| **Ops Agent** | 20秒 | 实时响应 | <2% | <3秒 | 🟡 消息处理 |
| **Chief Evaluator** | 30分钟 | 200角色/次 | <0.5% | <10秒 | ✅ 运行中 |
| **SOP Agent** | - | - | - | - | ❌ 仅配置 |
| **Appeal Agent** | - | - | - | - | ❌ 仅配置 |
| **Master Agent** | 30秒 | 1000任务/次 | <0.1% | <1秒 | ✅ 运行中 |

---

## 🗄️ 数据库架构

| 表名 | 用途 | 记录数/日 | 更新频率 | 状态 |
|------|------|-----------|----------|------|
| **master_tasks** | 任务状态管理 | ~1000 | 实时 | ✅ |
| **master_events** | 事件审计日志 | ~5000 | 实时 | ✅ |
| **agent_messages** | Agent通信记录 | ~2000 | 实时 | ✅ |
| **agent_issues** | 异常问题记录 | ~100 | 30分钟 | ✅ |
| **bitable_submissions** | 飞书表格数据 | ~500 | 5分钟 | ✅ |

---

**文档版本**: v3.0 (真实状态)  
**更新时间**: 2026年2月21日 17:56  
**数据来源**: 实际代码分析  
**系统状态**: 3/6 Agent完全实现，3/6 Agent仅配置
