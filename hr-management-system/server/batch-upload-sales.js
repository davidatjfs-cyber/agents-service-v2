import 'dotenv/config';
import pg from 'pg';
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { parseSalesRawRows, insertSalesRawRows, setSalesRawPool } from './sales-raw-upload.js';

const DIR = '/Users/xieding/Desktop/HRMS';
const F = [
  ['洪潮1月1-31日.xlsx', '洪潮大宁久光店', 'dinein'],
  ['洪潮2月1-15日.xlsx', '洪潮大宁久光店', 'dinein'],
  ['洪潮2月16-17.xlsx', '洪潮大宁久光店', 'dinein'],
  ['洪潮2月18-22.xlsx', '洪潮大宁久光店', 'dinein'],
  ['马己仙堂食1月1-15日.xlsx', '马己仙上海音乐广场店', 'dinein'],
  ['马己仙堂食1月16-31日.xlsx', '马己仙上海音乐广场店', 'dinein'],
  ['马己仙堂食2月1-17日new.xlsx', '马己仙上海音乐广场店', 'dinein'],
  ['马己仙堂食2月18-22 .xlsx', '马己仙上海音乐广场店', 'dinein'],
  ['马己仙外卖1月1-15日.xlsx', '马己仙上海音乐广场店', 'takeaway'],
  ['马己仙外卖1月16-31日.xlsx', '马己仙上海音乐广场店', 'takeaway'],
  ['马己仙外卖2月1-17日.xlsx', '马己仙上海音乐广场店', 'takeaway'],
  ['马己仙外卖2月18-22日new.xlsx', '马己仙上海音乐广场店', 'takeaway'],
];

(async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  setSalesRawPool(pool);
  let total = 0;
  for (const [file, store, biz] of F) {
    const fp = path.join(DIR, file);
    if (!fs.existsSync(fp)) { console.warn('SKIP missing:', file); continue; }
    console.log('\n>>', file, '->', store, '/', biz);
    const wb = XLSX.readFile(fp, { raw: false });
    let parsed = [];
    for (const sn of wb.SheetNames) {
      const mx = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: '' });
      const out = parseSalesRawRows(mx, biz, store);
      if (out.length) { parsed = out; break; }
    }
    if (!parsed.length) { console.warn('NO ROWS in', file); continue; }
    parsed.forEach(r => { r.biz_type = biz; r.store = store; });
    const dates = [...new Set(parsed.map(r => r.date).filter(Boolean))].sort();
    console.log('  dates:', dates[0], '~', dates[dates.length - 1], ', rows:', parsed.length);
    const ret = await insertSalesRawRows(parsed, store, biz, dates[0], dates[dates.length - 1]);
    console.log('  result: deleted', ret.deleted, ', inserted', ret.inserted);
    total += ret.inserted;
  }
  console.log('\n=== DONE total inserted:', total, '===');
  await pool.end();
})();
