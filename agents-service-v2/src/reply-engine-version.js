/**
 * 确定性回复 / 管线重要逻辑变更时递增，便于用 GET /health 核对生产是否已部署新代码。
 * （与 package.json 版本独立，专用于「桌访/营业日报」等行为验收）
 */
export const REPLY_ENGINE_BUILD = '20260505A';
