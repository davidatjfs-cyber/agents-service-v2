/**
 * 飞书表格同步模块
 * 负责同步开档报告、收档报告、例会报告、原料收货日报
 */

import { pool } from './utils/database.js';
import { inferBrandFromStoreName } from './agents.js';
import { safeExecute, safeErrorLog } from './utils/error-handler.js';

// ─────────────────────────────────────────────
// 1. 飞书应用配置
// ─────────────────────────────────────────────
export const FEISHU_APP_CONFIG = {
  app_id: 'cli_a9fc0d13c838dcd6',
  app_secret: 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
  base_url: 'https://open.feishu.cn'
};

// ─────────────────────────────────────────────
// 2. 表格配置
// ─────────────────────────────────────────────
export const FEISHU_TABLE_CONFIG = {
  // 共用表格（所有品牌）
  closing_reports: {
    app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
    table_id: 'tblXYfSBRrgNGohN',
    view_id: 'vewYvZudua',
    name: '收档报告DB',
    type: 'kitchen_report',
    report_type: 'closing'
  },
  opening_reports: {
    app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
    table_id: 'tbl32E6d0CyvLvfi',
    view_id: 'vewUZZmWnZ',
    name: '开档报告',
    type: 'kitchen_report',
    report_type: 'opening'
  },
  meeting_reports: {
    app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
    table_id: 'tblZXgaU0LpSye2m',
    view_id: 'vewq7G0SpU',
    name: '例会报告',
    type: 'store_meeting'
  },
  dish_library: {
    app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
    table_id: 'tbltSvY7SBTr3Sw8',
    view_id: 'vewva7M4SZ',
    name: '菜品库',
    type: 'dish_library'
  },
  dish_library_majixian_takeaway: {
    app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
    table_id: 'tbltaVzb2nei9NwO',
    view_id: '',
    name: '马己仙外卖菜品库',
    type: 'dish_library',
    force_biz_type: 'takeaway'
  },
  
  // 品牌专属表格
  material_reports: {
    majixian: {
      app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
      table_id: 'tblz4kW1cY22XRlL',
      view_id: 'vewyyTyKf6',
      name: '马己仙原料收货日报',
      brand: 'majixian'
    },
    hongchao: {
      app_token: 'PTWrbUdcbarCshst0QncMoY7nKe',
      table_id: 'tbllcV1evqTJyzlN',
      view_id: 'vewyyTyKf6',
      name: '洪潮原料收货日报',
      brand: 'hongchao'
    }
  }
};

function extractFieldText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value
      .map(v => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
        if (typeof v === 'object') return String(v.text || v.name || v.value || '').trim();
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  if (typeof value === 'object') return String(value.text || value.name || value.value || '').trim();
  return '';
}

function pickFieldValue(fields, names = []) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  }
  return null;
}

function pickFieldText(fields, names = [], fallback = '') {
  const v = pickFieldValue(fields, names);
  const text = extractFieldText(v);
  return text || fallback;
}

function parseFieldNumber(value) {
  const text = extractFieldText(value).replace(/[,，\s]/g, '');
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : null;
}

function pickFieldNumber(fields, names = []) {
  const v = pickFieldValue(fields, names);
  return parseFieldNumber(v);
}

