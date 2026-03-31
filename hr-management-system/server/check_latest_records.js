import dotenv from 'dotenv';
import pg from 'pg';
const { Pool } = pg;

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function checkLatest() {
  try {
    try {
      const tv = await pool.query('SELECT date FROM table_visit ORDER BY date DESC LIMIT 1');
      console.log('桌访表 (table_visit) 最新日期:', tv.rows.length ? tv.rows[0].date : '无记录');
    } catch (e) {
      console.log('桌访表 (table_visit) 查询失败:', e.message);
    }

    try {
      const nr = await pool.query('SELECT date FROM negative_reviews ORDER BY date DESC LIMIT 1');
      console.log('差评报告 (negative_reviews) 最新日期:', nr.rows.length ? nr.rows[0].date : '无记录');
    } catch (e) {
      console.log('差评报告查询失败:', e.message);
    }

    try {
      const openReport = await pool.query("SELECT date FROM daily_reports WHERE type = '开档' ORDER BY date DESC LIMIT 1");
      console.log('开档报告 (daily_reports) 最新日期:', openReport.rows.length ? openReport.rows[0].date : '无记录');
    } catch (e) {
      console.log('开档报告查询失败:', e.message);
    }

    try {
      const closeReport = await pool.query("SELECT date FROM daily_reports WHERE type = '收档' ORDER BY date DESC LIMIT 1");
      console.log('收档报告 (daily_reports) 最新日期:', closeReport.rows.length ? closeReport.rows[0].date : '无记录');
    } catch (e) {
      console.log('收档报告查询失败:', e.message);
    }

    try {
      const ops = await pool.query('SELECT submission_time FROM ops_checklist ORDER BY submission_time DESC LIMIT 1');
      console.log('营运检查表 (ops_checklist) 最新日期:', ops.rows.length ? ops.rows[0].submission_time : '无记录');
    } catch (e) {
      console.log('营运检查表查询失败:', e.message);
    }

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

checkLatest();
