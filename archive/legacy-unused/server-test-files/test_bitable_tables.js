import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const appId = process.env.BITABLE_TABLEVISIT_APP_ID || 'cli_a9fc0d13c838dcd6';
const appSecret = process.env.BITABLE_TABLEVISIT_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN';
const appToken = process.env.BITABLE_TABLEVISIT_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe';

async function test() {
  const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: appId,
    app_secret: appSecret
  });
  const token = resp.data.tenant_access_token;
  
  try {
    const res = await axios.get(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    console.log("Tables:");
    res.data.data.items.forEach(t => console.log(`- ${t.name} (${t.table_id})`));
  } catch (e) {
    console.error(`Error:`, e.response?.data || e.message);
  }
}
test();
