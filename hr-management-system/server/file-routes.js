/**
 * 文件管理 API 路由
 */

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import archiver from 'archiver';
import { pool } from './utils/database.js';
import {
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
} from './file-manager.js';

const router = express.Router();

// Multer 配置（内存存储）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB
  }
});

// 获取文件列表（管理员和总部管理员可访问）
router.get('/files', async (req, res) => {
  const allowedRoles = ['admin', 'hq_manager', 'hr_manager'];
  if (!allowedRoles.includes(req.user?.role)) {
    return res.status(403).json({ ok: false, error: '仅管理员可访问文件中心' });
  }
  try {
    const filters = {
      fileType: req.query.type,
      store: req.query.store,
      uploader: req.query.uploader,
      tags: req.query.tags ? req.query.tags.split(',') : undefined,
      validationStatus: req.query.validation_status,
      startDate: req.query.start_date,
      endDate: req.query.end_date
    };
    
    const pagination = {
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 50
    };
    
    const result = await listFiles(filters, pagination);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[file-routes] GET /files error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 上传文件（仅管理员）
router.post('/files/upload', upload.single('file'), async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ ok: false, error: '仅管理员可上传文件' });
  }
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: '未选择文件' });
    }
    
    const { originalname, buffer, mimetype } = req.file;
    const {
      file_type, source, store, brand,
      date_range_start, date_range_end,
      tags, upload_note, related_task_id
    } = req.body;
    
    // 保存文件
    const savedFile = await saveFile(buffer, originalname, file_type);
    
    // 创建数据库记录
    const uploaderInfo = {
      username: req.user?.username,
      name: req.user?.name,
      ip: req.ip
    };
    
    const fileRecord = await createFileRecord({
      ...savedFile,
      fileType: file_type,
      source: source || 'manual_upload',
      store,
      brand,
      dateRangeStart: date_range_start,
      dateRangeEnd: date_range_end,
      tags: tags ? JSON.parse(tags) : [],
      metadata: { mimeType: mimetype },
      uploadNote: upload_note,
      relatedTaskId: related_task_id
    }, uploaderInfo);
    
    // 记录访问日志
    await logFileAccess(fileRecord.file_id, 'upload', uploaderInfo);
    
    // 自动校验（如果是 POS 销售文件）
    if (file_type === 'pos_sales') {
      const validationResult = await validatePOSSalesFile(savedFile.storedPath);
      await updateValidationStatus(
        fileRecord.file_id,
        validationResult.passed ? 'passed' : 'failed',
        validationResult
      );
      fileRecord.validation_status = validationResult.passed ? 'passed' : 'failed';
      fileRecord.validation_result = validationResult;
    }
    
    res.json({
      ok: true,
      file: fileRecord,
      message: '文件上传成功'
    });
  } catch (e) {
    console.error('[file-routes] POST /files/upload error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 获取文件详情
router.get('/files/:fileId', async (req, res) => {
  try {
    const file = await getFileById(req.params.fileId);
    
    if (!file) {
      return res.status(404).json({ ok: false, error: '文件不存在' });
    }
    
    res.json({ ok: true, file });
  } catch (e) {
    console.error('[file-routes] GET /files/:fileId error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 下载文件（仅管理员）
router.get('/files/:fileId/download', async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ ok: false, error: '仅管理员可下载文件' });
  }
  try {
    const file = await getFileById(req.params.fileId);
    
    if (!file) {
      return res.status(404).json({ ok: false, error: '文件不存在' });
    }
    
    const filePath = getFilePath(file.stored_name);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: '文件物理路径不存在' });
    }
    
    // 记录下载日志
    await logFileAccess(file.file_id, 'download', {
      username: req.user?.username,
      ip: req.ip,
      userAgent: req.get('user-agent')
    });
    
    // 增加下载计数
    await incrementDownloadCount(file.file_id);
    
    // 发送文件
    res.download(filePath, file.original_name);
  } catch (e) {
    console.error('[file-routes] GET /files/:fileId/download error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 删除文件（仅管理员）
router.delete('/files/:fileId', async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ ok: false, error: '仅管理员可删除文件' });
  }
  try {
    const file = await getFileById(req.params.fileId);
    
    if (!file) {
      return res.status(404).json({ ok: false, error: '文件不存在' });
    }
    
    // 权限检查：只有上传者、admin、hq_manager 可以删除
    const userRole = req.user?.role;
    const isOwner = req.user?.username === file.uploader_username;
    const canDelete = isOwner || ['admin', 'hq_manager'].includes(userRole);
    
    if (!canDelete) {
      return res.status(403).json({ ok: false, error: '无权限删除此文件' });
    }
    
    await deleteFile(req.params.fileId, req.user?.username);
    
    res.json({ ok: true, message: '文件已删除' });
  } catch (e) {
    console.error('[file-routes] DELETE /files/:fileId error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 获取所有标签（仅管理员）
router.get('/files/tags/all', async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ ok: false, error: '仅管理员可访问' });
  }
  try {
    const tags = await getAllTags();
    res.json({ ok: true, tags });
  } catch (e) {
    console.error('[file-routes] GET /files/tags/all error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 手动触发文件校验（仅管理员）
router.post('/files/:fileId/validate', async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ ok: false, error: '仅管理员可校验文件' });
  }
  try {
    const file = await getFileById(req.params.fileId);
    
    if (!file) {
      return res.status(404).json({ ok: false, error: '文件不存在' });
    }
    
    const filePath = getFilePath(file.stored_name);
    let validationResult;
    
    // 根据文件类型选择校验方法
    if (file.file_type === 'pos_sales') {
      validationResult = await validatePOSSalesFile(filePath);
    } else {
      validationResult = {
        passed: true,
        message: '此文件类型暂不支持自动校验'
      };
    }
    
    await updateValidationStatus(
      file.file_id,
      validationResult.passed ? 'passed' : 'failed',
      validationResult
    );
    
    res.json({
      ok: true,
      validation: validationResult,
      message: validationResult.passed ? '校验通过' : '校验失败'
    });
  } catch (e) {
    console.error('[file-routes] POST /files/:fileId/validate error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 批量下载文件（ZIP，仅管理员）
router.post('/files/batch-download', async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ ok: false, error: '仅管理员可批量下载文件' });
  }
  try {
    const { file_ids } = req.body;
    
    if (!Array.isArray(file_ids) || file_ids.length === 0) {
      return res.status(400).json({ ok: false, error: '未选择文件' });
    }
    
    if (file_ids.length > 50) {
      return res.status(400).json({ ok: false, error: '一次最多下载50个文件' });
    }
    
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    res.attachment('files.zip');
    archive.pipe(res);
    
    for (const fileId of file_ids) {
      const file = await getFileById(fileId);
      if (!file) continue;
      
      const filePath = getFilePath(file.stored_name);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: file.original_name });
        await logFileAccess(file.file_id, 'download', {
          username: req.user?.username,
          ip: req.ip
        });
        await incrementDownloadCount(file.file_id);
      }
    }
    
    archive.finalize();
  } catch (e) {
    console.error('[file-routes] POST /files/batch-download error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 搜索文件（全文搜索，仅管理员）
router.get('/files/search', async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ ok: false, error: '仅管理员可搜索文件' });
  }
  try {
    const { q, page = 1, limit = 20 } = req.query;
    
    if (!q || q.trim().length === 0) {
      return res.status(400).json({ ok: false, error: '搜索关键词不能为空' });
    }
    
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const searchTerm = `%${q}%`;
    
    const countResult = await pool().query(
      `SELECT COUNT(*) as total FROM files 
       WHERE deleted_at IS NULL 
       AND (original_name ILIKE $1 OR upload_note ILIKE $1 OR store ILIKE $1)`,
      [searchTerm]
    );
    
    const filesResult = await pool().query(
      `SELECT * FROM files 
       WHERE deleted_at IS NULL 
       AND (original_name ILIKE $1 OR upload_note ILIKE $1 OR store ILIKE $1)
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [searchTerm, parseInt(limit), offset]
    );
    
    res.json({
      ok: true,
      total: parseInt(countResult.rows[0].total),
      page: parseInt(page),
      limit: parseInt(limit),
      files: filesResult.rows
    });
  } catch (e) {
    console.error('[file-routes] GET /files/search error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 关联文件到任务（仅管理员）
router.post('/files/:fileId/link-task', async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ ok: false, error: '仅管理员可关联文件到任务' });
  }
  try {
    const { task_id } = req.body;
    
    if (!task_id) {
      return res.status(400).json({ ok: false, error: '任务ID不能为空' });
    }
    
    await pool().query(
      `UPDATE files SET related_task_id = $1, updated_at = NOW() WHERE file_id = $2`,
      [task_id, req.params.fileId]
    );
    
    res.json({ ok: true, message: '文件已关联到任务' });
  } catch (e) {
    console.error('[file-routes] POST /files/:fileId/link-task error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
