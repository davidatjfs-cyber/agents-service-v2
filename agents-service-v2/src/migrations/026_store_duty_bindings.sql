CREATE TABLE IF NOT EXISTS store_duty_bindings (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(120) NOT NULL,
  store VARCHAR(160) NOT NULL,
  access_level VARCHAR(40) NOT NULL DEFAULT 'support',
  is_primary_store BOOLEAN NOT NULL DEFAULT FALSE,
  can_receive_ops BOOLEAN NOT NULL DEFAULT FALSE,
  can_receive_performance BOOLEAN NOT NULL DEFAULT FALSE,
  can_receive_food_safety BOOLEAN NOT NULL DEFAULT FALSE,
  can_receive_approval BOOLEAN NOT NULL DEFAULT FALSE,
  can_handle_ops BOOLEAN NOT NULL DEFAULT FALSE,
  can_handle_food_safety BOOLEAN NOT NULL DEFAULT FALSE,
  can_approve_hrms BOOLEAN NOT NULL DEFAULT FALSE,
  can_view_employees BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from TIMESTAMPTZ NULL,
  effective_to TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (username, store)
);

CREATE INDEX IF NOT EXISTS idx_store_duty_bindings_lookup
  ON store_duty_bindings (LOWER(username), LOWER(store), enabled);
