import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const appToken = 'PTWrbUdcbarCshst0QncMoY7nKe';
const tableId = 'tblpx5Efqc6eHo3L';

async function test() {
  const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: 'cli_a9fc0d13c838dcd6',
    app_secret: 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN'
  });
  const token = resp.data.tenant_access_token;
  
  const res = await axios.get(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    { 
      headers: { 'Authorization': `Bearer ${token}` },
      params: { page_size: 1 }
    }
  );
  console.log("Fields in 桌访表:", Object.keys(res.data.data.items[0].fields));
}
test();
