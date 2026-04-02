# 🎯 Cursor 部署具体指令

## 📋 仓库和部署文件位置

### 1. agents-service-v2 部署

**仓库地址**: https://github.com/davidatjfs-cyber/agents-service-v2

**本地路径**: /path/to/agents-service-v2

**部署文件位置**: 
- 主部署脚本: `scripts/deploy-safe.sh`（调用 `deploy-agents-ecs.sh`）
- 部署指南: `.cursor/rules/deploy-aliyun-agents.mdc`

**GitHub Actions**: `.github/workflows/safe-deployment.yml`

### 2. hr-management-system 部署

**仓库地址**: https://github.com/davidatjfs-cyber/hr-management-system

**本地路径**: /path/to/hr-management-system

**部署文件位置**: 
- 主部署脚本: `scripts/deploy-hrms-safe.sh`
- 通用脚本: `scripts/deploy-backup.sh`, `scripts/deploy-rollback.sh`, `scripts/deploy-status.sh`
- 部署指南: `.cursor/rules/deploy-aliyun-agents.mdc`

**GitHub Actions**: `.github/workflows/hrms-safe-deployment.yml`

## 🎯 Cursor 必须遵循的规则

### 规则1: 部署前确认仓库路径
```
当你在 agents-service-v2 中修改代码时:
1. 确认当前路径是 agents-service-v2 仓库
2. 执行: cd /path/to/agents-service-v2
3. 确认文件存在: ls -la scripts/deploy-safe.sh

当你在 hr-management-system 中修改代码时:
1. 确认当前路径是 hr-management-system 仓库
2. 执行: cd /path/to/hr-management-system  
3. 确认文件存在: ls -la scripts/deploy-hrms-safe.sh
```

### 规则2: agents-service-v2 部署流程
```
每次修改 agents-service-v2 后，必须按以下顺序执行:

1. 提交修改:
   cd /path/to/agents-service-v2
   git add .
   git commit -m "修改描述"

2. 推送到GitHub:
   git push origin main

3. 等待GitHub Actions完成部署
   - 访问: https://github.com/davidatjfs-cyber/agents-service-v2/actions
   - 查看 "Safe Deployment" workflow 执行状态

4. 验证部署结果:
   - 访问: http://47.100.96.30:3101/health
   - 或执行: ssh root@47.100.96.30 '/opt/scripts/deploy-status.sh'
```

### 规则3: hr-management-system 部署流程
```
每次修改 hr-management-system 后，必须按以下顺序执行:

1. 提交修改:
   cd /path/to/hr-management-system
   git add .
   git commit -m "修改描述"

2. 推送到GitHub:
   git push origin main

3. 等待GitHub Actions完成部署
   - 访问: https://github.com/davidatjfs-cyber/hr-management-system/actions
   - 查看 "HRMS Safe Deployment" workflow 执行状态

4. 验证部署结果:
   - 前端: http://47.100.96.30:3000/working-fixed.html
   - 手机版: http://47.100.96.30:3000/mobile-nav-production.html
   - 或执行: ssh root@47.100.96.30 '/opt/scripts/deploy-status.sh'
```

### 规则4: 紧急回滚处理
```
如果GitHub Actions部署失败或部署后发现问题:

1. 立即执行回滚:
   ssh root@47.100.96.30 '/opt/scripts/deploy-rollback.sh'

2. 检查回滚状态:
   ssh root@47.100.96.30 '/opt/scripts/deploy-status.sh'

3. 验证服务恢复:
   curl http://47.100.96.30:3101/health
   curl http://47.100.96.30:3000/api/health
```

## 🔍 部署文件查找指令

### agents-service-v2 部署文件
```
查找命令: find /path/to/agents-service-v2 -name "deploy-safe.sh"
位置: /path/to/agents-service-v2/scripts/deploy-safe.sh

执行命令: cd /path/to/agents-service-v2 && bash scripts/deploy-safe.sh
```

### hr-management-system 部署文件
```
查找命令: find /path/to/hr-management-system -name "deploy-hrms-safe.sh"
位置: /path/to/hr-management-system/scripts/deploy-hrms-safe.sh

执行命令: cd /path/to/hr-management-system && bash scripts/deploy-hrms-safe.sh
```

## 📋 Cursor 必须检查的清单

### 修改前检查
- [ ] 确认当前在正确的仓库路径
- [ ] 确认部署文件存在
- [ ] 确认git remote配置正确

### 提交时检查
- [ ] 检查git status确认要提交的文件
- [ ] 提交信息清晰描述修改内容
- [ ] 推送前确认没有遗漏文件

### 推送后检查
- [ ] 访问GitHub Actions查看执行状态
- [ ] 确认所有步骤都执行成功
- [ ] 验证服务健康检查通过

### 部署后验证
- [ ] 访问服务地址确认功能正常
- [ ] 执行状态检查命令
- [ ] 查看错误日志确认无异常

## 🎯 最终部署路径确认

### agents-service-v2
```
仓库: https://github.com/davidatjfs-cyber/agents-service-v2
本地路径: /path/to/agents-service-v2
部署文件: /path/to/agents-service-v2/scripts/deploy-safe.sh
GitHub Actions: .github/workflows/safe-deployment.yml
ECS路径: /opt/agents-service-v2
服务端口: 3101
```

### hr-management-system
```
仓库: https://github.com/davidatjfs-cyber/hr-management-system
本地路径: /path/to/hr-management-system  
部署文件: /path/to/hr-management-system/scripts/deploy-hrms-safe.sh
GitHub Actions: .github/workflows/hrms-safe-deployment.yml
ECS路径: /opt/hrms/
服务端口: 3000 (后端) + 静态文件 (前端)
```

## 🔧 手动部署命令 (如需要)

### agents-service-v2 手动部署
```bash
cd /path/to/agents-service-v2
bash scripts/deploy-safe.sh
```

### hr-management-system 手动部署
```bash
cd /path/to/hr-management-system
bash scripts/deploy-hrms-safe.sh
```

### 通用状态检查
```bash
ssh root@47.100.96.30 '/opt/scripts/deploy-status.sh'
```

## 🎯 Cursor 核心指令总结

### 修改 agents-service-v2:
1. cd /path/to/agents-service-v2
2. 修改代码并保存
3. git add . && git commit -m "修改描述"
4. git push origin main
5. 等待GitHub Actions自动部署完成

### 修改 hr-management-system:
1. cd /path/to/hr-management-system
2. 修改代码并保存
3. git add . && git commit -m "修改描述"  
4. git push origin main
5. 等待GitHub Actions自动部署完成

### 部署失败处理:
1. ssh root@47.100.96.30 '/opt/scripts/deploy-rollback.sh'
2. ssh root@47.100.96.30 '/opt/scripts/deploy-status.sh'
3. 检查服务是否恢复