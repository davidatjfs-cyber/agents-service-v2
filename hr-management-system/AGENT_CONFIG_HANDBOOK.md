# HRMS 6个Agent完整配置手册

> 版本: 2026-02-21 最新版
> 用途: 供用户调整各Agent具体内容

---

## 一、Agent总览表

| 序号 | Agent名称 | 飞书前缀 | 路由标识 | 职责 | 来源文件 |
|------|-----------|----------|----------|------|----------|
| 1 | Master Agent (调度中枢) | Master | master | 任务路由、状态流转、全局管理 | `master-agent.js` |
| 2 | BI Agent (数据审计员) | BI | data_auditor | 异常检测、数据核对 | `agents.js` |
| 3 | OP Agent (营运督导员) | OP | ops_supervisor | 图片审核、飞书任务分派 | `agents.js` |
| 4 | HR Agent (HR专员) | HR | chief_evaluator | 绩效评分、人事管理 | `agents.js` + `new-scoring-model.js` |
| 5 | SOP Agent (SOP顾问) | SOP | sop_advisor | RAG知识检索、SOP咨询 | `agents.js` |
| 6 | Appeal Agent (申诉处理员) | REF | appeal | 申诉处理、仲裁 | `agents.js` |

---

## 二、路由关键词配置

| Agent | 路由标识 | 触发关键词 | 来源文件 | 代码位置 |
|-------|----------|------------|----------|----------|
| BI | data_auditor | '损耗', '盘点', '毛利', '牛肉', '成本', '差评', '折扣', '营收', '对账', '异常' | `agents.js` | 第3391行 |
| OP | ops_supervisor | '图片', '卫生', '检查', '拍照', '摆盘', '收货', '消毒', '开市', '闭市', '巡检' | `agents.js` | 第3392行 |
| HR | chief_evaluator | '分数', '绩效', '考核', '奖金', '得分', '扣分', '排名', '评价', '这周' | `agents.js` | 第3393行 |
| Appeal | appeal | '申诉', '取消扣分', '不公平', '误判', '恢复' | `agents.js` | 第3394行 |
| SOP | sop_advisor | '标准', '流程', 'SOP', '规范', '手册', '赔付', '退款', '怎么办', '怎么处理' | `agents.js` | 第3395行 |

---

## 三、Agent前缀映射表

| 路由标识 | 前缀 | 中文名 | 代码位置 |
|----------|------|--------|----------|
| data_auditor | BI | 数据审计员 | `agents.js:3399` |
| ops_supervisor | OP | 营运督导员 | `agents.js:3400` |
| chief_evaluator | HR | HR专员 | `agents.js:3401` |
| sop_advisor | SOP | 标准库顾问 | `agents.js:3402` |
| appeal | REF | 申诉处理员 | `agents.js:3403` |
| master | Master | 调度中枢 | `agents.js:3404` |
| general | HRMS | 通用 | `agents.js:3405` |

---

## 四、Master Agent (调度中枢) 详细配置

### 4.1 来源文件
- **主文件**: `server/master-agent.js`
- **导出函数**: `ensureMasterTables()`, `startMasterAgent()`, `stopMasterAgent()`

### 4.2 责任人角色映射表 (CATEGORY_ASSIGNEE_ROLE)

| 异常类型 | 责任人角色 | 来源文件位置 |
|----------|------------|--------------|
| 桌访异常 | store_production_manager (出品经理) | `master-agent.js:65` |
| 桌访连续投诉 | store_production_manager (出品经理) | `master-agent.js:66` |
| 桌访占比异常 | store_manager (店长) | `master-agent.js:67` |
| 实收营收异常 | store_manager (店长) | `master-agent.js:68` |
| 人效值异常 | store_manager (店长) | `master-agent.js:69` |
| 充值异常 | store_manager (店长) | `master-agent.js:70` |
| 总实收毛利率异常 | store_production_manager (出品经理) | `master-agent.js:71` |
| 产品差评异常 | store_production_manager (出品经理) | `master-agent.js:72` |
| 服务差评异常 | store_manager (店长) | `master-agent.js:73` |
| 图片审核不合格 | store_production_manager (出品经理) | `master-agent.js:74` |

### 4.3 状态机流转表 (STATUS_FLOW)

