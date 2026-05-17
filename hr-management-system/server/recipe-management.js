/**
 * 配方管理模块
 * 功能：配方录入/版本管理 + 按步骤嵌入打点卡用料提示
 *
 * 保密机制：
 *   - 配方管理页：仅 admin / hq_manager / store_manager 可访问
 *   - 员工打点卡：/api/recipes/step-hint 仅返回当前步骤用料，不暴露全配方
 *   - 将来切料包：is_pack=true 时显示料包名，不改结构
 */

import { pool as getPool } from './utils/database.js';
function pool() { return getPool(); }

// ─── Schema ───────────────────────────────────────────────
export async function ensureRecipeSchema() {
  try {
    // 配方头表
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
        created_at  TIMESTAMPTZ  DEFAULT NOW(),
        updated_at  TIMESTAMPTZ  DEFAULT NOW(),
        CONSTRAINT uq_recipe UNIQUE (dish_name, store, version)
      )
    `);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS idx_recipes_lookup
        ON recipes (dish_name, store, status)
    `);

    // 原料明细表
    await pool().query(`
      CREATE TABLE IF NOT EXISTS recipe_ingredients (
        id              BIGSERIAL PRIMARY KEY,
        recipe_id       BIGINT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
        step_seq_ref    INT,
        ingredient_name VARCHAR(255) NOT NULL,
        quantity        DECIMAL(10,2),
        unit            VARCHAR(50),
        is_pack         BOOLEAN DEFAULT FALSE,
        notes           TEXT,
        sort_order      INT DEFAULT 0
      )
    `);
    await pool().query(`
      CREATE INDEX IF NOT EXISTS idx_ri_recipe
        ON recipe_ingredients (recipe_id, step_seq_ref)
    `);

    console.log('[Recipe] Schema ensured');
  } catch (e) {
    console.error('[Recipe] schema error:', e?.message);
  }
}