function extractDishLibraryEntries(fields, recordId, opts = {}) {
  const forceBizType = String(opts.forceBizType || '').trim();
  const store = pickFieldText(fields, ['门店', '门店名称', '适用门店', '适用店铺'], '*') || '*';

  const commonCost = pickFieldNumber(fields, ['菜品成本', '成本', '标准成本']);
  const dineinName = pickFieldText(fields, ['堂食名称', '堂食菜品名称', '堂食菜名', '菜品名称']);
  const dineinPrice = pickFieldNumber(fields, ['堂食价格', '堂食售价', '堂食单价', '堂食出品价']);
  const dineinCost = pickFieldNumber(fields, ['堂食成本', '堂食菜品成本', '堂食标准成本']);

  const takeawayName = pickFieldText(fields, ['外卖名称', '外卖菜品名称', '外卖菜名']);
  const takeawayPrice = pickFieldNumber(fields, ['外卖价格', '外卖售价', '外卖单价']);
  const takeawayCost = pickFieldNumber(fields, ['外卖成本', '外卖菜品成本', '外卖标准成本']);
  const genericDishName = pickFieldText(fields, ['菜品名称', '菜名', '商品名称', 'SKU名称']);
  const genericPrice = pickFieldNumber(fields, ['售价', '价格', '单价']);

  const rows = [];
  if (forceBizType === 'takeaway' && genericDishName && (genericPrice !== null || takeawayCost !== null || commonCost !== null)) {
    rows.push({
      feishu_record_id: recordId,
      store,
      biz_type: 'takeaway',
      dish_name: genericDishName,
      dish_price: genericPrice,
      unit_cost: takeawayCost ?? commonCost ?? 0,
      source_data: fields
    });
  }

  if (forceBizType !== 'takeaway' && dineinName && (dineinPrice !== null || dineinCost !== null || commonCost !== null)) {
    rows.push({
      feishu_record_id: recordId,
      store,
      biz_type: 'dinein',
      dish_name: dineinName,
      dish_price: dineinPrice,
      unit_cost: dineinCost ?? commonCost ?? 0,
      source_data: fields
    });
  }

  if (takeawayName && (takeawayPrice !== null || takeawayCost !== null || commonCost !== null)) {
    rows.push({
      feishu_record_id: recordId,
      store,
      biz_type: 'takeaway',
      dish_name: takeawayName,
      dish_price: takeawayPrice,
      unit_cost: takeawayCost ?? commonCost ?? 0,
      source_data: fields
    });
  }

  return rows;
}

// ─────────────────────────────────────────────
// 3. 字段提取函数
// ─────────────────────────────────────────────

// 收档报告字段提取
export function extractClosingReportFields(fields) {
  return {
    store: fields['门店'],
    date: fields['日期'],
    station: fields['档口'],
    responsible: fields['本档口值班负责人'],
    handover_time: fields['交接时间'],
    inventory_check: fields['本档口库存检查'],
    cleaning_status: fields['本档口清洁卫生'],
    equipment_status: fields['设备使用情况'],
    temperature_record: fields['温度记录'],
    handover_person: fields['交接人'],
    handover_receiver: fields['接收人'],
    issues: fields['异常情况说明'],
    submit_time: fields['提交时间']
  };
}

// 开档报告字段提取
export function extractOpeningReportFields(fields) {
  return {
    store: fields['门店'],
    date: fields['日期'],
    station: fields['档口'],
    responsible: fields['本档口值班负责人'],
    preparation_time: fields['开档时间'],
    inventory_check: fields['本档口库存检查'],
    cleaning_status: fields['本档口清洁卫生'],
    equipment_status: fields['设备使用情况'],
    temperature_record: fields['温度记录'],
    handover_person: fields['交接人'],
    handover_receiver: fields['接收人'],
    issues: fields['异常情况说明'],
    submit_time: fields['提交时间']
  };
}

// 例会报告字段提取
export function extractMeetingReportFields(fields) {
  return {
    store: fields['门店'],
    date: fields['日期'],
    meeting_time: fields['会议时间'],
    attendees: fields['参会人员'],
    meeting_content: fields['会议内容'],
    action_items: fields['待办事项'],
    meeting_score: parseInt(fields['会议得分']) || 0,
    reporter: fields['汇报人'],
    submit_time: fields['提交时间']
  };
}

// 原料收货日报字段提取
export function extractMaterialReportFields(fields) {
  return {
    store: fields['门店'],
    date: fields['日期'],
    receiver: fields['收货人'],
    suppliers: fields['供应商'],
    material_categories: fields['原料类别'],
    total_quantity: fields['总数量'],
    total_amount: fields['总金额'],
    quality_check: fields['质量检查'],
    temperature_check: fields['温度检查'],
    storage_location: fields['储存位置'],
    issues: fields['异常情况'],
    submit_time: fields['提交时间']
  };
}

