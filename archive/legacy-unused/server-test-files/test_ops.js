import pg from 'pg';
import { setPool, sendScheduledChecklist } from './agents.js';
import fetch from 'node-fetch';

const pool = new pg.Pool({
    user: 'hrms',
    host: 'localhost',
    database: 'hrms',
    password: 'hrms',
    port: 5432,
});

// Since loadStateFromServer isn't exported, we need to manually trigger the internal state load by doing a quick API call locally, or just run it via node server script.
// Actually, I can just call the production API to trigger the checklist by sending a command to the agent.
