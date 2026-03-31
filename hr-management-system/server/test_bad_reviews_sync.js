import dotenv from 'dotenv';
import pg from 'pg';
import { processBitableData } from './agents.js';
import axios from 'axios';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function test() {
  const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: 'cli_a9fc0d13c838dcd6',
    app_secret: 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN'
  });
  const token = resp.data.tenant_access_token;
  
  const res = await axios.get(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/PTWrbUdcbarCshst0QncMoY7nKe/tables/tblgReexNjWJOJB6/records`,
    { 
      headers: { 'Authorization': `Bearer ${token}` },
      params: { page_size: 5, sort: '["创建日期 DESC"]' }
    }
  );
  
  console.log("Records to process:", res.data.data.items.length);
  global.pool = () => pool;
  await processBitableData('bad_reviews', res.data.data.items);
  console.log("Done processing");
  await pool.end();
}
test();