| 当前状态 | 可流转到 | 负责Agent | 代码位置 |
|----------|----------|-----------|----------|
| pending_audit | auditing | data_auditor | `master-agent.js:79` |
| auditing | pending_dispatch, closed | data_auditor | `master-agent.js:80` |
| pending_dispatch | dispatched | master | `master-agent.js:81` |
| dispatched | pending_response | ops_supervisor | `master-agent.js:82` |
| pending_response | pending_review | master | `master-agent.js:83` |
| pending_review | resolved, rejected | ops_supervisor | `master-agent.js:84` |
| resolved | pending_settlement | master | `master-agent.js:85` |
| rejected | pending_dispatch | master | `master-agent.js:86` |
| pending_settlement | settled | chief_evaluator | `master-agent.js:87` |
| settled | closed | master | `master-agent.js:88` |
| closed | (无) | null | `master-agent.js:89` |

### 4.4 监听器配置表

| 监听器名称 | 执行间隔 | 功能 | 代码位置 |
|------------|----------|------|----------|
| dataAuditorListener | 30分钟 | Data Auditor主动扫描异常 | `master-agent.js:345` |
| masterIssuesListener | 随任务触发 | 处理Agent报告的问题 | `master-agent.js:395` |
| masterOptimizationCoordinator | 随任务触发 | 协调Agent优化方案 | `master-agent.js:423` |
| masterDispatcher | 15秒 | 扫描pending_dispatch任务 | `master-agent.js:457` |
| opsAgentListener | 20秒 | 发送飞书通知+审核反馈 | `master-agent.js:491` |
| evaluatorListener | 30秒 | 绩效结算 | `master-agent.js:687` |
| finalNotificationListener | 30秒 | 最终通知 | `master-agent.js:733` |

### 4.5 数据库表结构

| 表名 | 用途 | 代码位置 |
|------|------|----------|
| master_tasks | 任务全生命周期管理 | `master-agent.js:111` |
| master_events | 状态流转审计轨迹 | `master-agent.js:147` |
| sop_cases | SOP案例分析 | `master-agent.js:168` |

---

## 五、BI Agent (数据审计员) 详细配置

### 5.1 来源文件
- **主文件**: `server/agents.js`
- **核心函数**: `runDataAuditor()`

### 5.2 异常检测规则表

| 序号 | 异常类型 | 检测逻辑 | 责任人 | 严重程度判断 | 代码位置 |
|------|----------|----------|--------|--------------|----------|
| 1 | 实收营收异常 | 达成率低于理论值 (gap > 10% medium, > 20% high) | store_manager | gap>20%:high, >10%:medium | `agents.js:2608` |
| 2 | 人效值异常 | 洪潮:<1000 high,<1200 medium; 马己仙:<1300 medium/high | store_manager | 品牌差异化阈值 | `agents.js:2628` |
| 3 | 充值异常 | 连续2天无充值记录 | store_manager | 有/无 | `agents.js:2655` |
| 4 | 桌访异常 | 产品投诉过多 | store_production_manager | 数量阈值 | `agents.js:2701` |
| 5 | 桌访占比异常 | 桌访率低于标准 | store_manager | 比率阈值 | `agents.js:2725` |
| 6 | 总实收毛利率异常 | 毛利率不达标 | store_production_manager | 偏差阈值 | `agents.js:2750` |
| 7 | 产品差评异常 | 产品质量差评 | store_production_manager | 数量阈值 | `agents.js:2780` |
| 8 | 服务差评异常 | 服务质量差评 | store_manager | 数量阈值 | `agents.js:2800` |

### 5.3 Bitable数据源配置表

| 配置名称 | App ID | App Secret | App Token | Table ID | 轮询间隔 | 代码位置 |
|----------|--------|------------|-----------|----------|----------|----------|
| ops_checklist | cli_a91dae9f9578dcb1 | sjpAzPwu4KixvhbAOD7w4ee1oEKRRBQF | PtVObRtoPaMAP3stIIFc8DnJngd | tblxHI9ZAKONOTpp | 60秒 | `agents.js:62` |
| table_visit | cli_a9fc0d13c838dcd6 | pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN | PTWrbUdcbarCshst0QncMoY7nKe | tblpx5Efqc6eHo3L | 300秒 | `agents.js:71` |
| closing_reports | cli_a9fc0d13c838dcd6 | pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN | PTWrbUdcbarCshst0QncMoY7nKe | tblXYfSBRrgNGohN | 300秒 | `agents.js:81` |
| opening_reports | cli_a9fc0d13c838dcd6 | pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN | PTWrbUdcbarCshst0QncMoY7nKe | tbl32E6d0CyvLvfi | 300秒 | `agents.js:90` |
| meeting_reports | cli_a9fc0d13c838dcd6 | pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN | PTWrbUdcbarCshst0QncMoY7nKe | tblH8Yf7bY9u2Mvb | 300秒 | `agents.js:99` |

