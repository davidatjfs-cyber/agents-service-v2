import fs from 'fs';

const filePath = '/opt/hrms/hr-management-system/server/agents.js';
let content = fs.readFileSync(filePath, 'utf8');

if (!content.includes('case \'bad_review\':')) {
  // Add to switch
  content = content.replace(
    /case 'table_visit':\s+return await processTableVisitData\(records\);/,
    `case 'table_visit':\n      return await processTableVisitData(records);\n    case 'bad_review':\n      return await processBadReviewData(records);`
  );
}

if (!content.includes('async function processBadReviewData')) {
  const badReviewFunc = `
async function processBadReviewData(records) {
  console.log(\`[bad_review] processing \${records.length} records\`);
  for (const record of records) {
    try {
      const fields = record.fields || {};
      const recordId = record.record_id;
      const createdTime = record.created_time;
      const dateVal = fields['差评日期'] || fields['创建日期'] || createdTime;
      
      const tableData = {
        recordId: recordId,
        date: dateVal,
        store: fields['差评门店'] || '',
        platform: Array.isArray(fields['差评平台']) ? fields['差评平台'].join(',') : (fields['差评平台'] || ''),
        product: fields['差评产品'] || '',
        reason: fields['差评原因'] || '',
        keywords: fields['差评关键词'] || '',
        rating: fields['星级'] || '',
        extractedInfo: fields['提取信息'] || ''
      };
      
      await pool().query(\`
        INSERT INTO agent_messages (direction, channel, content_type, content, agent_data, record_id)
        VALUES ('in','feishu','negative_review',$1,$2::jsonb,$3)
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
`;
  content = content.replace(/(async function processTableVisitData[\s\S]*?\n})/, '$1\n' + badReviewFunc);
}

fs.writeFileSync(filePath, content);