// ─────────────────────────────────────────────
// 4. 飞书API函数
// ─────────────────────────────────────────────

// 获取飞书访问令牌
export async function getFeishuAccessToken() {
  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      app_id: FEISHU_APP_CONFIG.app_id,
      app_secret: FEISHU_APP_CONFIG.app_secret
    })
  });
  
  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`获取飞书token失败: ${data.msg}`);
  }
  
  return data.tenant_access_token;
}

// 获取表格记录
export async function fetchTableRecords(tableConfig, accessToken) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${tableConfig.app_token}/tables/${tableConfig.table_id}/records`;
  
  let allRecords = [];
  let pageToken = null;
  
  do {
    const queryParams = new URLSearchParams({
      page_size: '100'
    });
    if (String(tableConfig.view_id || '').trim()) {
      queryParams.append('view_id', String(tableConfig.view_id || '').trim());
    }
    
    if (pageToken) {
      queryParams.append('page_token', pageToken);
    }
    
    const response = await fetch(`${url}?${queryParams}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    
    if (data.code !== 0) {
      throw new Error(`获取表格数据失败: ${data.msg}`);
    }
    
    allRecords = allRecords.concat(data.data.items || []);
    pageToken = data.data.page_token;
    
  } while (pageToken);
  
  return allRecords;
}

// ─────────────────────────────────────────────
// 5. 同步函数
// ─────────────────────────────────────────────

// 厨房报告同步函数
export async function syncKitchenReports(tableConfig, accessToken, reportType) {
  try {
    const records = await fetchTableRecords(tableConfig, accessToken);
    let syncedCount = 0;
    
    for (const record of records) {
      const fields = record.fields;
      
      // 提取字段
      const extractedFields = reportType === 'closing' 
        ? extractClosingReportFields(fields)
        : extractOpeningReportFields(fields);
      
      const { store, date, station, responsible, submit_time } = extractedFields;
      
      if (!store || !date || !station) {
        console.warn(`[sync] 跳过无效记录: 缺少门店、日期或档口信息`);
        continue;
      }
      
      // 推断品牌
      const brand = inferBrandFromStoreName(store);
      
      // 保存到数据库
      await pool().query(`
        INSERT INTO kitchen_reports 
        (store, brand, report_date, report_type, station, reporter, report_data, feishu_record_id, submitted, submit_time)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (store, report_date, report_type, station)
        DO UPDATE SET 
          reporter = EXCLUDED.reporter,
          report_data = EXCLUDED.report_data,
          feishu_record_id = EXCLUDED.feishu_record_id,
          submitted = EXCLUDED.submitted,
          submit_time = EXCLUDED.submit_time,
          updated_at = NOW()
      `, [
        store, brand, new Date(date), reportType, station, responsible,
        JSON.stringify(extractedFields), record.record_id, 
        !!submit_time, submit_time ? new Date(submit_time) : null
      ]);
      
      syncedCount++;
    }
    
    console.log(`[sync] ${tableConfig.name} 同步完成: ${syncedCount}/${records.length} 条记录`);
    
  } catch (error) {
    console.error(`[sync] 同步 ${tableConfig.name} 失败:`, error);
  }
}

