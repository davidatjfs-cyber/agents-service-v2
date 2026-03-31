-- 绩效扣分等系统通知：写入后由「我的档案」公司通知栏拉取合并展示
CREATE TABLE IF NOT EXISTS hrms_user_notifications (
  id BIGSERIAL PRIMARY KEY,
  target_username TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'performance_deduction',
  meta JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hrms_notif_user_created ON hrms_user_notifications (target_username, created_at DESC);