### 5.4 BI Agent回复模版表

| 场景 | 模版内容 | 变量 | 代码位置 |
|------|----------|------|----------|
| 有异常时 | `${senderName}，${store}门店当前有 ${issues.length} 条未解决的审计异常：\n\n${list}\n\n请针对以上问题逐条排查并回复整改措施。` | senderName, store, issues, list | `agents.js:3462` |
| 无异常时 | `${store}门店近期数据审计正常，暂无异常项。继续保持！👍` | store | `agents.js:3467` |
| 刚完成审计 | `刚完成数据审计，发现 ${result.issuesCreated} 条新异常，稍后推送给你。` | result.issuesCreated | `agents.js:3466` |

---

## 六、OP Agent (营运督导员) 详细配置

### 6.1 来源文件
- **主文件**: `server/agents.js`
- **配置对象**: `OPS_AGENT_CONFIG`
- **核心函数**: `auditImage()`, `scheduleOpsTasks()`, `checkDataTriggers()`

### 6.2 开/收市巡检配置表 (dailyInspections)

| 品牌 | 类型 | 时间 | 检查项目 | 代码位置 |
|------|------|------|----------|----------|
| 洪潮 | opening | 10:30 | ['地面清洁无积水', '所有设备正常开启', '食材新鲜度检查', '餐具消毒完成', '灯光亮度适中', '背景音乐开启', '空调温度设置合适', '员工仪容仪表检查'] | `agents.js:2892` |
| 马己仙 | opening | 10:00 | ['地面清洁', '设备开启', '食材准备', '餐具消毒', '迎宾准备'] | `agents.js:2893` |
| 洪潮 | closing | 22:00 | ['食材封存', '设备关闭', '垃圾清理', '安全检查', '门窗锁好'] | `agents.js:2894` |
| 马己仙 | closing | 22:30 | ['食材封存', '设备关闭', '垃圾清理', '安全检查', '门窗锁好', '电源关闭'] | `agents.js:2895` |

### 6.3 食安抽检配置表 (randomInspections)

| 抽检类型 | 描述 | 时间窗口(分钟) | 代码位置 |
|----------|------|----------------|----------|
| seafood_pool_temperature | 拍摄海鲜池水温计照片 | 15 | `agents.js:2899` |
| fridge_label_check | 检查冰箱标签是否过期 | 10 | `agents.js:2900` |
| hand_washing_duration | 录制洗手20秒视频 | 5 | `agents.js:2901` |

### 6.4 数据联动触发阈值表 (dataTriggers)

| 阈值名称 | 数值 | 用途 | 代码位置 |
|----------|------|------|----------|
| productComplaintThreshold | 2 | 同一产品连续投诉阈值 | `agents.js:2905` |
| marginDeviationThreshold | 0.05 | 毛利偏差阈值 | `agents.js:2906` |
| tableVisitRatioThreshold | 0.3 | 桌访率异常阈值 | `agents.js:2907` |

### 6.5 多模态视觉审核标准表 (visualInspection)

