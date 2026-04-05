-- 025: 修复 point_records 唯一索引错误
-- 问题: idx_point_records_approval_id 是 UNIQUE INDEX，限制了同一个 approval_id 只能有一条记录
-- 但业务需要一个审批对应多条积分记录（如一个审批同时给多人加分）
-- 解决: 删除该唯一索引，改为普通索引

DROP INDEX IF EXISTS idx_point_records_approval_id;
CREATE INDEX IF NOT EXISTS idx_point_records_approval_id ON point_records (approval_id) WHERE approval_id IS NOT NULL;
