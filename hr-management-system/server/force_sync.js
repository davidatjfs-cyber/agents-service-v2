import dotenv from 'dotenv';
import axios from 'axios';
import { Pool } from 'pg';
dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
          params: { page_size: 5, sort: sortStr }
        }
      );
      if (res.data?.data) {
        for (const item of res.data.data.items) {
          if (name === 'table_visit') {
            await pool.query(`
              INSERT INTO agent_messages (direction, channel, content_type, content, agent_data, record_id)
              VALUES ('in','feishu','table_visit',$1,$2::jsonb,$3)
              ON CONFLICT (record_id) DO UPDATE SET agent_data = EXCLUDED.agent_data, updated_at = CURRENT_TIMESTAMP
            `, [
              `桌访数据提交 - ${item.fields['所属门店']} 桌${item.fields['桌号']}`,
              JSON.stringify({
                recordId: item.record_id,
                date: item.fields['日期'],
                store: item.fields['所属门店'],
                tableNumber: item.fields['桌号']
              }),
              item.record_id
            ]);
          } else if (name === 'bad_reviews') {
            let dateVal = item.fields['差评日期'] || item.fields['创建日期'];
            await pool.query(`
              INSERT INTO agent_messages (direction, channel, content_type, content, agent_data, record_id)
              VALUES ('in','feishu','negative_review',$1,$2::jsonb,$3)
              ON CONFLICT (record_id) DO UPDATE SET agent_data = EXCLUDED.agent_data, updated_at = CURRENT_TIMESTAMP
            `, [
              `差评记录 - ${item.fields['差评门店']}`,
              JSON.stringify({
                recordId: item.record_id,
                date: dateVal,
                store: item.fields['差评门店']
              }),
              item.record_id
            ]);
          }
        }
        console.log(`[${name}] Forced synced 5 latest records.`);
      }
    } catch (e) {
      console.error(`[${name}] Error:`, e.response?.data?.msg || e.message);
    }
  }
  await pool.end();
}
test();
