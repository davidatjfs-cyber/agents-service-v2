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
  
  // Try sorting by empty or specific fields
  const sortsToTest = [
    '["_id DESC"]',
    '["日期 DESC"]'
  ];
  
  for (const s of sortsToTest) {
    try {
      const res = await axios.get(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
        { 
          headers: { 'Authorization': `Bearer ${token}` },
          params: { page_size: 1, sort: s }
        }
      );
      console.log(`Sort ${s} success, latest record date:`, res.data.data.items[0].fields['日期']);
    } catch (e) {
      console.error(`Sort ${s} failed:`, e.response?.data?.msg || e.message);
    }
  }
}
test();
