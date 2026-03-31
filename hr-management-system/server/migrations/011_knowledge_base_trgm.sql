-- B1: 知识库混合检索 — pg_trgm（标题/正文相似度），与 ILIKE 互补
-- 需在目标库执行一次（本地 migrate.js / 生产由 index.js 启动时 idempotent 应用）

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 标题：体量小，全量建 GIN
CREATE INDEX IF NOT EXISTS idx_kb_title_trgm ON knowledge_base USING gin (title gin_trgm_ops);

-- 正文：PDF 提取文本可能较长；行数通常有限（上传文档条数级）。若未来行数极大可改为 content 摘要列再建索引。
CREATE INDEX IF NOT EXISTS idx_kb_content_trgm ON knowledge_base USING gin (content gin_trgm_ops);

COMMENT ON INDEX idx_kb_title_trgm IS 'B1 knowledge_base title trigram search';
COMMENT ON INDEX idx_kb_content_trgm IS 'B1 knowledge_base content trigram search';
