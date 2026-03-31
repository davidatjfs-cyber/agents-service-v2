-- 文件管理模块数据表
-- 创建时间: 2026-03-02

-- 1. 文件表
CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id VARCHAR(50) UNIQUE NOT NULL, -- 文件唯一标识 FILE-YYYYMMDD-XXXX
  original_name VARCHAR(500) NOT NULL, -- 原始文件名
  stored_name VARCHAR(500) NOT NULL, -- 存储文件名（含路径）
  file_type VARCHAR(50), -- 文件类型：pos_sales, feishu_export, daily_report, etc.
  mime_type VARCHAR(100), -- MIME类型
  file_size BIGINT, -- 文件大小（字节）
  checksum VARCHAR(64), -- MD5/SHA256校验和
  
  -- 元数据
  source VARCHAR(50), -- 来源：manual_upload, feishu_sync, auto_backup
  store VARCHAR(200), -- 关联门店
  brand VARCHAR(100), -- 关联品牌
  date_range_start DATE, -- 数据日期范围开始
  date_range_end DATE, -- 数据日期范围结束
  tags JSONB DEFAULT '[]'::jsonb, -- 标签数组
  metadata JSONB DEFAULT '{}'::jsonb, -- 其他元数据
  
  -- 上传信息
  uploader_username VARCHAR(100), -- 上传人
  uploader_name VARCHAR(200), -- 上传人姓名
  upload_ip VARCHAR(50), -- 上传IP
  upload_note TEXT, -- 上传说明
  
  -- 版本控制
  version INTEGER DEFAULT 1, -- 版本号
  parent_file_id VARCHAR(50), -- 父文件ID（用于版本链）
  is_latest BOOLEAN DEFAULT true, -- 是否最新版本
  
  -- 校验状态
  validation_status VARCHAR(20) DEFAULT 'pending', -- pending, passed, failed
  validation_result JSONB DEFAULT '{}'::jsonb, -- 校验结果详情
  validated_at TIMESTAMP,
  
  -- 审批状态（可选）
  approval_status VARCHAR(20) DEFAULT 'approved', -- pending, approved, rejected
  approved_by VARCHAR(100),
  approved_at TIMESTAMP,
  
  -- 关联任务
  related_task_id VARCHAR(50), -- 关联的 master_task
  
  -- 访问控制
  visibility VARCHAR(20) DEFAULT 'private', -- public, private, role_based
  allowed_roles JSONB DEFAULT '[]'::jsonb, -- 允许访问的角色
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP, -- 软删除
  
  -- 下载统计
  download_count INTEGER DEFAULT 0,
  last_downloaded_at TIMESTAMP
);

-- 2. 文件标签表（可选，用于标签管理）
CREATE TABLE IF NOT EXISTS file_tags (
  id SERIAL PRIMARY KEY,
  tag_name VARCHAR(100) UNIQUE NOT NULL,
  tag_category VARCHAR(50), -- 标签分类：source, store, type, etc.
  tag_color VARCHAR(20), -- 标签颜色
  usage_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 3. 文件访问日志表
CREATE TABLE IF NOT EXISTS file_access_logs (
  id SERIAL PRIMARY KEY,
  file_id VARCHAR(50) NOT NULL,
  action VARCHAR(20) NOT NULL, -- upload, download, delete, view
  username VARCHAR(100),
  ip_address VARCHAR(50),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_files_file_id ON files(file_id);
CREATE INDEX IF NOT EXISTS idx_files_type ON files(file_type);
CREATE INDEX IF NOT EXISTS idx_files_store ON files(store);
CREATE INDEX IF NOT EXISTS idx_files_uploader ON files(uploader_username);
CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_date_range ON files(date_range_start, date_range_end);
CREATE INDEX IF NOT EXISTS idx_files_tags ON files USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_files_validation ON files(validation_status);
CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_file_access_logs_file ON file_access_logs(file_id);
CREATE INDEX IF NOT EXISTS idx_file_access_logs_user ON file_access_logs(username);
CREATE INDEX IF NOT EXISTS idx_file_access_logs_created ON file_access_logs(created_at DESC);

-- 插入默认标签
INSERT INTO file_tags (tag_name, tag_category, tag_color) VALUES
  ('POS销售', 'source', 'blue'),
  ('飞书导出', 'source', 'green'),
  ('营业日报', 'source', 'orange'),
  ('洪潮大宁久光店', 'store', 'purple'),
  ('马己仙上海音乐广场店', 'store', 'purple'),
  ('已校验', 'status', 'green'),
  ('待审核', 'status', 'yellow'),
  ('已归档', 'status', 'gray')
ON CONFLICT (tag_name) DO NOTHING;