// 例会报告同步函数
export async function syncMeetingReports(tableConfig, accessToken) {
  try {
    const records = await fetchTableRecords(tableConfig, accessToken);
    let syncedCount = 0;
    
    for (const record of records) {
      const fields = record.fields;
      const extractedFields = extractMeetingReportFields(fields);
      
      const { store, date, meeting_score, reporter, submit_time, meeting_content } = extractedFields;
      
      if (!store || !date) {
        console.warn(`[sync] 跳过无效记录: 缺少门店或日期信息`);
        continue;
      }
      
      const brand = inferBrandFromStoreName(store);
      
      await pool().query(`
        INSERT INTO store_meeting_reports 
        (store, brand, meeting_date, reporter, meeting_content, meeting_score, report_data, feishu_record_id, submitted, submit_time)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (store, meeting_date)
        DO UPDATE SET 
          reporter = EXCLUDED.reporter,
          meeting_content = EXCLUDED.meeting_content,
          meeting_score = EXCLUDED.meeting_score,
          report_data = EXCLUDED.report_data,
          feishu_record_id = EXCLUDED.feishu_record_id,
          submitted = EXCLUDED.submitted,
          submit_time = EXCLUDED.submit_time,
          updated_at = NOW()
      `, [
        store, brand, new Date(date), reporter, meeting_content,
        meeting_score, JSON.stringify(extractedFields), record.record_id,
        !!submit_time, submit_time ? new Date(submit_time) : null
      ]);
      
      syncedCount++;
    }
    
    console.log(`[sync] ${tableConfig.name} 同步完成: ${syncedCount}/${records.length} 条记录`);
    
  } catch (error) {
    console.error(`[sync] 同步 ${tableConfig.name} 失败:`, error);
  }
}

// 原料收货日报同步函数
export async function syncMaterialReports(tableConfig, accessToken, brand) {
  try {
    const records = await fetchTableRecords(tableConfig, accessToken);
    let syncedCount = 0;
    
    for (const record of records) {
      const fields = record.fields;
      const extractedFields = extractMaterialReportFields(fields);
      
      const { store, date, receiver, submit_time } = extractedFields;
      
      if (!store || !date) {
        console.warn(`[sync] 跳过无效记录: 缺少门店或日期信息`);
        continue;
      }
      
      await pool().query(`
        INSERT INTO material_receiving_reports 
        (store, brand, report_date, receiver, report_data, feishu_record_id, submitted, submit_time)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (store, brand, report_date)
        DO UPDATE SET 
          receiver = EXCLUDED.receiver,
          report_data = EXCLUDED.report_data,
          feishu_record_id = EXCLUDED.feishu_record_id,
          submitted = EXCLUDED.submitted,
          submit_time = EXCLUDED.submit_time,
          updated_at = NOW()
      `, [
        store, brand, new Date(date), receiver,
        JSON.stringify(extractedFields), record.record_id,
        !!submit_time, submit_time ? new Date(submit_time) : null
      ]);
      
      syncedCount++;
    }
    
    console.log(`[sync] ${tableConfig.name} 同步完成: ${syncedCount}/${records.length} 条记录`);
    
  } catch (error) {
    console.error(`[sync] 同步 ${tableConfig.name} 失败:`, error);
  }
}

