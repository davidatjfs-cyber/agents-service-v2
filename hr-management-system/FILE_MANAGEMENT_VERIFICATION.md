# 文件管理模块完整验证指南

## 概述
本文档提供文件管理模块的完整验证方法，包括Phase 1、Phase 2和Phase 3的所有功能。

---

## 一、环境准备

### 1.1 访问系统
- **生产环境URL**: http://47.100.96.30:3000
- **测试账号**: 使用admin或hq_manager角色账号登录

### 1.2 检查服务状态
```bash
ssh root@47.100.96.30 "systemctl status hrms"
```
确认服务状态为 `active (running)`

---

## 二、Phase 1 基础功能验证

### 2.1 数据库表验证

**步骤**:
```bash
ssh root@47.100.96.30
psql -U postgres -d hrms_db
```

**验证SQL**:
```sql
-- 检查files表
SELECT COUNT(*) FROM files;
\d files

-- 检查file_tags表
SELECT * FROM file_tags ORDER BY tag_category, tag_name;

-- 检查file_access_logs表
SELECT COUNT(*) FROM file_access_logs;
```

**预期结果**:
- `files`表存在，包含所有必要字段
- `file_tags`表包含默认标签（auto_backup, pos_sales, feishu等）
- `file_access_logs`表存在

---

### 2.2 文件上传功能验证

**步骤**:
1. 登录系统，点击导航菜单中的"文件中心"
2. 点击右上角"上传文件"按钮
3. 填写上传表单：
   - 选择文件（任意测试文件，如Excel、JSON）
   - 文件类型：选择"POS销售"或"营业日报"
   - 门店：选择"洪潮大宁久光店"
   - 备注：输入"测试上传功能"
4. 点击"上传"按钮

**预期结果**:
- 显示"文件上传成功"提示
- 文件列表中出现新上传的文件
- 文件信息完整显示（文件名、类型、大小、上传人、时间）

**验证数据库**:
```sql
SELECT file_id, original_name, file_type, uploader_username, created_at 
FROM files 
ORDER BY created_at DESC 
LIMIT 5;
```

---

### 2.3 文件下载功能验证

**步骤**:
1. 在文件列表中找到刚上传的文件
2. 点击"下载"按钮

**预期结果**:
- 浏览器开始下载文件
- 文件名与原始文件名一致
- 文件内容完整无损

**验证下载计数**:
```sql
SELECT file_id, original_name, download_count, last_downloaded_at 
FROM files 
WHERE file_id = 'FILE-XXXXXXXX-XXXX';
```
下载计数应增加1

---

### 2.4 文件校验功能验证

**步骤**:
1. 上传一个POS销售类型的Excel文件
2. 等待自动校验或点击"校验"按钮
3. 查看校验结果

**预期结果**:
- 校验状态显示为"已通过"或"未通过"
- 如果未通过，显示具体错误信息

**验证数据库**:
```sql
SELECT file_id, validation_status, validation_result, validated_at 
FROM files 
WHERE file_type = 'pos_sales' 
ORDER BY created_at DESC 
LIMIT 3;
```

---

### 2.5 文件删除功能验证

**步骤**:
1. 找到自己上传的测试文件
2. 点击"删除"按钮（🗑️图标）
3. 确认删除

**预期结果**:
- 文件从列表中消失
- 显示"文件已删除"提示

**验证软删除**:
```sql
SELECT file_id, original_name, deleted_at 
FROM files 
WHERE deleted_at IS NOT NULL 
ORDER BY deleted_at DESC 
LIMIT 5;
```
文件应有`deleted_at`时间戳

---

### 2.6 文件过滤功能验证

**步骤**:
1. 使用文件类型过滤器，选择"POS销售"
2. 使用门店过滤器，选择"洪潮大宁久光店"
3. 使用校验状态过滤器，选择"已通过"
4. 在上传人输入框输入用户名

**预期结果**:
- 每次过滤后，列表只显示符合条件的文件
- 分页正确更新

---

## 三、Phase 2 高级功能验证

