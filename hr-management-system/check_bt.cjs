const {Pool}=require('pg');
const p=new Pool({connectionString:'postgres://hrms:Abc1234567!@127.0.0.1:5432/hrms'});
(async()=>{
  try {
    const tables=['tblXYfSBRrgNGohN','tbltSvY7SBTr3Sw8','tbl32E6d0CyvLvfi'];
    for(const t of tables){
      const s=await p.query('SELECT fields FROM feishu_generic_records WHERE table_id=$1 LIMIT 1',[t]);
      if(s.rows[0]) console.log(t+': '+Object.keys(s.rows[0].fields||{}).join(', '));
    }
    const v=await p.query("SELECT store, date::text, efficiency, dine_orders, dine_traffic FROM daily_reports WHERE date >= $1 ORDER BY date DESC LIMIT 6",['2026-03-10']);
    console.log('\n=== DAILY_REPORTS VERIFIED ===');
    for(const r of v.rows) console.log('  '+r.date+' | '+r.store+' | eff='+r.efficiency+' | ord='+r.dine_orders+' | traf='+r.dine_traffic);
    await p.end();
  } catch(e) { console.error('ERR:', e.message); await p.end(); }
})();