| 类别 | 检查项 | 标准值/要求 | 代码位置 |
|------|--------|-------------|----------|
| environment (环境) | floorWater | detect_water_or_oil_on_floor | `agents.js:2915` |
| environment (环境) | trashCovered | trash_bin_lid_closed | `agents.js:2916` |
| environment (环境) | lightingAdequate | lighting_sufficient_for_clear_photos | `agents.js:2917` |
| product (产品) | platingAesthetics | 洪潮切配摆盘美学标准 | `agents.js:2921` |
| product (产品) | portionSize | 分量是否达标 | `agents.js:2922` |
| product (产品) | garnishPlacement | 装饰配菜摆放规范 | `agents.js:2923` |
| materials (物料) | fridgeLabelExpiry | 冰箱标签是否过期 | `agents.js:2927` |
| materials (物料) | rawCookedSeparation | 生熟分装检查 | `agents.js:2928` |
| materials (物料) | storageTemperature | 储存温度合规 | `agents.js:2929` |
| accuracyThresholds | labelClarity | 0.8 (80%) | `agents.js:2933` |
| accuracyThresholds | foodCoverage | 0.9 (90%) | `agents.js:2934` |
| accuracyThresholds | photoQuality | 0.85 (85%) | `agents.js:2935` |

### 6.6 执行闭环追踪配置表 (loopManagement)

| 配置项 | 名称 | 数值(分钟) | 代码位置 |
|--------|------|------------|----------|
| followUpRules | firstReminder | 60 | `agents.js:2943` |
| followUpRules | secondReminder | 90 | `agents.js:2944` |
| followUpRules | escalationDelay | 120 | `agents.js:2945` |
| followUpRules | maxReminders | 3 | `agents.js:2946` |
| logicValidation | photoLocationRadius | 500米 | `agents.js:2950` |
| logicValidation | exifTimeTolerance | 5 | `agents.js:2951` |
| logicValidation | hashDuplicateCheck | true | `agents.js:2952` |
| logicValidation | dataConsistency | true | `agents.js:2953` |

### 6.7 判定逻辑标准表 (judgmentStandards)

| 类别 | 配置项 | 数值 | 代码位置 |
|------|--------|------|----------|
| timeliness | readDeadline | 15分钟 | `agents.js:2960` |
| timeliness | responseDeadline | 60分钟 | `agents.js:2961` |
| timeliness | latePenalty | 'mark_slow_response' | `agents.js:2962` |
| authenticity | locationRadius | 500 | `agents.js:2965` |
| authenticity | exifTolerance | 300秒(5分钟) | `agents.js:2966` |
| authenticity | hashCheck | true | `agents.js:2967` |
| authenticity | fraudAction | 'block_and_report' | `agents.js:2968` |
| visualAccuracy | minClarity | 0.8 | `agents.js:2971` |
| visualAccuracy | minCoverage | 0.9 | `agents.js:2972` |
| visualAccuracy | poorQualityResponse | '环境光线不足，请打开补光灯重拍' | `agents.js:2973` |
| logicConsistency | dataTolerance | 0.1(10%) | `agents.js:2976` |
| logicConsistency | inconsistencyResponse | '检测到数据偏差较大，请核实后再提交' | `agents.js:2977` |

### 6.8 现场知识支援配置表 (knowledgeSupport)

| 类别 | 键 | 值 | 代码位置 |
|------|----|----|----------|
| sopQueryRules | productQuality | '产品质量问题处理流程' | `agents.js:2985` |
| sopQueryRules | ingredientHandling | '食材处理标准' | `agents.js:2986` |
| sopQueryRules | equipmentOperation | '设备操作规范' | `agents.js:2987` |
| sopQueryRules | emergencyProcedures | '紧急情况处理' | `agents.js:2988` |
| standardResponses | smallOysters | '根据洪潮验收SOP第3条，超过20%不达标需拍图留存并做退货登记。请拍摄对比照片。' | `agents.js:2992` |
| standardResponses | fridgeTemperature | '冰箱温度应保持在4°C以下，请检查温控设置并记录当前温度。' | `agents.js:2993` |
| standardResponses | handWashing | '洗手必须满20秒，请使用洗手液并冲洗至手腕部位。' | `agents.js:2994` |

### 6.9 OP Agent回复模版表

