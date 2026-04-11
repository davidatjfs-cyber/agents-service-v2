/**
 * 可选 Bearer：设置 MEMPALACE_BEARER_TOKEN 后，除 GET /health 外均需 Authorization: Bearer <token>
 * 生产建议与 agents-service 的 MEMPALACE_HTTP_TOKEN 对齐。
 */
export function mempalaceAuthMiddleware(req, res, next) {
  const token = String(process.env.MEMPALACE_BEARER_TOKEN || '').trim();
  if (!token) return next();
  if (req.path === '/health' || req.path === '/') return next();
  const h = String(req.headers.authorization || '');
  const ok = h === `Bearer ${token}`;
  if (!ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}
