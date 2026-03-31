/**
 * 数据库工具模块
 * 统一数据库连接和基础操作
 */

let _pool = null;
export function setPool(p) { _pool = p; }
export function pool() { 
  if (!_pool) throw new Error('database: pool not set'); 
  return _pool; 
}

// 安全的数据库查询包装
export async function safeQuery(query, params = []) {
  try {
    const result = await pool().query(query, params);
    return result;
  } catch (error) {
    console.error('[database] Query failed:', error.message);
    console.error('[database] Query:', query);
    console.error('[database] Params:', params);
    throw error;
  }
}

// 安全的数据库事务包装
export async function safeTransaction(callback) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[database] Transaction failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}
