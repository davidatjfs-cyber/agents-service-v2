# HRMS 核心Agent最新信息

## 📊 Data Auditor (BI Agent) - 数据审计员

### 🎯 核心职责
- **统一管理所有数据源**: 9个数据源实时监控
- **异常检测和分类**: 8种异常类型，High/Medium/Low分级
- **责任认定**: store_manager(6项) + store_production_manager(2项)
- **不负责评分**: 只检测，不计算扣分

### 🗂️ 数据源配置 (9个)

| 配置Key | 数据源 | App ID | Table ID | 轮询间隔 | 状态 |
|---------|--------|--------|----------|----------|------|
| ops_checklist | 运营检查表 | cli_a91dae9f9578dcb1 | tblxHI9ZAKONOTpp | 1分钟 | ✅ |
| table_visit | 桌访表 | cli_a9fc0d13c838dcd6 | tblpx5Efqc6eHo3L | 5分钟 | ✅ |
| closing_reports | 收档报告DB | cli_a9fc0d13c838dcd6 | tblXYfSBRrgNGohN | 5分钟 | ✅ 新增 |
| opening_reports | 开档报告 | cli_a9fc0d13c838dcd6 | tbl32E6d0CyvLvfi | 5分钟 | ✅ 新增 |
| meeting_reports | 例会报告 | cli_a9fc0d13c838dcd6 | tblZXgaU0LpSye2m | 5分钟 | ✅ 新增 |
| material_majixian | 马己仙原料收货日报 | cli_a9fc0d13c838dcd6 | tblz4kW1cY22XRlL | 5分钟 | ✅ 新增 |
| material_hongchao | 洪潮原料收货日报 | cli_a9fc0d13c838dcd6 | tbllcV1evqTJyzlN | 5分钟 | ✅ 新增 |
| daily_reports | 营业日报 | database | daily_reports表 | 5分钟 | ✅ |
| negative_reviews | 差评记录 | database | negative_reviews表 | 5分钟 | ✅ |

### ⚠️ 异常检测规则 (8种)

| 异常类型 | 检测逻辑 | 阈值 | 责任角色 | 维度 |
|---------|----------|------|----------|------|
| 实收营收异常 | 周达成率 vs 理论达成率 | High:20%, Medium:10% | store_manager | 成本控制 |
| 人效值异常 | 实际人效 vs 品牌标准 | 洪潮:1200/1000, 马己仙:1300/1300 | store_manager | 成本控制 |
| 充值异常 | 连续无充值记录 | 0元, 连续2天 | store_manager | 成本控制 |
| 桌访异常 | 产品投诉次数 | High:4次, Medium:2次 | store_production_manager | 质量得分 |
| 桌访占比异常 | 桌访率 vs 标准 | High:40%, Medium:50% | store_manager | 质量得分 |
| 总实收毛利率异常 | 实际毛利率 vs 标准 | 洪潮:70%/69%, 马己仙:65%/64% | store_production_manager | 成本控制 |
| 产品差评异常 | 产品差评次数 | High:3次, Medium:1次 | store_production_manager | 质量得分 |
| 服务差评异常 | 服务差评次数 | High:2次, Medium:1次 | store_manager | 质量得分 |

### ⚙️ 执行配置
- **检测周期**: 每30分钟
- **数据同步**: 实时轮询Bitable + Database
- **质量检查**: 自动检查数据源质量
- **问题报告**: 通过AgentCommunicationSystem报告问题

### 📋 关键函数
- `runDataAuditor()`: 主检测函数
- `checkDataSourceQuality()`: 数据源质量检查
- `loadTableVisitMetricsByStore()`: 桌访数据加载
- `pollAllBitableSubmissions()`: Bitable数据同步
- `getBitableRecords()`: 获取表格记录
- `processBitableData()`: 数据处理

---

## 👥 Ops Agent (OP Agent) - 营运督导员

### 🎯 核心职责
- **任务派发和跟踪**: 通过飞书通知责任人
- **执行质量监督**: 检查任务完成质量
- **图片审核**: 4种类型审核
- **结果反馈给OKR**: 提供执行质量数据
- **不负责评分**: 只审核，不扣分

### 📝 任务模板配置 (3种)

| 任务类型 | 洪潮检查项 (8项) | 马己仙检查项 (5项) | 执行时间 |
|---------|------------------|-------------------|----------|
| **开市检查** | 地面清洁无积水、所有设备正常开启、食材新鲜度检查、餐具消毒完成、灯光亮度适中、背景音乐开启、空调温度设置合适、员工仪容仪表检查 | 地面清洁、设备开启、食材准备、餐具消毒、迎宾准备 | 10:30 |
| **收档检查** | 食材封存、设备关闭、垃圾清理、安全检查、门窗锁好 | 食材封存、设备关闭、垃圾清理、安全检查、门窗锁好、电源关闭 | 22:30 |
| **巡检检查** | 大厅环境整洁、服务台规范、卫生间清洁、后厨卫生、安全设施 | 同左 | 用户触发 |