### 3.1 文件搜索功能验证

**步骤**:
1. 在搜索框输入关键词（如文件名的一部分）
2. 点击"搜索"按钮或按Enter键

**预期结果**:
- 显示包含关键词的所有文件
- 显示"找到 X 个文件"提示
- 搜索结果支持分页

**API验证**:
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://47.100.96.30:3000/api/files/search?q=测试"
```

**清除搜索**:
1. 点击"清除"按钮
2. 列表恢复显示所有文件

---

### 3.2 批量下载功能验证

**步骤**:
1. 在文件列表中勾选多个文件的复选框（建议2-5个）
2. 观察右上角"批量下载"按钮出现，显示选中数量
3. 点击"批量下载"按钮

**预期结果**:
- 浏览器下载一个`files.zip`文件
- ZIP文件包含所有选中的文件
- 文件名保持原始名称
- 所有文件内容完整

**验证下载日志**:
```sql
SELECT f.file_id, f.original_name, COUNT(l.id) as download_count
FROM files f
LEFT JOIN file_access_logs l ON f.file_id = l.file_id AND l.action = 'download'
GROUP BY f.file_id, f.original_name
HAVING COUNT(l.id) > 0
ORDER BY download_count DESC
LIMIT 10;
```

**边界测试**:
- 尝试选择超过50个文件，应显示"一次最多下载50个文件"警告

---

### 3.3 文件与任务关联功能验证

**API测试**:
```bash
# 关联文件到任务
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task_id": "TASK-20260302-0001"}' \
  http://47.100.96.30:3000/api/files/FILE-XXXXXXXX-XXXX/link-task
```

**预期结果**:
- 返回`{"ok": true, "message": "文件已关联到任务"}`

**验证数据库**:
```sql
SELECT file_id, original_name, related_task_id 
FROM files 
WHERE related_task_id IS NOT NULL;
```

---

## 四、Phase 3 自动化功能验证

### 4.1 自动备份功能验证

#### 4.1.1 POS数据备份

**手动触发测试**:
```bash
ssh root@47.100.96.30
cd /opt/hrms/hr-management-system/server
node -e "
const { backupPOSSalesData } = require('./file-auto-backup.js');
backupPOSSalesData('洪潮大宁久光店', '2026-02-23', '2026-03-02')
  .then(() => console.log('备份完成'))
  .catch(e => console.error('备份失败:', e));
"
```

**预期结果**:
- 控制台显示"备份完成"
- 文件存储目录生成JSON备份文件
- 数据库`files`表新增一条记录，`source='auto_backup'`

**验证备份文件**:
```sql
SELECT file_id, original_name, file_type, source, metadata, created_at
FROM files
WHERE source = 'auto_backup' AND file_type = 'pos_sales'
ORDER BY created_at DESC
LIMIT 5;
```

---

#### 4.1.2 飞书数据备份

**手动触发测试**:
```bash
node -e "
const { backupFeishuTable } = require('./file-auto-backup.js');
backupFeishuTable('YOUR_APP_TOKEN', 'YOUR_TABLE_ID', '收档检查')
  .then(() => console.log('飞书备份完成'))
  .catch(e => console.error('飞书备份失败:', e));
"
```

**预期结果**:
- 生成飞书多维表格的JSON备份
- 文件类型为`feishu_export`
- 包含完整的记录数据

---

#### 4.1.3 定时备份验证

**检查定时任务配置**:
```bash
# 查看服务器日志，确认定时任务已启动
journalctl -u hrms -n 100 --no-pager | grep "Auto backup scheduler"
```

**预期输出**:
```
[file-backup] Auto backup scheduler started (weekly at 3:00 AM on Sunday)
```

**模拟定时任务**:
由于定时任务每周日凌晨3点执行，可以手动触发测试：
```bash
node -e "
const { runWeeklyBackup } = require('./file-auto-backup.js');
runWeeklyBackup()
  .then(() => console.log('周备份完成'))
  .catch(e => console.error('周备份失败:', e));
