import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const appToken = 'PTWrbUdcbarCshst0QncMoY7nKe';
const tableId = 'tblgReexNjWJOJB6'; // 差评报告DB

async function test() {
  const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: 'cli_a9fc0d13c838dcd6',
    app_secret: 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN'
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
    console.log("差评报告DB 总记录数:", res.data.data.total);
    if (res.data.data.total > 0) {
      console.log("最新一条记录字段:", res.data.data.items[0].fields);
    }
  } catch (e) {
    console.error(`Error:`, e.response?.data?.msg || e.message);
  }
}
test();
