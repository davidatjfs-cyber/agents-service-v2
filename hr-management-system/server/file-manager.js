/**
 * 文件管理模块
 * 提供文件上传、下载、校验、归档等功能
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { pool } from './utils/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 文件存储根目录
const FILE_STORAGE_ROOT = process.env.FILE_STORAGE_ROOT || path.join(__dirname, '../file_storage');

// 确保存储目录存在
function ensureStorageDir() {
  const dirs = [
    FILE_STORAGE_ROOT,
    path.join(FILE_STORAGE_ROOT, 'pos_sales'),
    path.join(FILE_STORAGE_ROOT, 'feishu_export'),
    path.join(FILE_STORAGE_ROOT, 'daily_report'),
    path.join(FILE_STORAGE_ROOT, 'temp')
  ];
  
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`[file-manager] Created directory: ${dir}`);
    }
  });
}

// 生成文件ID
function generateFileId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const random = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `FILE-${date}-${random}`;
}

// 计算文件校验和
function calculateChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// 保存文件到存储目录
export async function saveFile(fileBuffer, originalName, fileType, metadata = {}) {
  ensureStorageDir();
  
  const fileId = generateFileId();
  const ext = path.extname(originalName);
  const storedName = `${fileId}${ext}`;
  const subDir = fileType || 'temp';
  const storedPath = path.join(FILE_STORAGE_ROOT, subDir, storedName);
  
  // 写入文件
  fs.writeFileSync(storedPath, fileBuffer);
  
  // 计算校验和
  const checksum = await calculateChecksum(storedPath);
  const fileSize = fs.statSync(storedPath).size;
  
  return {
    fileId,
    originalName,
    storedName: path.join(subDir, storedName),
    storedPath,
    fileSize,
    checksum
  };
}

// 创建文件记录
export async function createFileRecord(fileData, uploaderInfo = {}) {
  const {
    fileId, originalName, storedName, fileSize, checksum,
    fileType, source, store, brand, dateRangeStart, dateRangeEnd,
    tags, metadata, uploadNote, relatedTaskId
  } = fileData;
  
  const result = await pool().query(
    `INSERT INTO files (
      file_id, original_name, stored_name, file_type, file_size, checksum,
      source, store, brand, date_range_start, date_range_end,
      tags, metadata, uploader_username, uploader_name, upload_ip, upload_note,
      related_task_id, validation_status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18, $19)
    RETURNING *`,
    [
      fileId, originalName, storedName, fileType, fileSize, checksum,
      source || 'manual_upload',
      store, brand, dateRangeStart, dateRangeEnd,
      JSON.stringify(tags || []),
      JSON.stringify(metadata || {}),
      uploaderInfo.username, uploaderInfo.name, uploaderInfo.ip,
      uploadNote, relatedTaskId,
      'pending'
    ]
  );
  
  return result.rows[0];
}

// 记录文件访问日志
export async function logFileAccess(fileId, action, userInfo = {}) {
  await pool().query(
    `INSERT INTO file_access_logs (file_id, action, username, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [fileId, action, userInfo.username, userInfo.ip, userInfo.userAgent]
  );
}

// 获取文件列表
export async function listFiles(filters = {}, pagination = {}) {
  const { fileType, store, uploader, tags, validationStatus, startDate, endDate } = filters;
  const { page = 1, limit = 50 } = pagination;
  const offset = (page - 1) * limit;
  
  let whereClause = 'WHERE deleted_at IS NULL';
  const params = [];
  let paramIndex = 1;
  
  if (fileType) {
    whereClause += ` AND file_type = $${paramIndex}`;
    params.push(fileType);
    paramIndex++;
  }
  
  if (store) {
    whereClause += ` AND store = $${paramIndex}`;
    params.push(store);
    paramIndex++;
  }
  
  if (uploader) {
    whereClause += ` AND uploader_username = $${paramIndex}`;
    params.push(uploader);
    paramIndex++;
  }
  
  if (validationStatus) {
    whereClause += ` AND validation_status = $${paramIndex}`;
    params.push(validationStatus);
    paramIndex++;
  }
  
  if (startDate) {
    whereClause += ` AND created_at >= $${paramIndex}`;
    params.push(startDate);
    paramIndex++;
  }
  
  if (endDate) {
    whereClause += ` AND created_at <= $${paramIndex}`;
    params.push(endDate);
    paramIndex++;
  }
  
  if (tags && tags.length > 0) {
    whereClause += ` AND tags ?| $${paramIndex}`;
    params.push(tags);
    paramIndex++;
  }
  
  const countResult = await pool().query(
    `SELECT COUNT(*) as total FROM files ${whereClause}`,
    params
  );
  
  const filesResult = await pool().query(
    `SELECT * FROM files ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );
  
  return {
    total: parseInt(countResult.rows[0].total),
    page,
    limit,
    files: filesResult.rows
  };
}

// 获取文件详情
export async function getFileById(fileId) {
  const result = await pool().query(
    `SELECT * FROM files WHERE file_id = $1 AND deleted_at IS NULL`,
    [fileId]
  );
  return result.rows[0];
}

// 更新文件校验状态
export async function updateValidationStatus(fileId, status, validationResult = {}) {
  await pool().query(
    `UPDATE files 
     SET validation_status = $1, validation_result = $2::jsonb, validated_at = NOW(), updated_at = NOW()
     WHERE file_id = $3`,
    [status, JSON.stringify(validationResult), fileId]
  );
}

// 软删除文件
export async function deleteFile(fileId, username) {
  await pool().query(
    `UPDATE files SET deleted_at = NOW(), updated_at = NOW() WHERE file_id = $1`,
    [fileId]
  );
  
  await logFileAccess(fileId, 'delete', { username });
}

// 增加下载计数
export async function incrementDownloadCount(fileId) {
  await pool().query(
    `UPDATE files 
     SET download_count = download_count + 1, last_downloaded_at = NOW()
     WHERE file_id = $1`,
    [fileId]
  );
}

// 获取文件物理路径
export function getFilePath(storedName) {
  return path.join(FILE_STORAGE_ROOT, storedName);
}

// 获取所有标签
export async function getAllTags() {
  const result = await pool().query(
    `SELECT * FROM file_tags ORDER BY tag_category, tag_name`
  );
  return result.rows;
}

// POS 销售文件校验
export async function validatePOSSalesFile(filePath) {
  const errors = [];
  const warnings = [];
  
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    
    if (lines.length < 2) {
      errors.push('文件为空或只有表头');
      return { passed: false, errors, warnings };
    }
    
    // 检查表头
    const header = lines[0].split(',');
    const requiredColumns = ['date', 'store', 'revenue', 'sales_amount'];
    const missingColumns = requiredColumns.filter(col => !header.includes(col));
    
    if (missingColumns.length > 0) {
      errors.push(`缺少必需列: ${missingColumns.join(', ')}`);
    }
    
    // 检查数据行
    for (let i = 1; i < Math.min(lines.length, 100); i++) {
      const row = lines[i].split(',');
      
      // 检查日期格式
      const dateCol = header.indexOf('date');
      if (dateCol >= 0 && row[dateCol]) {
        const datePattern = /^\d{4}-\d{2}-\d{2}$/;
        if (!datePattern.test(row[dateCol])) {
          warnings.push(`第${i+1}行日期格式不正确: ${row[dateCol]}`);
        }
      }
      
      // 检查金额格式
      const revenueCol = header.indexOf('revenue');
      if (revenueCol >= 0 && row[revenueCol]) {
        const revenue = parseFloat(row[revenueCol]);
        if (isNaN(revenue) || revenue < 0) {
          warnings.push(`第${i+1}行营收金额异常: ${row[revenueCol]}`);
        }
      }
    }
    
    return {
      passed: errors.length === 0,
      errors,
      warnings,
      rowCount: lines.length - 1,
      columns: header
    };
  } catch (e) {
    return {
      passed: false,
      errors: [`文件读取失败: ${e.message}`],
      warnings: []
    };
  }
}

// 初始化存储目录
ensureStorageDir();

export default {
  saveFile,
  createFileRecord,
  logFileAccess,
  listFiles,
  getFileById,
  updateValidationStatus,
  deleteFile,
  incrementDownloadCount,
  getFilePath,
  getAllTags,
  validatePOSSalesFile
};
