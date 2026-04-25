import dotenv from 'dotenv';
import axios from 'axios';
import { Pool } from 'pg';
dotenv.config();

const appToken = 'PTWrbUdcbarCshst0QncMoY7nKe';

const configs = {
  'table_visit': 'tblpx5Efqc6eHo3L', // 桌访表
  'bad_reviews': 'tblgReexNjWJOJB6', // 差评报告
};

async function test() {
  const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: 'cli_a9fc0d13c838dcd6',
    app_secret: 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN'
  });
  const token = resp.data.tenant_access_token;
  
  for (const [name, tableId] of Object.entries(configs)) {
    try {
      const sortStr = name === 'table_visit' ? '["日期 DESC"]' : '["创建日期 DESC"]';
      const res = await axios.get(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
        { 
          headers: { 'Authorization': `Bearer ${token}` },
          params: { page_size: 1, sort: sortStr }
        }
      );
      if (res.data?.data) {
        let dateField = '日期';
        if (name === 'bad_reviews') dateField = '差评日期';
        
        let dateVal = res.data.data.items[0]?.fields[dateField];
        if (name === 'bad_reviews' && !dateVal) dateVal = res.data.data.items[0]?.fields['创建日期'];
        
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