| 场景 | 模版内容 | 变量 | 代码位置 |
|------|----------|------|----------|
| 图片-重复 | `⚠️ 检测到重复图片，请重新拍摄并上传。系统已记录此次异常。` | 无 | `agents.js:3485` |
| 图片-通过 | `收到，照片识别合格 ✅\n${summaries}\n已记录整改措施，感谢配合。` | summaries | `agents.js:3488` |
| 图片-未通过 | `照片审核未通过 ❌\n${failFindings}\n请整改后重新拍照上传。` | failFindings | `agents.js:3491` |
| 图片-审核中 | `照片已收到，正在审核中。部分图片无法自动判定，已转交值班经理人工复核。` | 无 | `agents.js:3493` |
| 开市检查表 | `【开市检查表 - ${brand}】\n请逐项检查并拍照反馈：\n${checklist}\n\n完成后请发送各项目检查照片。` | brand, checklist | `agents.js:3507` |
| 收档检查表 | `【收档检查表 - ${brand}】\n请逐项检查并拍照反馈：\n${checklist}\n\n完成后请发送各项目检查照片。` | brand, checklist | `agents.js:3514` |
| 营运巡检 | `【营运巡检要求】\n请检查以下项目并拍照反馈：\n✅ 大厅环境整洁\n✅ 服务台规范\n✅ 卫生间清洁\n✅ 后厨卫生\n✅ 安全设施\n\n请发送各区域检查照片。` | 无 | `agents.js:3516` |
| 知识支援-标准/SOP | `${knowledgeSupport.response}` | knowledgeSupport.response | `agents.js:3526` |
| LLM生成回复 | `你是餐饮营运督导员，当前门店：${store}（${brand}，brand_id=${brandId}）。简洁专业，注重实操。` | store, brand, brandId | `agents.js:3530` |

### 6.10 图片审核Prompt模版表

| 审核类型 | Prompt内容 | 代码位置 |
|----------|------------|----------|
| hygiene | `你是餐饮卫生检查专家。审核这张图片：1.是否为餐厅卫生相关照片 2.卫生状况如何 3.给出pass/fail/unclear。JSON回复：{"result":"pass/fail/unclear","confidence":0.0-1.0,"findings":"具体发现","clarity":0.0-1.0}` | `agents.js:3035` |
| plating | `你是餐饮出品专家。审核这张菜品照片：1.摆盘是否规范 2.分量是否达标 3.美学标准。JSON回复：{"result":"pass/fail/unclear","confidence":0.0-1.0,"findings":"具体发现","clarity":0.0-1.0}` | `agents.js:3036` |
| general | `你是餐饮营运督导。审核这张照片：1.照片类型 2.是否与餐饮营运相关 3.质量评估。JSON回复：{"result":"pass/fail/unclear","confidence":0.0-1.0,"findings":"具体发现","type":"照片类型","clarity":0.0-1.0}` | `agents.js:3037` |
| seafood_pool_temperature | `你是海鲜池管理专家。审核这张水温计照片：1.温度是否清晰可见 2.温度是否在标准范围内(18-22°C) 3.水温计是否正常工作。JSON回复：{"result":"pass/fail/unclear","confidence":0.0-1.0,"findings":"具体发现","temperature":"数值"}` | `agents.js:3038` |

### 6.11 Master中OP通知模版

| 场景 | 模版内容 | 变量 | 代码位置 |
|------|----------|------|----------|
| 异常通知 | `${sev} 异常通知 [${task.task_id}]\n\n${roleLabel}您好，系统检测到以下异常：\n\n📋 ${task.title}\n\n${task.detail}\n\n⚠️ 请解释原因并上传整改措施\n（直接回复文字说明 + 整改照片）` | sev, task, roleLabel | `master-agent.js:510` |

### 6.12 Master中OP审核Prompt

| 场景 | Prompt内容 | 代码位置 |
|------|------------|----------|
| 图片审核 | `你是餐饮营运督导员。请审核这张整改照片，判断是否为真实有效的整改证据。回复JSON：{"valid":true/false,"reason":"判断理由"}` | `master-agent.js:553-555` |
| 文字审核 | `你是餐饮营运督导员。请审核员工对异常问题的回复，判断是否真实且有效。\n异常问题：${task.title}\n问题详情：${task.detail}${sopContext}\n\n请回复JSON：{"valid":true/false,"reason":"判断理由","suggestion":"改进建议（如有）"}` | `master-agent.js:581-588` |

---

## 七、HR Agent (HR专员) 详细配置

### 7.1 来源文件
- **主文件**: `server/agents.js` + `server/new-scoring-model.js`
- **配置对象**: `STORE_RATING_CONFIG`, `EMPLOYEE_SCORE_CONFIG`
- **核心函数**: `runChiefEvaluator()`, `calculateStoreRating()`, `calculateEmployeeScore()`

