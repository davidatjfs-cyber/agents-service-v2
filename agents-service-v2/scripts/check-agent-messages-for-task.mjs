#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';
const {Pool}=pg;
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3});
const q=async(s,p=[])=> (await pool.query(s,p)).rows;
const taskId=process.argv[2];
if(!taskId){console.error('Usage: node scripts/check-agent-messages-for-task.mjs ANO-...');process.exit(1);}
const rows=await q(`SELECT COUNT(*)::int AS cnt
                    FROM agent_messages
                    WHERE content_type='task_response'
                      AND agent_data->>'taskId'=$1::text
                      AND direction='in'`,[taskId]);
console.log(JSON.stringify({taskId, agent_messages_task_response_cnt: rows[0]?.cnt||0},null,2));
await pool.end();

