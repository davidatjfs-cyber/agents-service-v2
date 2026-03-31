const fs = require('fs');
const path = '/opt/hrms/hr-management-system/server/agents.js';
let code = fs.readFileSync(path, 'utf8');

const badStr = "VALUES ('in','feishu','negative_review',async function processTableVisitData(records) {";
const goodStr = `VALUES ('in','feishu','negative_review',$1,$2::jsonb,$3)
        ON CONFLICT (record_id) DO UPDATE SET
          content = EXCLUDED.content,
          agent_data = EXCLUDED.agent_data,
          updated_at = CURRENT_TIMESTAMP
      \`, [
        \`差评记录 - \${tableData.store}\`,
        JSON.stringify(tableData),
        recordId
      ]);
    } catch(e) {
      console.error('[bitable] bad review process error:', e?.message);
    }
  }
}

async function processTableVisitData(records) {`;

if (code.includes(badStr)) {
  code = code.replace(badStr, goodStr);
  fs.writeFileSync(path, code);
  console.log('Fixed syntax error');
} else {
  console.log('Bad string not found');
}
