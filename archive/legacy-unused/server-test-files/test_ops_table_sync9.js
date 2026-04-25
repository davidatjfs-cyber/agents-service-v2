import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const appToken = 'PTWrbUdcbarCshst0QncMoY7nKe';

const configs = {
  'opening_reports': 'tbl32E6d0CyvLvfi', // 开档报告
  'closing_reports': 'tblXYfSBRrgNGohN', // 收档报告
  'meeting_reports': 'tblZXgaU0LpSye2m', // 例会报告
  'material_majixian': 'tblz4kW1cY22XRlL', // 马己仙原料
  'material_hongchao': 'tbllcV1evqTJyzlN' // 洪潮原料
};

async function test() {
  const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: 'cli_a9fc0d13c838dcd6',
    app_secret: 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN'
  });
  const token = resp.data.tenant_access_token;
  
  for (const [name, tableId] of Object.entries(configs)) {
    try {
      const sortStr = '["日期 DESC"]';
      const res = await axios.get(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
        { 
          headers: { 'Authorization': `Bearer ${token}` },
          params: { page_size: 1, sort: sortStr }
        }
      );
      if (res.data?.data) {
        let dateVal = res.data.data.items[0]?.fields['日期'];
        let displayDate = dateVal;
        if (typeof dateVal === 'number') displayDate = new Date(dateVal).toLocaleDateString();
        
        console.log(`[${name}] OK, Total: ${res.data.data.total}, Latest Date: ${displayDate}`);
      }
    } catch (e) {
      console.error(`[${name}] Error:`, e.response?.data?.msg || e.message);
    }
  }
}
test();
