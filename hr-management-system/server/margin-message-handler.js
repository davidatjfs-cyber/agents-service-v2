/**
 * 毛利率消息接收处理模块
 */

import { pool } from './utils/database.js';
import { safeExecute, safeErrorLog } from './utils/error-handler.js';

// ─────────────────────────────────────────────
// 毛利率消息解析
// ─────────────────────────────────────────────
export function parseMarginMessage(message) {
  try {
    // 解析消息格式，示例：
    // "洪潮久光店 2026年2月毛利率: 63.5%"
    const regex = /(.+?)\s*(\d{4})年(\d{1,2})月毛利率[:：]\s*(\d+\.?\d*)%/;
    const match = message.match(regex);
    
    if (!match) {
      return null;
    }
    
    const [, store, year, month, margin] = match;
    const period = `${year}-${month.padStart(2, '0')}`;
    
    return {
      store: store.trim(),
      period: period,
      actual_margin: parseFloat(margin),
      message: message.trim()
    };
  } catch (error) {
    safeErrorLog('margin_message_parse', error);
    return null;
  }
}

// ─────────────────────────────────────────────
// 保存毛利率数据
// ─────────────────────────────────────────────
export async function saveMarginData(marginData) {
  return safeExecute('margin_data_save', async () => {
    const { store, period, actual_margin } = marginData;
    
    // 推断品牌
    let brand = '洪潮';
    if (store.includes('马己仙')) {
      brand = '马己仙';
    }
    
    // 保存到monthly_margins表
    await pool().query(`
      INSERT INTO monthly_margins (store, brand, period, actual_margin, source)
      VALUES ($1, $2, $3, $4, 'feishu')
      ON CONFLICT (store, brand, period)
      DO UPDATE SET 
        actual_margin = EXCLUDED.actual_margin,
        updated_at = NOW()
    `, [store, brand, period, actual_margin]);
    
    console.log(`[margin] 已保存毛利率数据: ${store} ${period} ${actual_margin}%`);
    
    return { success: true };
  });
}

// ─────────────────────────────────────────────
// 处理飞书毛利率消息
// ─────────────────────────────────────────────
export async function handleMarginMessage(message) {
  try {
    console.log(`[margin] 收到毛利率消息: ${message}`);
    
    // 解析消息
    const marginData = parseMarginMessage(message);
    if (!marginData) {
      console.log('[margin] 消息格式无法解析:', message);
      return { success: false, error: 'message_format_invalid' };
    }
    
    // 保存数据
    const result = await saveMarginData(marginData);
    
    return result;
    
  } catch (error) {
    safeErrorLog('margin_message_handler', error);
    return { success: false, error: error.message };
  }
}

// ─────────────────────────────────────────────
// 验证消息格式
// ─────────────────────────────────────────────
export function validateMarginMessage(message) {
  const marginData = parseMarginMessage(message);
  return marginData !== null;
}
