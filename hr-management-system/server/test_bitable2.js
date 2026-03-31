import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const config = {
  appId: process.env.BITABLE_CLOSING_APP_ID || 'cli_a9fc0d13c838dcd6',
  appSecret: process.env.BITABLE_CLOSING_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
  appToken: process.env.BITABLE_CLOSING_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
  tableId: process.env.BITABLE_CLOSING_TABLE_ID || 'tblXYfSBRrgNGohN',
};

async function test() {
  const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: config.appId,
    app_secret: config.appSecret
  });
  const token = resp.data.tenant_access_token;
  console.log("Token:", token.substring(0, 10) + '...');
  
  try {
    const res = await axios.get(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records`,
      { headers: { 'Authorization': `Bearer ${token}` }, params: { page_size: 5 } }
    );
    console.log("Data:", JSON.stringify(res.data, null, 2).substring(0, 500));
  } catch (e) {
    console.error("Error:", e.response?.data || e.message);
  }
}
test();
