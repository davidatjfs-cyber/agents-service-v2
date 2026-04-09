/**
 * Safe Proactive System Test - ECS Version
 * 不会影响生产数据，只测试触发逻辑
 */

// 加载环境变量
require('dotenv/config');

const { Pool } = require("pg");

const pool = new Pool({
  host: "127.0.0.1",
  port: 5432,
  database: "hrms",
  user: "hrms",
  password: "Abc1234567!",
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});

async function query(sql, params) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

async function safeTest() {
  console.log("=".repeat(60));
  console.log("SAFE PROACTIVE SYSTEM TEST - ECS");
  console.log("=".repeat(60));
  console.log("");

  console.log("[1] Cleanup old test data...");
  await query("DELETE FROM anomaly_triggers WHERE store = $1", ["测试门店_SAFE_TEST"]);
  console.log("    Done");

  console.log("\n[2] Insert test anomaly...");
  await query(`
    INSERT INTO anomaly_triggers (anomaly_key, store, severity, trigger_value, trigger_date, created_at)
    VALUES ($1, $2, $3, $4, CURRENT_DATE, NOW())
  `, ["safe_test", "测试门店_SAFE_TEST", "high", JSON.stringify({ revenue: 0.65, dropPercent: 35 })]);
  console.log("    Done");

  console.log("\n[3] Loading proactive-v2 modules...");
  let anomalyBridge, llmDecision;
  try {
    anomalyBridge = await import('../src/services/proactive-v2/anomaly-bridge.js');
    llmDecision = await import('../src/services/proactive-v2/llm-decision.js');
    console.log("    Modules loaded");
  } catch (err) {
    console.error("    Module load failed:", err.message);
    return;
  }

  const handleAnomalies = anomalyBridge.handleAnomalies || anomalyBridge.default?.handleAnomalies;
  const decideWithLLM = llmDecision.decideWithLLM || llmDecision.default?.decideWithLLM;

  const testAnomaly = {
    type: "safe_test",
    store: "测试门店_SAFE_TEST",
    severity: "high",
    value: { revenue: 0.65, dropPercent: 35 },
  };

  console.log("\n[4] Testing LLM decision...");
  try {
    const decision = await decideWithLLM(testAnomaly);
    console.log("    triggered:", decision.triggered);
    console.log("    reason:", decision.reason);
    console.log("    priority:", decision.priority);
  } catch (err) {
    console.error("    LLM decision failed:", err.message);
  }

  console.log("\n[5] Triggering handleAnomalies...");
  try {
    const stats = await handleAnomalies([testAnomaly]);
    console.log("    processed:", stats.processed);
    console.log("    triggered:", stats.triggered);
    console.log("    skipped:", stats.skipped);
    console.log("    errors:", stats.errors);
    if (stats.triggered > 0) {
      console.log("\n    SUCCESS: AGENTS WERE TRIGGERED!");
    }
  } catch (err) {
    console.error("    handleAnomalies failed:", err.message);
  }

  console.log("\n[6] Checking logs...");
  const { execSync } = require("child_process");
  try {
    const logs = execSync("pm2 logs agents-service-v2 --nostream --lines 30 2>/dev/null", { encoding: "utf-8", timeout: 5000 });
    const relevantLogs = logs.split("\n").filter(l => 
      l.includes("Proactive") || l.includes("LLM") || l.includes("Bridge") || l.includes("Trigger") || l.includes("Dedupe")
    ).slice(-20).join("\n");
    console.log(relevantLogs || "(no relevant logs)");
  } catch (err) {
    console.log("(no logs available)");
  }

  console.log("\n[7] Cleanup test data...");
  await query("DELETE FROM anomaly_triggers WHERE store = $1", ["测试门店_SAFE_TEST"]);
  console.log("    Done");

  console.log("\n" + "=".repeat(60));
  console.log("TEST COMPLETE");
  console.log("=".repeat(60));
}

safeTest()
  .then(() => { pool.end(); process.exit(0); })
  .catch(err => {
    console.error("TEST FAILED:", err.message);
    pool.end();
    process.exit(1);
  });
