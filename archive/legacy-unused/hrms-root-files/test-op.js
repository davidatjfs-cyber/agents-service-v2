const OPS_AGENT_CONFIG = {
  dispatchers: ['store_manager', 'store_production_manager'], // 派单人员角色
  scheduledTasks: {
    dailyInspections: [
      { brand: '洪潮', type: 'opening', time: '10:30', checklist: ['地面清洁无积水', '所有设备正常开启', '食材新鲜度检查', '餐具消毒完成', '灯光亮度适中', '背景音乐开启', '空调温度设置合适', '员工仪容仪表检查'] },
      { brand: '马己仙', type: 'opening', time: '10:00', checklist: ['地面清洁', '设备开启', '食材准备', '餐具消毒', '迎宾准备'] },
      { brand: '洪潮', type: 'closing', time: '22:00', checklist: ['食材封存', '设备关闭', '垃圾清理', '安全检查', '门窗锁好'] },
      { brand: '马己仙', type: 'closing', time: '22:30', checklist: ['食材封存', '设备关闭', '垃圾清理', '安全检查', '门窗锁好', '电源关闭'] }
    ],
    randomInspections: [
      { type: 'seafood_pool_temperature', description: '拍摄海鲜池水温计照片', timeWindow: 15 },
      { type: 'fridge_label_check', description: '检查冰箱标签是否过期', timeWindow: 10 },
      { type: 'hand_washing_duration', description: '录制洗手20秒视频', timeWindow: 5 }
    ],
    dataTriggers: {
      productComplaintThreshold: 2, 
      marginDeviationThreshold: 0.01,
      tableVisitRatioThreshold: 0.50  
    }
  },
  visualInspection: {
    environment: {
      floorWater: 'detect_water_or_oil_on_floor',
      trashCovered: 'trash_bin_lid_closed',
      lightingAdequate: 'lighting_sufficient_for_clear_photos'
    },
    product: {
      platingAesthetics: '洪潮切配摆盘美学标准',
      portionSize: '分量是否达标',
      garnishPlacement: '装饰配菜摆放规范'
    },
    materials: {
      fridgeLabelExpiry: '冰箱标签是否过期',
      rawCookedSeparation: '生熟分装检查',
      storageTemperature: '储存温度合规'
    },
    accuracyThresholds: {
      labelClarity: 0.8,
      foodCoverage: 0.9,
      photoQuality: 0.85
    }
  },
  loopManagement: {
    followUpRules: {
      firstReminder: 60,
      secondReminder: 90,
      escalationDelay: 120,
      maxReminders: 3
    },
    logicValidation: {
      photoLocationRadius: 500,
      exifTimeTolerance: 5,
      hashDuplicateCheck: true,
      dataConsistency: true
    }
  },
  judgmentStandards: {
    timeliness: {
      readDeadline: 15,
      responseDeadline: 60,
      latePenalty: 'mark_slow_response'
    },
    authenticity: {
      locationRadius: 500,
      exifTolerance: 300,
      hashCheck: true,
      fraudAction: 'block_and_report'
    }
  }
};
console.log(JSON.stringify(OPS_AGENT_CONFIG, null, 2));