"
```

---

### 4.2 报表集成验证

**验证备份文件可用于报表生成**:
```sql
-- 查询最近7天的备份文件
SELECT 
  file_id,
  original_name,
  file_type,
  store,
  date_range_start,
  date_range_end,
  metadata->>'record_count' as record_count,
  created_at
FROM files
WHERE source = 'auto_backup'
  AND created_at >= NOW() - INTERVAL '7 days'
ORDER BY created_at DESC;
```

**下载备份文件并验证数据完整性**:
1. 从文件中心下载自动备份的JSON文件
2. 打开JSON文件，检查数据结构
3. 确认记录数量与`metadata.record_count`一致

---

## 五、完整功能测试流程

### 5.1 端到端测试场景

**场景1：完整的文件生命周期**
1. 上传文件 → 2. 校验文件 → 3. 下载文件 → 4. 删除文件

**场景2：批量操作流程**
1. 上传多个文件 → 2. 使用过滤器筛选 → 3. 批量选择 → 4. 批量下载

**场景3：搜索和管理**
1. 上传带备注的文件 → 2. 使用搜索功能查找 → 3. 查看文件详情 → 4. 关联到任务

---

### 5.2 性能测试

**大文件上传测试**:
- 上传10MB、20MB、50MB的文件
- 验证上传速度和成功率

**批量下载性能**:
- 选择10个、20个、50个文件批量下载
- 验证ZIP生成速度和完整性

**并发访问测试**:
- 多个用户同时上传/下载文件
- 验证系统稳定性

---

### 5.3 权限测试

**测试不同角色的权限**:

| 角色 | 查看文件 | 上传文件 | 下载文件 | 删除文件 | 校验文件 |
|------|---------|---------|---------|---------|---------|
| admin | ✓ | ✓ | ✓ | 所有文件 | ✓ |
| hq_manager | ✓ | ✓ | ✓ | 自己的文件 | ✓ |
| store_manager | ✓ | ✓ | ✓ | 自己的文件 | ✗ |

**验证步骤**:
1. 使用不同角色账号登录
2. 尝试执行各项操作
3. 确认权限控制正确

---

## 六、错误处理验证

### 6.1 前端错误处理

**测试场景**:
1. 上传空文件
2. 上传超大文件（>50MB）
3. 网络断开时操作
4. 未登录时访问文件中心

**预期结果**:
- 显示友好的错误提示
- 不会导致页面崩溃

---

### 6.2 后端错误处理

**测试场景**:
1. 数据库连接失败
2. 文件存储目录权限不足
3. 飞书API调用失败

**验证方法**:
```bash
# 查看错误日志
journalctl -u hrms -n 200 --no-pager | grep -i error
```

---

## 七、数据完整性验证

### 7.1 文件一致性检查

**验证文件校验和**:
```sql
SELECT 
  file_id,
  original_name,
  checksum,
  file_size
FROM files
WHERE deleted_at IS NULL
ORDER BY created_at DESC
LIMIT 10;
```

**手动验证**:
1. 下载文件
2. 计算MD5校验和
3. 与数据库中的`checksum`对比

---

### 7.2 访问日志完整性

**验证所有操作都有日志记录**:
```sql
SELECT 
  action,
  COUNT(*) as count
FROM file_access_logs
GROUP BY action
ORDER BY count DESC;
```

**预期结果**:
- upload、download、delete等操作都有记录

---

## 八、监控和维护

### 8.1 存储空间监控

**检查文件存储使用情况**:
```bash
ssh root@47.100.96.30 "du -sh /opt/hrms/hr-management-system/server/file_storage/*"
```

**数据库存储统计**:
```sql
SELECT 
  file_type,
  COUNT(*) as file_count,
  SUM(file_size) as total_size,
  AVG(file_size) as avg_size
FROM files
WHERE deleted_at IS NULL
GROUP BY file_type;
```

---

### 8.2 定期清理

**清理已删除文件**:
```sql
-- 查看30天前删除的文件
SELECT file_id, original_name, deleted_at
FROM files
WHERE deleted_at < NOW() - INTERVAL '30 days'
LIMIT 10;

