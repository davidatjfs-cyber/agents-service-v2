-- 菜品优化周报：按 sales_raw 大类名称/编码分组（与 dish-optimization-report.js 一致）
ALTER TABLE sales_raw ADD COLUMN IF NOT EXISTS category VARCHAR(200);
ALTER TABLE sales_raw ADD COLUMN IF NOT EXISTS category_code VARCHAR(120);