### 7.2 门店评级模型配置表 (STORE_RATING_CONFIG)

| 配置项 | 值 | 说明 | 代码位置 |
|--------|----|----|----------|
| name | '门店评级模型' | 配置名称 | `new-scoring-model.js:14` |
| type | 'store_rating' | 类型 | `new-scoring-model.js:15` |
| period | 'monthly' | 按月评级 | `new-scoring-model.js:16` |
| rules.A | { min_rate: 95.01 } | 达成率>95%为A级 | `new-scoring-model.js:18` |
| rules.B | { min_rate: 90.01, max_rate: 95.00 } | 达成率90-95%为B级 | `new-scoring-model.js:19` |
| rules.C | { max_rate: 90.00 } | 达成率<90%为C级 | `new-scoring-model.js:20` |
| data_sources.actual_revenue | 'daily_reports' | 实际营业额来源 | `new-scoring-model.js:23` |
| data_sources.target_revenue | 'revenue_targets' | 目标营业额来源 | `new-scoring-model.js:24` |
| new_store_grace_period | 1 | 第一个月不评级 | `new-scoring-model.js:26` |

### 7.3 员工评分模型配置表 (EMPLOYEE_SCORE_CONFIG)

| 配置项 | 值 | 说明 | 代码位置 |
|--------|----|----|----------|
| name | '员工评分模型' | 配置名称 | `new-scoring-model.js:33` |
| type | 'employee_score' | 类型 | `new-scoring-model.js:34` |
| period | 'monthly' | 按月评分 | `new-scoring-model.js:35` |
| base_score | 100 | 基础分100分 | `new-scoring-model.js:36` |
| scoring.exception_bonus | '零异常加分' | 加分项说明 | `new-scoring-model.js:39` |
| scoring.exception_deduction | '异常扣分' | 扣分项说明 | `new-scoring-model.js:40` |

### 7.4 执行力评级配置表 (execution_rules)

| 角色 | 数据来源 | 频率 | 评级规则 | 代码位置 |
|------|----------|------|----------|----------|
| store_production_manager | ['收档检查', '开档检查', '原料收货日报'] | daily | A:缺≤6次, B:缺≤13次, C:缺≤20次, D:缺≥21次 | `new-scoring-model.js:43-51` |
| store_manager | ['门店例会报告'] | daily | A:缺≤2且低分≤2, B:缺≤4且低分≤4, C:缺≤6且低分≤6, D:默认 | `new-scoring-model.js:53-62` |

### 7.5 工作态度评级配置表 (attitude_rules)

| 配置项 | 值 | 说明 | 代码位置 |
|--------|----|----|----------|
| data_source | 'master_tasks' | 任务数据源 | `new-scoring-model.js:66` |
| reminder_count | 3 | 提醒次数 | `new-scoring-model.js:67` |
| rating_thresholds.A | { max_incomplete: 2 } | 未完成≤2次为A | `new-scoring-model.js:69` |
| rating_thresholds.B | { max_incomplete: 4 } | 未完成≤4次为B | `new-scoring-model.js:70` |
| rating_thresholds.C | { default: true } | 其他情况为C | `new-scoring-model.js:71` |

### 7.6 工作能力评级配置表 (ability_rules)

| 角色 | 数据来源 | 评级规则 | 代码位置 |
|------|----------|----------|----------|
| store_production_manager | monthly_margins | A:实际>目标+1%, B:目标±1%, C:低于1%以上, D:低于2%及以上 | `new-scoring-model.js:75-82` |
| store_manager | daily_reports | 洪潮: A≥4.6, B≥4.5, C≥4.3; 马己仙: A≥4.5, B≥4.4, C≥4.0 | `new-scoring-model.js:84-99` |

### 7.7 HR Agent回复模版表

