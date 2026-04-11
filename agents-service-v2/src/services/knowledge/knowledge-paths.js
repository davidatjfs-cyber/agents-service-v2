import path from 'path';

/** Wiki 落盘目录：默认 knowledge/wiki；生产建议 WIKI_DATA_DIR 指向独立数据卷并设目录权限 0700 */
export function getWikiDataDir() {
  const d = String(process.env.WIKI_DATA_DIR || '').trim();
  if (d) return path.resolve(d);
  return path.join(process.cwd(), 'knowledge', 'wiki');
}
