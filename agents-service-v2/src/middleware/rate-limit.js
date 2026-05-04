import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger.js';

/** 登录接口：每 IP 每分钟最多 5 次尝试 */
export const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: '登录尝试过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Login rate limit hit');
    res.status(429).json({ error: '登录尝试过于频繁，请稍后再试' });
  }
});

/** 通用 API：每 IP 每分钟最多 120 次 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false
});
