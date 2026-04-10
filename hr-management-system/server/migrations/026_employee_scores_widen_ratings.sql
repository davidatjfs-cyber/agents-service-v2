-- 支持「待定」等中文评级文案（原 VARCHAR(1) 仅可容纳单字节字母）
ALTER TABLE employee_scores
  ALTER COLUMN execution_rating TYPE VARCHAR(32),
  ALTER COLUMN attitude_rating TYPE VARCHAR(32),
  ALTER COLUMN ability_rating TYPE VARCHAR(32);
