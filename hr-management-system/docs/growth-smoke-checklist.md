# Growth Module Smoke Checklist

## Scope
- Verify growth module visibility is limited to `admin` and `hq_manager`.
- Verify growth dashboard and management tabs render and load data.
- Verify create flows for public content and poster asset management.

## Permission
- Log in as `admin`: growth nav should be visible on desktop and mobile entry.
- Log in as `hq_manager` / `总部营运`: growth nav should be visible.
- Log in as store roles or employee roles: growth nav should be hidden.
- Directly open `showPage('growth')` as unauthorized user: should show `无权限访问` and not render the page.

## Dashboard
- Open Growth > `看板`: KPI cards should render.
- Confirm alerts panel loads without console errors.
- Change store filter and campaign filter: dashboard should refresh successfully.

## WeCom
- Open `企微客户`: stats list loads.
- Customer list loads and filtering remains usable.

## Campaigns
- Open `活动管理`: plan list loads.
- Activity rows display localized store / channel / audience / status labels.

## Profiles
- Open `用户画像`: list loads.
- Confirm POS-linked customers show spend / order summary when available.

## Constraints
- Open `营销约束`: list loads.
- Save one constraint and confirm it persists after reload.
- Open `品牌声音训练`: save sample copy and confirm it can be loaded again.

## Public Content
- Open `公域品宣`: channel list loads.
- Create one channel and confirm it appears in the list.
- Create one promo task and confirm it appears in the task list.
- Create one content calendar item and confirm it appears in upcoming content.
- Open channel effects and confirm counts / revenue render without `undefined`.

## Posters
- Open `海报`: template selector renders.
- Click `AI 生成文案`: title / subtitle / offer / CTA should autofill.
- Save one poster and confirm it appears in poster history.
- Save one poster template meta record and confirm it appears in template library.
- Save one creative asset and confirm it appears in creative asset list.

## POS
- Open `POS消费`: KPI cards, profile insights, repeat stats, hour chart, payment cards, top dishes, and store ranking cards should all render.
- Confirm store cards are ranked by revenue and show contribution percentage.
- Change day filter and confirm data reloads.

## Regression Notes
- `brand_voice_samples` is now DB-backed; restart service and confirm samples remain.
- `active-window` should return one consolidated response shape.
- Re-running POS sync should not duplicate `pos_order_items` rows.
