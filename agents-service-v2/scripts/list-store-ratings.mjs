#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';
const {Pool}=pg;
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3});
const q=async(s,p=[])=> (await pool.query(s,p)).rows;
const period=String(process.argv[2]||'');
if(!period){console.error('Usage: node scripts/list-store-ratings.mjs 2026-03');process.exit(1);}
const rows=await q(`SELECT store, brand, period, rating, actual_revenue, target_revenue, achievement_rate
                   FROM store_ratings
                   WHERE period=$1
                   ORDER BY store`,[period]);
console.log(JSON.stringify({period, rows},null,2));
await pool.end();

