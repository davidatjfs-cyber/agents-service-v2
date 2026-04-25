import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const configs = {
  'closing_reports': {
    appId: process.env.BITABLE_CLOSING_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_CLOSING_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_CLOSING_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_CLOSING_TABLE_ID || 'tblXYfSBRrgNGohN',
  },
  'opening_reports': {
    appId: process.env.BITABLE_OPENING_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_OPENING_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_OPENING_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_OPENING_TABLE_ID || 'tbl32E6d0CyvLvfi',
  }
};

async function getLarkTenantToken(config) {
  const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: config.appId,
    app_secret: config.appSecret
  });
  return resp.data.tenant_access_token;
}

async function test() {
  for (const [key, config] of Object.entries(configs)) {
    console.log(`Testing ${key}...`);
    try {
      const token = await getLarkTenantToken(config);
      const resp = await axios.get(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records`,
        { headers: { 'Authorization': `Bearer ${token}` }, params: { page_size: 5 } }
      );
      console.log(`[${key}] Total records:`, resp.data?.data?.total);
      if (resp.data?.data?.items?.length > 0) {
        console.log(`[${key}] Sample fields:`, Object.keys(resp.data.data.items[0].fields));
      }
    } catch (e) {
      console.error(`[${key}] Error:`, e.response?.data || e.message);
    }
  }
}
test();
