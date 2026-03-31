import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const configs = {
  'table_visit': 'tblpx5Efqc6eHo3L',
  'closing_reports': 'tblXYfSBRrgNGohN',
  'opening_reports': 'tbl32E6d0CyvLvfi',
  'meeting_reports': 'tblZXgaU0LpSye2m',
  'material_majixian': 'tblz4kW1cY22XRlL',
  'material_hongchao': 'tbllcV1evqTJyzlN'
};

const appToken = 'PTWrbUdcbarCshst0QncMoY7nKe';

async function test() {
  const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: 'cli_a9fc0d13c838dcd6',
    app_secret: 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN'
  });
  const token = resp.data.tenant_access_token;
  
  for (const [key, tableId] of Object.entries(configs)) {
    try {
      const res = await axios.get(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
        { headers: { 'Authorization': `Bearer ${token}` }, params: { page_size: 1 } }
      );
      if (res.data?.data) {
        console.log(`[${key}] Success! Total:`, res.data.data.total);
      } else {
        console.error(`[${key}] Failed:`, res.data);
      }
    } catch (e) {
      console.error(`[${key}] Error:`, e.response?.data?.msg || e.message);
    }
  }
}
test();
