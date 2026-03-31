import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const configs = {
  'ops_checklist': {
    appToken: 'PtVObRtoPaMAP3stIIFc8DnJngd',
    tableId: 'tblxHI9ZAKONOTpp'
  }
};

async function test() {
  const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: 'cli_a91dae9f9578dcb1',
    app_secret: 'sjpAzPwu4KixvhbAOD7w4ee1oEKRRBQF'
  });
  const token = resp.data.tenant_access_token;
  
  const res = await axios.get(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${configs.ops_checklist.appToken}/tables/${configs.ops_checklist.tableId}/records`,
    { 
      headers: { 'Authorization': `Bearer ${token}` },
      params: { page_size: 1, sort: '["_id DESC"]' }
    }
  );
  console.log(`[ops_checklist] OK, Total: ${res.data.data.total}`);
  console.log(`[ops_checklist] Latest Date:`, res.data.data.items[0]?.fields['提交日期']);
}
test();
