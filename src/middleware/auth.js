import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger.js';

export function authRequired(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query?.token;
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
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
