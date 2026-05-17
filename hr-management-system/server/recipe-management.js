/**
 * 配方管理模块 v2
 *
 * 层级结构：
 *   ingredient_library（原料库）
 *   recipes（产品配方）
 *     └── recipe_components（半成品，如：烧鹅皮水、烧鹅腌料）
 *           ├── recipe_component_ingredients（半成品原料，name 引用原料库）
 *           └── recipe_component_steps（半成品工艺步骤）
 *
 * 保密原则：所有接口严格限 admin / hq_manager / store_manager / store_production_manager
 *           员工端无任何配方访问途径
 */

import { pool as getPool } from './utils/database.js';
function pool() { return getPool(); }

// ─── Schema ───────────────────────────────────────────────
export async function ensureRecipeSchema() {
  try {
    // 迁移：如果存在旧的单层 recipe_ingredients 表则删除（建立初期无数据）
    await pool().query(`DROP TABLE IF EXISTS recipe_ingredients`);

    // 原料分类
    await pool().query(`
      CREATE TABLE IF NOT EXISTS ingredient_categories (
        id         BIGSERIAL PRIMARY KEY,
        name       VARCHAR(100) NOT NULL UNIQUE,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 原料库
    await pool().query(`
      CREATE TABLE IF NOT EXISTS ingredient_library (
        id           BIGSERIAL PRIMARY KEY,
        name         VARCHAR(255) NOT NULL UNIQUE,
        category     VARCHAR(100),
        brand        VARCHAR(100),
        spec         VARCHAR(200),
        default_unit VARCHAR(50),
        notes        TEXT,
        created_by   VARCHAR(120),
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // 迁移：为已有表补充 brand / spec 列
    await pool().query(`ALTER TABLE ingredient_library ADD COLUMN IF NOT EXISTS brand VARCHAR(100)`);
    await pool().query(`ALTER TABLE ingredient_library ADD COLUMN IF NOT EXISTS spec  VARCHAR(200)`);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS idx_ing_lib_name ON ingredient_library (name)
    `);

    // 产品配方头
    await pool().query(`
      CREATE TABLE IF NOT EXISTS recipes (
        id          BIGSERIAL PRIMARY KEY,
        dish_name   VARCHAR(255) NOT NULL,
        store       VARCHAR(200) NOT NULL DEFAULT '*',
        station     VARCHAR(100),
        version     VARCHAR(20)  NOT NULL DEFAULT '1.0',
        status      VARCHAR(20)  NOT NULL DEFAULT 'draft',
        notes       TEXT,
        created_by  VARCHAR(120),
        updated_by  VARCHAR(120),
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_recipe UNIQUE (dish_name, store, version)
      )
    `);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS idx_recipes_lookup
        ON recipes (dish_name, store, status)
    `);

    // 半成品（一个产品可有多个半成品）
    await pool().query(`
      CREATE TABLE IF NOT EXISTS recipe_components (
        id           BIGSERIAL PRIMARY KEY,
        recipe_id    BIGINT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
        name         VARCHAR(255) NOT NULL,
        notes        TEXT,
        sort_order   INT DEFAULT 0
      )
    `);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS idx_rc_recipe
        ON recipe_components (recipe_id, sort_order)
    `);

    // 半成品原料
    await pool().query(`
      CREATE TABLE IF NOT EXISTS recipe_component_ingredients (
        id              BIGSERIAL PRIMARY KEY,
        component_id    BIGINT NOT NULL REFERENCES recipe_components(id) ON DELETE CASCADE,
        ingredient_name VARCHAR(255) NOT NULL,
        quantity        DECIMAL(10,2),
        unit            VARCHAR(50),
        is_pack         BOOLEAN DEFAULT FALSE,
        notes           TEXT,
        sort_order      INT DEFAULT 0
      )
    `);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS idx_rci_component
        ON recipe_component_ingredients (component_id, sort_order)
    `);

    // 半成品工艺步骤
    await pool().query(`
      CREATE TABLE IF NOT EXISTS recipe_component_steps (
        id           BIGSERIAL PRIMARY KEY,
        component_id BIGINT NOT NULL REFERENCES recipe_components(id) ON DELETE CASCADE,
        step_seq     INT NOT NULL,
        instruction  TEXT NOT NULL,
        notes        TEXT,
        sort_order   INT DEFAULT 0
      )
    `);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS idx_rcs_component
        ON recipe_component_steps (component_id, step_seq)
    `);

    console.log('[Recipe] Schema ensured (v2: categories + ingredient_library + components + ingredients + steps)');
  } catch (e) {
    console.error('[Recipe] schema error:', e?.message);
  }
}

// ─── 管理员权限中间件 ──────────────────────────────────────
function isRecipeAdmin(role) {
  return ['admin', 'hq_manager', 'store_manager', 'store_production_manager'].includes(role);
}

// ─── 配方列表 ──────────────────────────────────────────────
async function listRecipes({ store }) {
  const rows = await pool().query(
    `SELECT r.id, r.dish_name, r.store, r.station, r.version, r.status,
            r.notes, r.created_by, r.updated_at,
            COUNT(rc.id) AS component_count
     FROM recipes r
     LEFT JOIN recipe_components rc ON rc.recipe_id = r.id
     WHERE r.store=$1 OR r.store='*'
     GROUP BY r.id
     ORDER BY r.dish_name, r.version DESC`,
    [store]
  );
  return rows.rows;
}

// ─── 单个配方（含半成品、原料、工艺）────────────────────────
async function getFullRecipe(id) {
  const rr = await pool().query(`SELECT * FROM recipes WHERE id=$1`, [id]);
  if (!rr.rows.length) return null;
  const recipe = rr.rows[0];

  const comps = await pool().query(
    `SELECT * FROM recipe_components WHERE recipe_id=$1 ORDER BY sort_order, id`,
    [id]
  );

  recipe.components = await Promise.all(comps.rows.map(async comp => {
    const ings = await pool().query(
      `SELECT * FROM recipe_component_ingredients
       WHERE component_id=$1 ORDER BY sort_order, id`,
      [comp.id]
    );
    const steps = await pool().query(
      `SELECT * FROM recipe_component_steps
       WHERE component_id=$1 ORDER BY step_seq, sort_order, id`,
      [comp.id]
    );
    return { ...comp, ingredients: ings.rows, steps: steps.rows };
  }));

  return recipe;
}

// ─── 保存配方（新建 or 更新）─────────────────────────────────
// components: [{ name, notes, ingredients:[{...}], steps:[{...}] }]
async function saveRecipe({ id, dishName, store, station, version, status, notes, components, username }) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');

    let recipeId = id ? Number(id) : null;

    if (recipeId) {
      await client.query(
        `UPDATE recipes
         SET dish_name=$1, store=$2, station=$3, version=$4,
             status=$5, notes=$6, updated_by=$7, updated_at=NOW()
         WHERE id=$8`,
        [dishName, store || '*', station || null, version || '1.0',
         status || 'active', notes || null, username, recipeId]
      );
      // 清空半成品（级联删除 ingredients + steps）
      await client.query(`DELETE FROM recipe_components WHERE recipe_id=$1`, [recipeId]);
    } else {
      const res = await client.query(
        `INSERT INTO recipes (dish_name, store, station, version, status, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         ON CONFLICT (dish_name, store, version) DO UPDATE
           SET status=EXCLUDED.status, notes=EXCLUDED.notes,
               updated_by=EXCLUDED.updated_by, updated_at=NOW()
         RETURNING id`,
        [dishName, store || '*', station || null, version || '1.0',
         status || 'active', notes || null, username]
      );
      recipeId = res.rows[0].id;
      // 如果是 upsert 命中冲突，也清空旧半成品
      await client.query(`DELETE FROM recipe_components WHERE recipe_id=$1`, [recipeId]);
    }

    // 插入半成品
    for (let ci = 0; ci < (components || []).length; ci++) {
      const comp = components[ci];
      if (!comp.name?.trim()) continue;

      const cr = await client.query(
        `INSERT INTO recipe_components (recipe_id, name, notes, sort_order)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [recipeId, comp.name.trim(), comp.notes?.trim() || null, ci]
      );
      const compId = cr.rows[0].id;

      // 原料
      for (let ii = 0; ii < (comp.ingredients || []).length; ii++) {
        const ing = comp.ingredients[ii];
        if (!ing.ingredient_name?.trim()) continue;
        await client.query(
          `INSERT INTO recipe_component_ingredients
             (component_id, ingredient_name, quantity, unit, is_pack, notes, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [compId, ing.ingredient_name.trim(),
           ing.quantity || null, ing.unit?.trim() || null,
           !!ing.is_pack, ing.notes?.trim() || null, ii]
        );
      }

      // 工艺步骤
      for (let si = 0; si < (comp.steps || []).length; si++) {
        const step = comp.steps[si];
        if (!step.instruction?.trim()) continue;
        await client.query(
          `INSERT INTO recipe_component_steps
             (component_id, step_seq, instruction, notes, sort_order)
           VALUES ($1,$2,$3,$4,$5)`,
          [compId, si + 1, step.instruction.trim(),
           step.notes?.trim() || null, si]
        );
      }
    }

    await client.query('COMMIT');
    return { success: true, id: recipeId };
  } catch (e) {
    await client.query('ROLLBACK');
    return { success: false, error: e?.message };
  } finally {
    client.release();
  }
}

// ─── 删除配方 ──────────────────────────────────────────────
async function deleteRecipe({ id, store }) {
  await pool().query(
    `DELETE FROM recipes WHERE id=$1 AND (store=$2 OR store='*')`,
    [id, store]
  );
  return { success: true };
}

// ─── 路由注册 ──────────────────────────────────────────────
export function registerRecipeRoutes(app, authMiddleware) {
  function requireRecipeAdmin(req, res, next) {
    if (!isRecipeAdmin(req.user?.role)) {
      return res.status(403).json({ error: '配方为机密资料，无访问权限' });
    }
    next();
  }

  // 配方列表
  app.get('/api/recipes', authMiddleware, requireRecipeAdmin, async (req, res) => {
    try {
      const store = req.user?.store || req.query.store || '*';
      res.json({ success: true, recipes: await listRecipes({ store }) });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // 单个配方完整详情
  app.get('/api/recipes/:id', authMiddleware, requireRecipeAdmin, async (req, res) => {
    try {
      const recipe = await getFullRecipe(req.params.id);
      if (!recipe) return res.json({ success: false, error: '配方不存在' });
      res.json({ success: true, recipe });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // 新建 / 更新配方
  app.post('/api/recipes', authMiddleware, requireRecipeAdmin, async (req, res) => {
    try {
      const { id, dishName, store, station, version, status, notes, components } = req.body;
      if (!dishName?.trim()) return res.json({ success: false, error: '菜品名称必填' });
      const result = await saveRecipe({
        id, dishName, store: store || req.user?.store,
        station, version, status, notes, components,
        username: req.user?.username
      });
      res.json(result);
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // 删除配方
  app.delete('/api/recipes/:id', authMiddleware, requireRecipeAdmin, async (req, res) => {
    try {
      await deleteRecipe({ id: req.params.id, store: req.user?.store || '*' });
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // ── 配方：出品经理可见的半成品组成（名称，不含原料和工艺）──
  app.get('/api/recipes/components/by-dish', authMiddleware, requireRecipeAdmin, async (req, res) => {
    try {
      const dish = req.query.dish;
      if (!dish) return res.json({ success: false, error: 'dish参数必填' });
      const rows = await pool().query(
        `SELECT rc.name, rc.notes
         FROM recipe_components rc
         JOIN recipes r ON r.id = rc.recipe_id
         WHERE r.dish_name = $1 AND r.status = 'active'
         ORDER BY rc.sort_order, rc.id`,
        [dish]
      );
      res.json({ success: true, components: rows.rows });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // ── 配方：审核通过 ────────────────────────────────────────
  app.post('/api/recipes/:id/approve', authMiddleware, requireRecipeAdmin, async (req, res) => {
    try {
      await pool().query(
        `UPDATE recipes SET status='active', updated_by=$1, updated_at=NOW() WHERE id=$2`,
        [req.user?.username, req.params.id]
      );
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // ── 原料分类：列表 ────────────────────────────────────────
  app.get('/api/ingredient-categories', authMiddleware, requireRecipeAdmin, async (req, res) => {
    try {
      const rows = await pool().query(
        `SELECT id, name, sort_order FROM ingredient_categories ORDER BY sort_order, name`
      );
      res.json({ success: true, categories: rows.rows });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // ── 原料分类：新建 ────────────────────────────────────────
  app.post('/api/ingredient-categories', authMiddleware, requireRecipeAdmin, async (req, res) => {
    try {
      const { name, sort_order } = req.body;
      if (!name?.trim()) return res.json({ success: false, error: '分类名称必填' });
      const result = await pool().query(
        `INSERT INTO ingredient_categories (name, sort_order) VALUES ($1,$2)
         ON CONFLICT (name) DO UPDATE SET sort_order=EXCLUDED.sort_order
         RETURNING id`,
        [name.trim(), Number(sort_order) || 0]
      );
      res.json({ success: true, id: result.rows[0].id });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // ── 原料分类：删除 ────────────────────────────────────────
  app.delete('/api/ingredient-categories/:id', authMiddleware, requireRecipeAdmin, async (req, res) => {
    try {
      await pool().query(`DELETE FROM ingredient_categories WHERE id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // ── 原料库：列表 ──────────────────────────────────────────
  app.get('/api/ingredients', authMiddleware, requireRecipeAdmin, async (req, res) => {
    try {
      const rows = await pool().query(
        `SELECT id, name, category, brand, spec, default_unit, notes, created_by, created_at
         FROM ingredient_library ORDER BY category NULLS LAST, name`
      );
      res.json({ success: true, ingredients: rows.rows });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // ── 原料库：新建 / 更新 ────────────────────────────────────
  app.post('/api/ingredients', authMiddleware, requireRecipeAdmin, async (req, res) => {
    try {
      const { name, category, brand, spec, default_unit, notes } = req.body;
      if (!name?.trim()) return res.json({ success: false, error: '原料名称必填' });
      const result = await pool().query(
        `INSERT INTO ingredient_library (name, category, brand, spec, default_unit, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (name) DO UPDATE
           SET category=EXCLUDED.category, brand=EXCLUDED.brand, spec=EXCLUDED.spec,
               default_unit=EXCLUDED.default_unit, notes=EXCLUDED.notes
         RETURNING id`,
        [name.trim(), category?.trim() || null, brand?.trim() || null,
         spec?.trim() || null, default_unit?.trim() || null,
         notes?.trim() || null, req.user?.username]
      );
      res.json({ success: true, id: result.rows[0].id });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  // ── 原料库：删除 ──────────────────────────────────────────
  app.delete('/api/ingredients/:id', authMiddleware, requireRecipeAdmin, async (req, res) => {
    try {
      await pool().query(`DELETE FROM ingredient_library WHERE id=$1`, [req.params.id]);
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, error: e?.message });
    }
  });

  console.log('[Recipe] Routes registered (admin-only, with categories + ingredient library)');
}
