console.log('开始测试...');
const axios = require('axios');

axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  app_id: 'cli_a9fc0d13c838dcd6',
  app_secret: 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN'
}).then(response => {
  console.log('令牌获取结果:', response.data.code === 0 ? '成功' : '失败');
  if (response.data.code === 0) {
    console.log('测试完成 - 权限已修复');
  } else {
    console.log('测试失败 - 权限问题');
  }
}).catch(error => {
  console.log('测试异常:', error.message);
});
