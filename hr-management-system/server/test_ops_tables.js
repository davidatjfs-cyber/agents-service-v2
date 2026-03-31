import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const appId = process.env.BITABLE_OPS_APP_ID || 'cli_a91dae9f9578dcb1';
const appSecret = process.env.BITABLE_OPS_APP_SECRET || 'sjpAzPwu4KixvhbAOD7w4ee1oEKRRBQF';
const appToken = process.env.BITABLE_OPS_APP_TOKEN || 'PtVObRtoPaMAP3stIIFc8DnJngd';

async function test() {
  const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: appId,
    app_secret: appSecret
  });
  const token = resp.data.tenant_access_token;
  
  let pageToken = '';
  let hasMore = true;
  
  console.log(`All Tables in Bitable ${appToken}:`);
  while(hasMore) {
    try {
      const res = await axios.get(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables`,
        { 
          headers: { 'Authorization': `Bearer ${token}` },
          params: { page_size: 100, page_token: pageToken }
        }
      );
      res.data.data.items.forEach(t => console.log(`- ${t.name} (${t.table_id})`));
      hasMore = res.data.data.has_more;
      pageToken = res.data.data.page_token;
    } catch (e) {
      console.error(`Error:`, e.response?.data || e.message);
      break;
    }
  }
}
test();