| 场景 | 模版内容 | 变量 | 代码位置 |
|------|----------|------|----------|
| 新模型-有评分 | `HR: ${senderName}，你在${score.store}（${score.brand}）的最新考核：\n\n📊 绩效得分：${score.total_score} 分\n📋 模型：${score.score_model}\n\n🏪 门店评级：${storeRatingText}\n📈 执行力：${execRatingText}\n💪 工作态度：${attRatingText}\n🎯 工作能力：${abiRatingText}\n\n${score.summary}` | senderName, score, storeRatingText, execRatingText, attRatingText, abiRatingText | `agents.js:3565-3575` |
| 旧模型兼容 | `${senderName}，你在${score.store}（${score.brand}）的最新考核：\n\n📊 绩效得分：${score.total_score} 分\n📋 模型：${score.score_model}\n${breakdown}\n\n扣分明细：\n${deductionText}\n\n${score.summary}` | senderName, score, breakdown, deductionText | `agents.js:3582` |
| 无记录 | `暂无你的考核记录。考核将在本周结束时自动生成。` | 无 | `agents.js:3592` |
| 刚完成 | `刚完成本周考核：\n\n📊 总分：${mine.totalScore} 分\n${mine.summary}` | mine.totalScore, mine.summary | `agents.js:3591` |

### 7.8 HR评语生成Prompt

| 用途 | Prompt内容 | 代码位置 |
|------|------------|----------|
| 评语生成 | `你是专业的餐饮绩效考核官，语言简洁务实。` + `品牌${brand}（${config.label}），门店${storeName}，${mgr.name}（${role}）。总分${totalScore}，门店评级${storeRating.rating}，执行力${employeeScore.execution_rating}，态度${employeeScore.attitude_rating}，能力${employeeScore.ability_rating}。请给出2-3句评语。` | `agents.js:3363` |

---

## 八、SOP Agent (SOP顾问) 详细配置

### 8.1 来源文件
- **主文件**: `server/agents.js`
- **核心函数**: `queryKnowledgeBase()`

### 8.2 SOP Agent System Prompt模版

| 配置项 | 内容 | 代码位置 |
|--------|------|----------|
| 角色定义 | `你是餐饮SOP专家顾问，精通品牌差异化SOP并严格执行品牌隔离。` | `agents.js:3623` |
| 品牌关键点 | `${brandConfig?.sopKeypoints?.length ? `\n品牌关键点：${brandConfig.sopKeypoints.join('；')}` : ''}` | `agents.js:3623` |
| 当前信息 | `门店：${store}（${brand}，brand_id=${brandId}）\n用户：${senderName}（${senderUsername}）\n查询：${text}` | `agents.js:3626-3628` |
| 知识库内容 | `${kbContext}` | `agents.js:3630` |
| 回复结构 | `1. **问题判断**：简要确认理解的问题\n2. **标准流程**：分步骤说明具体操作（1-2-3格式）\n3. **注意事项**：关键提醒和常见错误\n4. **参考依据**：相关SOP条款或标准` | `agents.js:3633-3636` |
| 要求 | `简洁实用，每步不超过15字，总回复不超过300字。` | `agents.js:3638` |

### 8.3 SOP Agent回复模版表

| 场景 | 模版内容 | 变量 | 代码位置 |
|------|----------|------|----------|
| 知识库查询 | 根据知识库结果生成回复 | kbResults | `agents.js:3615-3619` |
| 无结果 | `这个问题我需要查阅最新的SOP手册，稍后回复你。` | 无 | `agents.js:3648` |

---

## 九、Appeal Agent (申诉处理员) 详细配置

### 9.1 来源文件
- **主文件**: `server/agents.js`

### 9.2 Appeal Agent System Prompt

| 配置项 | 内容 | 代码位置 |
|--------|------|----------|
| 角色定义 | `你是餐饮绩效申诉处理员。确认申诉内容，说明将核实数据，给出预计处理时间。专业公正有温度。` | `agents.js:3600` |
| 上下文 | `店长${senderName}（${store}门店）申诉：${text}` | `agents.js:3601` |

### 9.3 Appeal Agent回复模版表

| 场景 | 模版内容 | 变量 | 代码位置 |
|------|----------|------|----------|
| 默认回复 | `已记录你的申诉，我们将在24小时内核实并回复。` | 无 | `agents.js:3603` |
| LLM生成 | 根据Prompt生成专业回复 | senderName, store, text | `agents.js:3600-3602` |

---

## 十、General Agent (通用助手) 详细配置

### 10.1 来源文件
- **主文件**: `server/agents.js`

### 10.2 General Agent System Prompt

