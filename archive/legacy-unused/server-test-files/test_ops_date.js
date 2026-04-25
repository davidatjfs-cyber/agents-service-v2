import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const appId = process.env.BITABLE_OPS_APP_ID || 'cli_a91dae9f9578dcb1';
const appSecret = process.env.BITABLE_OPS_APP_SECRET || 'sjpAzPwu4KixvhbAOD7w4ee1oEKRRBQF';
const appToken = process.env.BITABLE_OPS_APP_TOKEN || 'PtVObRtoPaMAP3stIIFc8DnJngd';
const tableId = process.env.BITABLE_OPS_TABLE_ID || 'tblxHI9ZAKONOTpp';

async function test() {
  const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: appId,
    app_secret: appSecret
  });
  const token = resp.data.tenant_access_token;
  
  try {
    const res = await axios.get(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      { 
        headers: { 'Authorization': `Bearer ${token}` },
        params: { page_size: 1, sort: '["_id DESC"]' }
      }
    );
    console.log("营运检查表 总记录数:", res.data.data.total);
    if (res.data.data.total > 0) {
      console.log("最新一条记录 日期/创建时间:", new Date(res.data.data.items[0].created_time).toLocaleString());
    }
  } catch (e) {
    console.error(`Error:`, e.response?.data?.msg || e.message);
  }
}
test();
