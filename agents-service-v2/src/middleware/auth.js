import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger.js';
import { query } from '../utils/db.js';

const INACTIVE_STATUSES = new Set(['离职', 'inactive', 'resigned', 'deleted', 'terminated', '已离职', '已删除', '禁用', '停用']);

async function isEmployeeActive(username) {
  try {
    const r = await query(
      `SELECT data FROM hrms_state WHERE key = $1 LIMIT 1`,
      ['default']
    );
    const data = r.rows?.[0]?.data;
    if (!data || typeof data !== 'object') return true;
    const employees = Array.isArray(data.employees) ? data.employees : [];
    const emp = employees.find(
      e => String(e?.username || '').trim().toLowerCase() === String(username).trim().toLowerCase()
    );
    if (!emp) return true;
    const status = String(emp.status || '').trim().toLowerCase();
    if (INACTIVE_STATUSES.has(status)) return false;
    const approved = emp.offboardingApproved === true || emp.offboardingApproved === 'true' || emp.offboardingApproved === 1;
    if (approved && String(emp.offboardingDate || '').trim()) return false;
    return true;
  } catch (_) {
    return true;
  }
}

export function authRequired(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    if (decoded.role === 'admin') return next();
    isEmployeeActive(decoded.username).then(active => {
      if (!active) {
        logger.warn({ username: decoded.username }, '离职员工请求被拒');
        return res.status(403).json({ error: '账号已停用或已离职' });
      }
      next();
    }).catch(() => next());
  } catch (e) {
    logger.warn({ err: e.message }, 'Auth failed');
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}