-- 物理删除（谨慎操作）
-- DELETE FROM files WHERE deleted_at < NOW() - INTERVAL '30 days';
```

---

## 九、常见问题排查

### 9.1 文件上传失败

**检查项**:
1. 文件大小是否超过限制（50MB）
2. 存储目录权限是否正确
3. 数据库连接是否正常

**排查命令**:
```bash
# 检查存储目录权限
ls -la /opt/hrms/hr-management-system/server/file_storage/

# 检查磁盘空间
df -h

# 查看错误日志
journalctl -u hrms -n 100 | grep upload
```

---

### 9.2 批量下载失败

**检查项**:
1. 选择的文件数量是否超过50个
2. 文件是否都存在
3. archiver依赖是否正确安装

**排查命令**:
```bash
# 检查archiver安装
npm list archiver

# 测试单个文件下载
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://47.100.96.30:3000/api/files/FILE-ID/download -o test.file
```

---

### 9.3 自动备份未执行

**检查项**:
1. node-cron是否正确安装
2. 定时任务是否启动
3. 环境变量是否配置正确

**排查命令**:
```bash
# 检查定时任务日志
journalctl -u hrms | grep "backup"

# 手动触发备份测试
node -e "require('./file-auto-backup.js').runWeeklyBackup()"
```

---

## 十、验证清单

### 10.1 Phase 1 验证清单

- [ ] 数据库表创建成功
- [ ] 文件上传功能正常
- [ ] 文件下载功能正常
- [ ] 文件校验功能正常
- [ ] 文件删除功能正常（软删除）
- [ ] 文件列表显示正常
- [ ] 文件过滤功能正常
- [ ] 分页功能正常

### 10.2 Phase 2 验证清单

- [ ] 文件搜索功能正常
- [ ] 批量选择功能正常
- [ ] 批量下载功能正常（ZIP打包）
- [ ] 文件与任务关联API正常
- [ ] 搜索结果准确
- [ ] 批量下载文件完整

### 10.3 Phase 3 验证清单

- [ ] POS数据自动备份功能正常
- [ ] 飞书数据自动备份功能正常
- [ ] 营业日报自动备份功能正常
- [ ] 定时任务调度器启动成功
- [ ] 备份文件格式正确
- [ ] 备份数据完整性验证通过

### 10.4 综合验证清单

- [ ] 权限控制正确
- [ ] 错误处理完善
- [ ] 性能表现良好
- [ ] 数据一致性保证
- [ ] 日志记录完整
- [ ] 监控指标正常

---

## 十一、快速验证脚本

### 11.1 API快速测试脚本

创建文件 `test_file_api.sh`:

```bash
#!/bin/bash

API_BASE="http://47.100.96.30:3000/api"
TOKEN="YOUR_AUTH_TOKEN"

echo "=== 测试文件列表API ==="
curl -s -H "Authorization: Bearer $TOKEN" "$API_BASE/files?limit=5" | jq .

echo -e "\n=== 测试文件搜索API ==="
curl -s -H "Authorization: Bearer $TOKEN" "$API_BASE/files/search?q=测试" | jq .

echo -e "\n=== 测试标签API ==="
curl -s -H "Authorization: Bearer $TOKEN" "$API_BASE/files/tags/all" | jq .

echo -e "\n=== 完成 ==="
```

运行: `bash test_file_api.sh`

---

## 十二、总结

本验证指南涵盖了文件管理模块的所有功能点，包括：

1. **Phase 1**: 基础CRUD操作、文件校验、过滤分页
2. **Phase 2**: 搜索、批量下载、任务关联
3. **Phase 3**: 自动备份、定时任务、报表集成

按照本指南逐项验证，可以确保文件管理模块功能完整、稳定可靠。

---

**验证负责人**: ___________  
**验证日期**: ___________  
**验证结果**: [ ] 通过 [ ] 未通过  
**备注**: ___________