// ─── 查询：配方列表 ────────────────────────────────────────
export async function listRecipes({ store }) {
  try {
    const rows = await pool().query(
      `SELECT r.id, r.dish_name, r.store, r.station, r.version, r.status,
              r.notes, r.created_by, r.updated_at,
              COUNT(ri.id) AS ingredient_count
       FROM recipes r
       LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
       WHERE r.store=$1 OR r.store='*'
       GROUP BY r.id
       ORDER BY r.dish_name, r.version DESC`,
      [store]
    );
    return { success: true, recipes: rows.rows };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

// ─── 查询：单个配方（完整原料，仅管理员） ──────────────────
export async function getRecipe({ id }) {
  try {
    const r = await pool().query(
      `SELECT * FROM recipes WHERE id=$1`, [id]
    );
    if (!r.rows.length) return { success: false, error: '配方不存在' };
    const recipe = r.rows[0];

    const items = await pool().query(
      `SELECT * FROM recipe_ingredients
       WHERE recipe_id=$1
       ORDER BY COALESCE(step_seq_ref, 9999), sort_order, id`,
      [id]
    );
    recipe.ingredients = items.rows;
    return { success: true, recipe };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

// ─── 操作：新建或更新配方 ──────────────────────────────────
export async function saveRecipe({ id, dishName, store, station, version, status, notes, ingredients, username }) {
  try {
    let recipeId = id;

    if (recipeId) {
      // 更新配方头
      await pool().query(
        `UPDATE recipes
         SET dish_name=$1, store=$2, station=$3, version=$4, status=$5,
             notes=$6, updated_by=$7, updated_at=NOW()
         WHERE id=$8`,
        [dishName, store || '*', station || null, version || '1.0',
         status || 'active', notes || null, username, recipeId]
      );
      // 清空旧原料，重新插入（简单可靠）
      await pool().query(`DELETE FROM recipe_ingredients WHERE recipe_id=$1`, [recipeId]);
    } else {
      // 新建配方头
      const res = await pool().query(
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
    }

    // 插入原料明细
    if (Array.isArray(ingredients)) {
      for (let i = 0; i < ingredients.length; i++) {
        const item = ingredients[i];
        if (!item.ingredient_name?.trim()) continue;
        await pool().query(
          `INSERT INTO recipe_ingredients
             (recipe_id, step_seq_ref, ingredient_name, quantity, unit, is_pack, notes, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [recipeId,
           item.step_seq_ref || null,
           item.ingredient_name.trim(),
           item.quantity || null,
           item.unit?.trim() || null,
           !!item.is_pack,
           item.notes?.trim() || null,
           i]
        );
      }
    }

    return { success: true, id: recipeId };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

// ─── 操作：删除配方 ────────────────────────────────────────
export async function deleteRecipe({ id, store }) {
  try {
    await pool().query(
      `DELETE FROM recipes WHERE id=$1 AND (store=$2 OR store='*')`,
      [id, store]
    );
    return { success: true };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

// ─── 打点卡接口：仅返回某步骤的用料（员工可见）─────────────
// 不暴露其他步骤，不暴露 recipe_id，防止遍历
export async function getStepIngredients({ dishName, store, stepSeq }) {
  try {
    const storeKey = store || '*';
    // 取当前门店或通用配方，优先门店专属
    const r = await pool().query(
      `SELECT id FROM recipes
       WHERE dish_name=$1 AND (store=$2 OR store='*') AND status='active'
       ORDER BY (CASE WHEN store=$2 THEN 0 ELSE 1 END)
       LIMIT 1`,
      [dishName, storeKey]
    );
    if (!r.rows.length) return { success: true, ingredients: [] };

    const recipeId = r.rows[0].id;
    const items = await pool().query(
      `SELECT ingredient_name, quantity, unit, is_pack, notes
       FROM recipe_ingredients
       WHERE recipe_id=$1 AND step_seq_ref=$2
       ORDER BY sort_order, id`,
      [recipeId, stepSeq]
    );
    return { success: true, ingredients: items.rows };
  } catch (e) {
    return { success: false, error: e?.message };
  }
}

// ─── 路由注册 ──────────────────────────────────────────────
export function registerRecipeRoutes(app, authMiddleware) {
  // 管理员权限校验
  function requireManager(req, res, next) {
    const role = req.user?.role;
    if (!['admin', 'hq_manager', 'store_manager', 'store_production_manager'].includes(role)) {
      return res.status(403).json({ error: '无权访问配方管理' });
    }
    next();
  }

  // 配方列表（管理员）
  app.get('/api/recipes', authMiddleware, requireManager, async (req, res) => {
    const store = req.user?.store || req.query.store || '*';
    res.json(await listRecipes({ store }));
  });

  // 单个配方详情（管理员）
  app.get('/api/recipes/:id', authMiddleware, requireManager, async (req, res) => {
    res.json(await getRecipe({ id: req.params.id }));
  });

  // 新建/更新配方（管理员）
  app.post('/api/recipes', authMiddleware, requireManager, async (req, res) => {
    const { id, dishName, store, station, version, status, notes, ingredients } = req.body;
    const username = req.user?.username;
    res.json(await saveRecipe({ id, dishName, store: store || req.user?.store, station, version, status, notes, ingredients, username }));
  });

  // 删除配方（管理员）
  app.delete('/api/recipes/:id', authMiddleware, requireManager, async (req, res) => {
    const store = req.user?.store || '*';
    res.json(await deleteRecipe({ id: req.params.id, store }));
  });

  // 打点卡步骤用料（所有已登录员工，仅当前步骤）
  app.get('/api/recipes/step-hint', authMiddleware, async (req, res) => {
    const { dishName, store, stepSeq } = req.query;
    res.json(await getStepIngredients({
      dishName,
      store: store || req.user?.store,
      stepSeq: Number(stepSeq)
    }));
  });

  console.log('[Recipe] Routes registered');
}
