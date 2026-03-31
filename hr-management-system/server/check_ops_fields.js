import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const appId = process.env.BITABLE_OPS_APP_ID || 'cli_a91dae9f9578dcb1';
const appSecret = process.env.BITABLE_OPS_APP_SECRET || 'sjpAzPwu4KixvhbAOD7w4ee1oEKRRBQF';
const appToken = process.env.BITABLE_OPS_APP_TOKEN || 'PtVObRtoPaMAP3stIIFc8DnJngd';
const tableId = 'tblxHI9ZAKONOTpp';

async function test() {
  const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: appId,
    app_secret: appSecret
  });
  const token = resp.data.tenant_access_token;
  
  const res = await axios.get(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    { 
      headers: { 'Authorization': `Bearer ${token}` },
      params: { page_size: 5 }
    }
  );
  res.data.data.items.forEach(item => {
    console.log(`Record checkType: ${item.fields['检查类型']}, Store: ${item.fields['所属门店']}`);
  });
}
test();
