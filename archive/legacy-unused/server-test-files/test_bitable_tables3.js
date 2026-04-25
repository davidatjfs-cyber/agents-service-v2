import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const appId = 'cli_a9fc0d13c838dcd6';
const appSecret = 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN';
const appToken = 'PTWrbUdcbarCshst0QncMoY7nKe';

async function test() {
  const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: appId,
    app_secret: appSecret
  });
  const token = resp.data.tenant_access_token;
  
  let pageToken = '';
  let hasMore = true;
  
  console.log("All Tables in Bitable PTWrbUdcbarCshst0QncMoY7nKe:");
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
