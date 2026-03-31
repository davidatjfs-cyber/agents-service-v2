-- 文件管理系统表结构
-- 创建时间: 2026-03-03

-- 文件表
CREATE TABLE IF NOT EXISTS files (
  id SERIAL PRIMARY KEY,
  file_id VARCHAR(50) UNIQUE NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(50),
  file_size BIGINT,
  checksum VARCHAR(64),
  source VARCHAR(50) DEFAULT 'manual_upload',
  store VARCHAR(100),
  brand VARCHAR(100),
  date_range_start DATE,
  date_range_end DATE,
  tags JSONB DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  uploader_username VARCHAR(50),
  uploader_name VARCHAR(100),
  upload_ip VARCHAR(50),
  upload_note TEXT,
  related_task_id VARCHAR(50),
  validation_status VARCHAR(20) DEFAULT 'pending',
  validation_result JSONB,
  download_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP,
  deleted_by VARCHAR(50)
);

-- 文件访问日志表
CREATE TABLE IF NOT EXISTS file_access_logs (
  id SERIAL PRIMARY KEY,
  file_id VARCHAR(50) NOT NULL,
  action VARCHAR(20) NOT NULL,
  username VARCHAR(50),
  ip VARCHAR(50),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_files_file_id ON files(file_id);
CREATE INDEX IF NOT EXISTS idx_files_type ON files(file_type);
CREATE INDEX IF NOT EXISTS idx_files_store ON files(store);
CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_deleted_at ON files(deleted_at);
CREATE INDEX IF NOT EXISTS idx_file_access_logs_file_id ON file_access_logs(file_id);
CREATE INDEX IF NOT EXISTS idx_file_access_logs_created_at ON file_access_logs(created_at DESC);
