/**
 * Direct Proactive Test - ECS
 * 直接调用 proactive-runner 进行测试
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function test() {
  console.log('='.repeat(60));
  console.log('DIRECT PROACTIVE TEST');
  console.log('='.repeat(60));
  
  const proactiveRunner = await import('../src/services/proactive-v2/proactive-runner.js');
  const runOnce = proactiveRunner.default.runOnce;
  const getStatus = proactiveRunner.default.getStatus;
  
  console.log('\nStatus:', getStatus());
  
  console.log('\nRunning proactive check...');
  const result = await runOnce({ frequency: 'daily' });
  
  console.log('\nResult:', JSON.stringify(result, null, 2));
  
  if (result.triggered > 0) {
    console.log('\n*** SUCCESS: Agents were triggered! ***');
  } else {
    console.log('\nNote: No agents triggered (may be normal if no anomalies detected)');
  }
}

test()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('Error:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