async function ensureDishLibraryTable() {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS dish_library_costs (
      id BIGSERIAL PRIMARY KEY,
      store VARCHAR(200) NOT NULL,
      biz_type VARCHAR(20) NOT NULL,
      dish_name VARCHAR(255) NOT NULL,
      dish_price NUMERIC(12,2),
      unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
      source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      source_record_id VARCHAR(120),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_dish_library_costs_store_biz_dish UNIQUE (store, biz_type, dish_name)
    )
  `);
  await pool().query(`CREATE INDEX IF NOT EXISTS idx_dish_library_costs_lookup ON dish_library_costs (store, biz_type, dish_name) WHERE enabled = TRUE`);
}

export async function syncDishLibraryCosts() {
  try {
    console.log('[sync] 开始同步菜品库...');
    await ensureDishLibraryTable();

    const accessToken = await getFeishuAccessToken();
    let upserted = 0;
    let recordCount = 0;
    const syncTargets = [
      FEISHU_TABLE_CONFIG.dish_library,
      FEISHU_TABLE_CONFIG.dish_library_majixian_takeaway
    ].filter(Boolean);

    for (const tableConfig of syncTargets) {
      const records = await fetchTableRecords(tableConfig, accessToken);
      recordCount += records.length;
      for (const record of records) {
        const rows = extractDishLibraryEntries(record.fields || {}, record.record_id, {
          forceBizType: tableConfig.force_biz_type
        });
        for (const row of rows) {
          await pool().query(
            `INSERT INTO dish_library_costs
              (store, biz_type, dish_name, dish_price, unit_cost, source_data, source_record_id, enabled, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,NOW())
             ON CONFLICT (store, biz_type, dish_name)
             DO UPDATE SET
               dish_price = EXCLUDED.dish_price,
               unit_cost = EXCLUDED.unit_cost,
               source_data = EXCLUDED.source_data,
               source_record_id = EXCLUDED.source_record_id,
               enabled = TRUE,
               updated_at = NOW()`,
            [
              row.store,
              row.biz_type,
              row.dish_name,
              row.dish_price,
              row.unit_cost,
              JSON.stringify(row.source_data || {}),
              row.feishu_record_id
            ]
          );
          upserted++;
        }
      }
    }

    console.log(`[sync] 菜品库同步完成: ${upserted} 条成本记录（来源${recordCount}条飞书记录）`);
    return { ok: true, records: recordCount, upserted };
  } catch (error) {
    console.error('[sync] 菜品库同步失败:', error);
    return { ok: false, error: String(error?.message || error) };
  }
}

// ─────────────────────────────────────────────
// 6. 主同步函数
// ─────────────────────────────────────────────

export async function syncAllFeishuTables() {
  try {
    console.log('[sync] 开始同步飞书表格数据...');
    
    const accessToken = await getFeishuAccessToken();
    
    // 1. 同步收档报告
    await syncKitchenReports(FEISHU_TABLE_CONFIG.closing_reports, accessToken, 'closing');
    
    // 2. 同步开档报告
    await syncKitchenReports(FEISHU_TABLE_CONFIG.opening_reports, accessToken, 'opening');
    
    // 3. 同步例会报告
    await syncMeetingReports(FEISHU_TABLE_CONFIG.meeting_reports, accessToken);
    
    // 4. 同步马己仙原料收货日报
    await syncMaterialReports(FEISHU_TABLE_CONFIG.material_reports.majixian, accessToken, 'majixian');
    
    // 5. 同步洪潮原料收货日报
    await syncMaterialReports(FEISHU_TABLE_CONFIG.material_reports.hongchao, accessToken, 'hongchao');

    console.log('[sync] 飞书表格数据同步完成');
    
  } catch (error) {
    console.error('[sync] 飞书同步失败:', error);
  }
}

// ─────────────────────────────────────────────
// 7. 定时同步调度器
// ─────────────────────────────────────────────

export function startDailyFeishuSync() {
  // 计算下次凌晨1点的时间
  const scheduleNextSync = () => {
    const now = new Date();
    const nextSync = new Date();
    nextSync.setDate(now.getDate() + (now.getHours() >= 1 ? 1 : 0));
    nextSync.setHours(1, 0, 0, 0);
    
    const delay = nextSync.getTime() - now.getTime();
    
    console.log(`[scheduler] 下次同步时间: ${nextSync.toLocaleString()}`);
    
    setTimeout(async () => {
      try {
        await syncAllFeishuTables();
        console.log('[scheduler] 每日同步完成');
      } catch (error) {
        console.error('[scheduler] 每日同步失败:', error);
      }
      
      // 安排下一次同步
      scheduleNextSync();
    }, delay);
  };
  
  // 启动调度器
  scheduleNextSync();
  console.log('[scheduler] 每日凌晨1点飞书同步调度器已启动');

  const localDateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // 每周六 00:00（Asia/Shanghai）同步菜品库（每周一次）
  let lastWeeklyDishSyncKey = '';
  setInterval(async () => {
    try {
      const nowSh = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
      if (nowSh.getDay() === 6 && nowSh.getHours() === 0 && nowSh.getMinutes() < 5) {
        const runKey = localDateKey(nowSh);
        if (runKey !== lastWeeklyDishSyncKey) {
          lastWeeklyDishSyncKey = runKey;
          await syncDishLibraryCosts();
          console.log('[scheduler] 每周菜品库同步完成');
        }
      }
    } catch (error) {
      console.error('[scheduler] 每周菜品库同步失败:', error?.message || error);
    }
  }, 60 * 1000);
  console.log('[scheduler] 每周六00:00菜品库同步调度器已启动');
}
