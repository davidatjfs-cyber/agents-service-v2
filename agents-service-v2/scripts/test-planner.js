import 'dotenv/config';
import { planAndExecute } from '../src/services/master-planner.js';

async function runCase(text, store) {
  const r = await planAndExecute(text, { store, username: 'test', role: 'store_manager' });
  console.log('---');
  console.log('input:', text);
  console.log('mode:', r?.mode, 'agent:', r?.agent);
  console.log(String(r?.response || '').slice(0, 1200));
  const hasActions = /(^|\n)\s*1\./.test(String(r?.response || '')) && /(^|\n)\s*2\./.test(String(r?.response || ''));
  console.log('has >=2 actions:', hasActions);
}

// 纯「昨天生意」不再走 Planner workflow，由确定性营业日报回答（与「前天生意」一致）
await runCase('昨天生意怎么样', '马己仙上海音乐广场店');
await runCase('为什么最近利润下降', '马己仙上海音乐广场店');

