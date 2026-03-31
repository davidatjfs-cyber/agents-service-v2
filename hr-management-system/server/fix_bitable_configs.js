import fs from 'fs';

const filePath = '/opt/hrms/hr-management-system/server/agents.js';
let content = fs.readFileSync(filePath, 'utf8');

// Replace the BITABLE_CONFIGS block to only include correct ones
const newConfig = `const BITABLE_CONFIGS = {
  'ops_checklist': {
    appId: process.env.BITABLE_OPS_APP_ID || 'cli_a91dae9f9578dcb1',
    appSecret: process.env.BITABLE_OPS_APP_SECRET || 'sjpAzPwu4KixvhbAOD7w4ee1oEKRRBQF',
    appToken: process.env.BITABLE_OPS_APP_TOKEN || 'PtVObRtoPaMAP3stIIFc8DnJngd',
    tableId: process.env.BITABLE_OPS_TABLE_ID || 'tblxHI9ZAKONOTpp',
    name: '运营检查表(含开收档)',
    type: 'checklist',
    pollingInterval: 60000,
    sortField: '["_id DESC"]'
  },
  'table_visit': {
    appId: process.env.BITABLE_TABLEVISIT_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_TABLEVISIT_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_TABLEVISIT_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_TABLEVISIT_TABLE_ID || 'tblpx5Efqc6eHo3L',
    name: '桌访表',
    type: 'table_visit',
    pollingInterval: 300000,
    sortField: '["日期 DESC"]'
  },
  'bad_reviews': {
    appId: process.env.BITABLE_TABLEVISIT_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_TABLEVISIT_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_TABLEVISIT_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: 'tblgReexNjWJOJB6',
    name: '差评报告DB',
    type: 'bad_review',
    pollingInterval: 300000,
    sortField: '["创建日期 DESC"]'
  }
};`;

content = content.replace(/const BITABLE_CONFIGS = \{[\s\S]*?\n\};\n/m, newConfig + '\n');
fs.writeFileSync(filePath, content);