| 配置项 | 内容 | 代码位置 |
|--------|------|----------|
| 角色定义 | `你是餐饮门店数字助理，服务于${store}（${brand}，brand_id=${brandId}）。当前用户是${roleText}（${senderName}）。可以帮助：数据审计、营运检查、绩效查询、SOP咨询、申诉处理。简洁友好。` | `agents.js:3661` |

### 10.3 General Agent回复模版表

| 场景 | 模版内容 | 变量 | 代码位置 |
|------|----------|------|----------|
| 默认回复 | `收到你的消息。你可以问我数据审计、营运检查、绩效考核等问题，也可以直接发照片给我审核。` | 无 | `agents.js:3664` |
| LLM生成 | 根据Prompt生成回复 | store, brand, brandId, roleText, senderName | `agents.js:3660-3663` |

---

## 十一、数据库表配置汇总

### 11.1 Agent相关数据库表

| 表名 | 用途 | 来源文件 | 创建位置 |
|------|------|----------|----------|
| agent_scores | 绩效评分存储 | `agents.js` | `runChiefEvaluator()` |
| agent_issues | 异常问题记录 | `agents.js` | `runDataAuditor()` |
| agent_messages | 消息记录 | `agents.js` | 消息收发时 |
| agent_appeals | 申诉记录 | `agents.js` | `handleAgentMessage()` |
| master_tasks | Master任务全生命周期 | `master-agent.js` | `ensureMasterTables()` |
| master_events | Master事件审计 | `master-agent.js` | `ensureMasterTables()` |
| sop_cases | SOP案例分析 | `master-agent.js` | `ensureMasterTables()` |

---

## 十二、调度器配置汇总

### 12.1 调度器间隔配置

| Agent/任务 | 间隔 | 代码位置 |
|------------|------|----------|
| Data Auditor (BI) | 30分钟 | `master-agent.js` 监听器说明 |
| Master Dispatcher | 15秒 | `master-agent.js` 监听器说明 |
| Ops Agent (OP) | 20秒 | `master-agent.js` 监听器说明 |
| Post Resolution | 20秒 | `master-agent.js` 监听器说明 |
| Evaluator (HR) | 30秒 | `master-agent.js` 监听器说明 |
| Final Notification | 30秒 | `master-agent.js` 监听器说明 |
| Bitable Polling (ops_checklist) | 60秒 | `agents.js:68` |
| Bitable Polling (table_visit) | 300秒 | `agents.js:77` |

---

## 十三、旧评分模型状态

### 13.1 已停用文件

| 文件 | 状态 | 说明 |
|------|------|------|
| `chief-evaluator-config.js` | ⚠️ 建议删除 | 包含旧扣分规则 `UNIFIED_DEDUCTION_RULES` 和 `VISUAL_AUDIT_DEDUCTION_RULES` |

### 13.2 新评分模型确认

| 模型 | 状态 | 数据来源 | 代码位置 |
|------|------|----------|----------|
| 门店评级模型 | ✅ 运行中 | daily_reports + revenue_targets | `new-scoring-model.js:13-27` |
| 员工评分模型 | ✅ 运行中 | kitchen_reports + material_receiving_reports + master_tasks + monthly_margins | `new-scoring-model.js:32-102` |

---

## 附录：文件路径汇总

| 文件名 | 绝对路径 |
|--------|----------|
| master-agent.js | `/Users/xieding/windsure/CascadeProjects/windsurf-project/hr-management-system/server/master-agent.js` |
| agents.js | `/Users/xieding/windsure/CascadeProjects/windsurf-project/hr-management-system/server/agents.js` |
| new-scoring-model.js | `/Users/xieding/windsure/CascadeProjects/windsurf-project/hr-management-system/server/new-scoring-model.js` |
| chief-evaluator-config.js | `/Users/xieding/windsure/CascadeProjects/windsurf-project/hr-management-system/server/chief-evaluator-config.js` |
| agent-communication-system.js | `/Users/xieding/windsure/CascadeProjects/windsurf-project/hr-management-system/server/agent-communication-system.js` |

---

> **使用说明**: 
> 1. 本手册包含所有6个Agent的最新配置
> 2. 要修改Agent回复内容，请根据"代码位置"列找到对应代码行
> 3. 修改后执行 `rsync` 同步到服务器并重启服务
> 4. 旧评分模型配置文件 `chief-evaluator-config.js` 建议删除以避免混淆