### 🖼️ 图片审核能力 (4种)

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

### 📋 关键函数
- `auditImage()`: 图片审核主函数
- `handleOpsMessage()`: 消息处理
- `startScheduledTasks()`: 定时任务启动
- `checkTaskExecutionQuality()`: 执行质量检查
- `sendTaskReminder()`: 任务提醒

---

## 🏆 Chief Evaluator (OKR Agent) - 绩效考核官

### 🎯 核心职责
- **统一管理评分规则**: 所有扣分规则集中管理
- **品牌评分模型**: 洪潮+马己仙差异化评分
- **计算最终绩效**: 基于异常数据和执行质量
- **生成绩效报告**: 周考核+月度报告
- **管理品牌模型**: 评分模型配置和权重

### 📊 统一扣分规则 (8种)

| 异常类型 | 责任角色 | 高扣分 | 中扣分 | 低扣分 | 维度 | 描述 |
|---------|----------|--------|--------|--------|------|------|
| 实收营收异常 | store_manager | 5分 | 3分 | 1分 | 成本控制 | 营收达成率偏低 |
| 人效值异常 | store_manager | 5分 | 3分 | 1分 | 成本控制 | 人效率不达标 |
| 充值异常 | store_manager | 5分 | 3分 | 1分 | 成本控制 | 无充值记录 |
| 桌访异常 | store_production_manager | 5分 | 3分 | 1分 | 质量得分 | 产品投诉过多 |
| 桌访占比异常 | store_manager | 5分 | 3分 | 1分 | 质量得分 | 桌访率偏低 |
| 总实收毛利率异常 | store_production_manager | 5分 | 3分 | 1分 | 成本控制 | 毛利率不达标 |
| 产品差评异常 | store_production_manager | 5分 | 3分 | 1分 | 质量得分 | 产品质量差评 |
| 服务差评异常 | store_manager | 5分 | 3分 | 1分 | 质量得分 | 服务质量差评 |

### 🖼️ 图片审核扣分规则 (2种)

| 审核结果 | 扣分 | 描述 | 维度 | 责任角色 |
|---------|------|------|------|----------|
| fail | 3分 | 图片审核失败 | 响应速度 | store_manager |
| duplicate | 7分 | 重复图片（作弊） | 响应速度 | store_manager |

### 🎯 品牌评分模型 (2个)

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

### 📋 关键函数
- `runChiefEvaluator()`: 主评分函数
- `getDeductScore()`: 扣分计算
- `getVisualAuditDeduct()`: 图片审核扣分
- `calculateBrandScore()`: 品牌分数计算
- `pushScoresToFeishu()`: 飞书推送

---

## 📈 最新更新状态

### ✅ 2026年2月21日更新内容

#### Data Auditor (BI)
- ✅ **新增5个数据源**: 收档报告、开档报告、例会报告、马己仙原料收货、洪潮原料收货
- ✅ **数据源总数**: 从4个增加到9个
- ✅ **权限修复**: 所有表格已开通编辑权限
- ✅ **实时同步**: 5分钟轮询间隔

#### Ops Agent (OP)
- ✅ **任务模板优化**: 洪潮8项检查，马己仙5项检查
- ✅ **图片审核增强**: 4种专业审核类型
- ✅ **反作弊升级**: SHA256去重+Exif验证
- ✅ **质量监控**: 失败率>15%自动报告

#### Chief Evaluator (OKR)
- ✅ **统一扣分规则**: 8种异常类型标准化
- ✅ **品牌差异化**: 洪潮vs马己仙评分模型
- ✅ **自动化计算**: 周月度自动评分
- ✅ **飞书集成**: 评分结果自动推送

### 🔧 技术架构
- **配置文件**: `agent-config-manager.js` 统一管理
- **评分配置**: `chief-evaluator-config.js` 集中配置
- **主文件**: `agents.js` 核心实现
- **调度系统**: `master-agent.js` 任务路由

### 📊 系统指标
- **Agent总数**: 6个 (BI + OP + OKR + SOP + REF + Master)
- **数据源总数**: 9个 (7个Bitable + 2个Database)
- **异常类型**: 8种
- **品牌模型**: 2个
- **任务模板**: 3种
- **审核类型**: 4种

---

**更新时间**: 2026年2月21日 17:20  
**系统版本**: HRMS v2.0  
**状态**: ✅ 所有功能正常运行
