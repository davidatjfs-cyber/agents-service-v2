export function buildSalesReport(rows,store,period){
if(!rows.length)return'';
const bL={dinein:'堂食',takeaway:'外卖'},sL={lunch:'午市',afternoon:'下午茶',dinner:'晚市'};
const byBiz={},prodTot={};
for(const r of rows){
const b=String(r.bizType||''),s=String(r.slot||''),k=`${b}|${s}`;
if(!byBiz[k])byBiz[k]={b,s,rev:0,n:0};
byBiz[k].rev+=Number(r.actualRevenue||0);byBiz[k].n+=1;
const pq=r.productQuantities;
if(pq&&typeof pq==='object')for(const[p,q]of Object.entries(pq)){
if(/卤鹅/.test(p))continue;
const k2=`${b}|${p}`;if(!prodTot[k2])prodTot[k2]={b,p,q:0};prodTot[k2].q+=Number(q||0);
}}
const tot=Object.values(byBiz).reduce((s,x)=>s+x.rev,0);
const lines=[`📦 ${period.label}销售明细（${store}）`,`共${rows.length}条，总营收¥${tot.toLocaleString()}`,'','【堂食/外卖×时段】'];
Object.values(byBiz).sort((a,b)=>b.rev-a.rev).forEach(x=>{
const pct=tot>0?((x.rev/tot)*100).toFixed(1):'0';
lines.push(`- ${bL[x.b]||x.b} ${sL[x.s]||x.s}：¥${x.rev.toLocaleString()}（${pct}%，${x.n}天）`);
});
lines.push('','【热销菜品TOP10-堂食】');
Object.values(prodTot).filter(x=>x.b==='dinein').sort((a,b)=>b.q-a.q).slice(0,10).forEach((x,i)=>{lines.push(`${i+1}. ${x.p}（${x.q}份）`);});
lines.push('','【热销菜品TOP10-外卖】');
Object.values(prodTot).filter(x=>x.b==='takeaway').sort((a,b)=>b.q-a.q).slice(0,10).forEach((x,i)=>{lines.push(`${i+1}. ${x.p}（${x.q}份）`);});
return lines.join('\n');
}
