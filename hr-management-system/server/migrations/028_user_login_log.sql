-- 用户登录日志表：记录每次登录和登出，用于统计登录次数和在线时长
CREATE TABLE IF NOT EXISTS user_login_log (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  login_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  logout_at TIMESTAMP WITH TIME ZONE,
  session_nonce VARCHAR(64),
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 索引：按用户+日期查询登录次数
CREATE INDEX IF NOT EXISTS idx_user_login_log_username_date ON user_login_log (username, (login_at AT TIME ZONE 'Asia/Shanghai')::date);
-- 索引：按日期范围查询
CREATE INDEX IF NOT EXISTS idx_user_login_log_login_at ON user_login_log (login_at);
-- 索引：查找未关闭的会话（用于登出时匹配）
CREATE INDEX IF NOT EXISTS idx_user_login_log_open_session ON user_login_log (username, logout_at) WHERE logout_at IS NULL;

-- 清理90天之前的登录日志（可定期执行）
-- DELETE FROM user_login_log WHERE login_at < NOW() - INTERVAL '90 days';