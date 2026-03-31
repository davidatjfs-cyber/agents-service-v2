import fs from 'fs';

const path = '/opt/hrms/hr-management-system/server/agents.js';
let code = fs.readFileSync(path, 'utf8');

// Fix sort parsing in getBitableRecords
code = code.replace(/const { pageSize = 20, pageToken, filter, sort = \\[\\] } = options;[\\s\\S]*?if \\(pageToken\\) params\\.page_token = pageToken;/m, 
`const { pageSize = 20, pageToken, filter, sort = [] } = options;
  const params = {
    page_size: pageSize,
    user_id_type: 'open_id'
  };
  
  if (pageToken) params.page_token = pageToken;
  if (filter) params.filter = filter;
  if (sort.length > 0) {
    params.sort = JSON.stringify(sort);
  } else if (config.sortField) {
    params.sort = config.sortField; // it is already a string
  } else {
    params.sort = JSON.stringify(["_id DESC"]);
  }`);

fs.writeFileSync(path, code);
