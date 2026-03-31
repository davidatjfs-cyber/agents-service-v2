/**
 * 文件自动备份模块
 * 定期备份飞书数据和POS销售数据
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './utils/database.js';
import { saveFile, createFileRecord } from './file-manager.js';
import axios from 'axios';
import { isExternalEnabled } from './safety.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 飞书备份：导出多维表格数据
export async function backupFeishuTable(appToken, tableId, tableName) {
  if (!isExternalEnabled()) return;
  try {
    console.log(`[file-backup] Starting Feishu table backup: ${tableName}`);
    
    const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
    const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
    if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) return;
    
    // 获取访问令牌
    const tokenRes = await axios.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: FEISHU_APP_ID,
        app_secret: FEISHU_APP_SECRET
      }
    );
    
    const accessToken = tokenRes.data.tenant_access_token;
    
    // 获取表格记录
    const recordsRes = await axios.post(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`,
      {
        page_size: 500
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const records = recordsRes.data.data.items || [];
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `feishu_${tableName}_${timestamp}.json`;
    const fileContent = JSON.stringify({
      table_name: tableName,
      app_token: appToken,
      table_id: tableId,
      backup_time: new Date().toISOString(),
      record_count: records.length,
      records: records
    }, null, 2);
    
    // 保存文件
    const fileBuffer = Buffer.from(fileContent, 'utf-8');
    const savedFile = await saveFile(fileBuffer, fileName, 'feishu_export');
    
    // 创建数据库记录
    const fileRecord = await createFileRecord({
      ...savedFile,
      fileType: 'feishu_export',
      source: 'auto_backup',
      metadata: {
        table_name: tableName,
        app_token: appToken,
        table_id: tableId,
        record_count: records.length
      },
      uploadNote: `自动备份：${tableName}`,
      tags: ['auto_backup', 'feishu', tableName]
    }, {
      username: 'system',
      name: '系统自动备份',
      ip: '127.0.0.1'
    });
    
    console.log(`[file-backup] Feishu backup completed: ${fileName}, ${records.length} records`);
    return fileRecord;
  } catch (e) {
    console.error(`[file-backup] Feishu backup error for ${tableName}:`, e.message);
    throw e;
  }
}

// POS数据备份：从数据库导出
export async function backupPOSSalesData(store, startDate, endDate) {
  try {
    console.log(`[file-backup] Starting POS backup: ${store}, ${startDate} to ${endDate}`);
    
    const result = await pool().query(
      `SELECT * FROM sales_raw 
       WHERE store = $1 
       AND date >= $2 
       AND date <= $3
       ORDER BY date DESC, time DESC`,
      [store, startDate, endDate]
    );
    
    const records = result.rows;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `pos_sales_${store}_${startDate}_${endDate}_${timestamp}.json`;
    const fileContent = JSON.stringify({
      store: store,
      start_date: startDate,
      end_date: endDate,
      backup_time: new Date().toISOString(),
      record_count: records.length,
      records: records
    }, null, 2);
    
    // 保存文件
    const fileBuffer = Buffer.from(fileContent, 'utf-8');
    const savedFile = await saveFile(fileBuffer, fileName, 'pos_sales');
    
    // 创建数据库记录
    const fileRecord = await createFileRecord({
      ...savedFile,
      fileType: 'pos_sales',
      source: 'auto_backup',
      store: store,
      dateRangeStart: startDate,
      dateRangeEnd: endDate,
      metadata: {
        record_count: records.length
      },
      uploadNote: `自动备份：${store} POS销售数据`,
      tags: ['auto_backup', 'pos_sales', store]
    }, {
      username: 'system',
      name: '系统自动备份',
      ip: '127.0.0.1'
    });
    
    console.log(`[file-backup] POS backup completed: ${fileName}, ${records.length} records`);
    return fileRecord;
  } catch (e) {
    console.error(`[file-backup] POS backup error for ${store}:`, e.message);
    throw e;
  }
}

// 营业日报备份
export async function backupDailyReports(store, startDate, endDate) {
  try {
    console.log(`[file-backup] Starting daily reports backup: ${store}, ${startDate} to ${endDate}`);
    
    const result = await pool().query(
      `SELECT * FROM daily_reports 
       WHERE store = $1 
       AND date >= $2 
       AND date <= $3
       ORDER BY date DESC`,
      [store, startDate, endDate]
    );
    
    const records = result.rows;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `daily_reports_${store}_${startDate}_${endDate}_${timestamp}.json`;
    const fileContent = JSON.stringify({
      store: store,
      start_date: startDate,
      end_date: endDate,
      backup_time: new Date().toISOString(),
      record_count: records.length,
      records: records
    }, null, 2);
    
    // 保存文件
    const fileBuffer = Buffer.from(fileContent, 'utf-8');
    const savedFile = await saveFile(fileBuffer, fileName, 'daily_report');
    
    // 创建数据库记录
    const fileRecord = await createFileRecord({
      ...savedFile,
      fileType: 'daily_report',
      source: 'auto_backup',
      store: store,
      dateRangeStart: startDate,
      dateRangeEnd: endDate,
      metadata: {
        record_count: records.length
      },
      uploadNote: `自动备份：${store} 营业日报`,
      tags: ['auto_backup', 'daily_report', store]
    }, {
      username: 'system',
      name: '系统自动备份',
      ip: '127.0.0.1'
    });
    
    console.log(`[file-backup] Daily reports backup completed: ${fileName}, ${records.length} records`);
    return fileRecord;
  } catch (e) {
    console.error(`[file-backup] Daily reports backup error for ${store}:`, e.message);
    throw e;
  }
}

// 定时备份任务（每周执行）
export async function runWeeklyBackup() {
  try {
    console.log('[file-backup] Starting weekly backup task...');
    
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
    
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    
    const stores = ['洪潮大宁久光店', '马己仙上海音乐广场店'];
    
    for (const store of stores) {
      // 备份POS数据
      try {
        await backupPOSSalesData(store, startDateStr, endDateStr);
      } catch (e) {
        console.error(`[file-backup] Failed to backup POS for ${store}:`, e.message);
      }
      
      // 备份营业日报
      try {
        await backupDailyReports(store, startDateStr, endDateStr);
      } catch (e) {
        console.error(`[file-backup] Failed to backup daily reports for ${store}:`, e.message);
      }
    }
    
    console.log('[file-backup] Weekly backup task completed');
  } catch (e) {
    console.error('[file-backup] Weekly backup task error:', e);
  }
}

// 启动定时备份（每周日凌晨3点执行）
export function startAutoBackupScheduler() {
  const schedule = require('node-cron');
  
  // 每周日凌晨3点执行
  schedule.schedule('0 3 * * 0', async () => {
    console.log('[file-backup] Scheduled weekly backup triggered');
    await runWeeklyBackup();
  });
  
  console.log('[file-backup] Auto backup scheduler started (weekly at 3:00 AM on Sunday)');
}
