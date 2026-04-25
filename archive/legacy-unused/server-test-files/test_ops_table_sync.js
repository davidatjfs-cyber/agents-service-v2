import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const appToken = 'PTWrbUdcbarCshst0QncMoY7nKe';
const tableId = 'tblpx5Efqc6eHo3L'; // 桌访表

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
    console.log("桌访表最新一条记录:");
    console.log(res.data.data.items[0].fields);
  } catch (e) {
    console.error(`Error:`, e.response?.data?.msg || e.message);
  }
}
test();
