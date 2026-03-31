// 企业人力资源管理系统 JavaScript
// 版本: v2.0.3

class HRManagementSystem {
    constructor() {
        this.currentUser = null;
        this.currentPage = 'dashboard';
        this.systemData = {
            users: [],
            employees: [],
            stores: [],
            knowledgeBase: [],
            trainingRecords: [],
            examQuestions: [],
            examResults: [],
            promotionRecords: [],
            rewardPunishmentRecords: [],
            announcements: []
        };
        this.init();
    }

    init() {
        try {
            this.loadSystemData();
            this.bindEvents();
            this.checkLoginStatus();
            console.log('HR System init completed successfully');
        } catch (error) {
            console.error('Error during HR System initialization:', error);
            this.showNotification('系统初始化失败，请刷新页面重试', 'error');
        }
    }

    // 加载系统数据
    loadSystemData() {
        const savedData = localStorage.getItem('hrSystemData');
        if (savedData) {
            this.systemData = JSON.parse(savedData);
        } else {
            this.initializeSampleData();
        }
    }

    // 保存系统数据
    saveSystemData() {
        localStorage.setItem('hrSystemData', JSON.stringify(this.systemData));
    }

    // 初始化示例数据
    initializeSampleData() {
        // 示例用户数据
        this.systemData.users = [
            {
                id: 'admin-001',
                username: 'admin',
                password: 'admin123',
                realName: '系统管理员',
                email: 'admin@company.com',
                role: 'admin',
                isActive: true
            },
            {
                id: 'manager-001',
                username: 'manager',
                password: 'manager123',
                realName: '张经理',
                email: 'manager@company.com',
                role: 'hq_manager',
                isActive: true
            },
            {
                id: 'store-001',
                username: 'storemanager',
                password: 'store123',
                realName: '李店长',
                email: 'store@company.com',
                role: 'store_manager',
                isActive: true
            },
            {
                id: 'employee-001',
                username: 'employee',
                password: 'emp123',
                realName: '王员工',
                email: 'employee@company.com',
                role: 'store_employee',
                isActive: true
            }
        ];

        // 示例门店数据
        this.systemData.stores = [
            {
                id: 'store-001',
                name: '总店',
                address: '北京市朝阳区建国路88号',
                contactPerson: '张经理',
                contactPhone: '010-88888888',
                businessHours: '09:00-22:00',
                isActive: true
            },
            {
                id: 'store-002',
                name: '分店A',
                address: '北京市海淀区中关村大街1号',
                contactPerson: '李店长',
                contactPhone: '010-99999999',
                businessHours: '10:00-21:00',
                isActive: true
            }
        ];

        // 示例员工数据
        this.systemData.employees = [
            {
                id: 'emp-001',
                userId: 'employee-001',
                storeId: 'store-001',
                name: '谢总',
                gender: 'male',
                position: '服务员',
                level: 1,
                department: '前厅',
                hireDate: '2023-01-15',
                hireChannel: '招聘网站',
                currentSalary: 5000,
                workSpecialties: '客户服务',
                workAchievements: '优秀员工奖'
            },
            {
                id: 'emp-002',
                userId: 'store-001',
                storeId: 'store-001',
                name: '李店长',
                gender: 'male',
                position: '店长',
                level: 6,
                department: '前厅',
                hireDate: '2022-06-01',
                hireChannel: '内部推荐',
                currentSalary: 12000,
                workSpecialties: '门店管理',
                workAchievements: '优秀店长'
            }
        ];

        // 示例奖惩记录
        this.systemData.rewardPunishmentRecords = [
            {
                id: 'rp-001',
                employeeId: 'emp-001',
                type: 'reward',
                reason: '工作表现优秀',
                result: '优秀员工奖',
                points: 10,
                status: 'approved',
                issuedDate: '2024-01-15',
                issuedBy: '李店长'
            },
            {
                id: 'rp-002',
                employeeId: 'emp-001',
                type: 'reward',
                reason: '客户表扬',
                result: '服务之星奖',
                points: 5,
                status: 'approved',
                issuedDate: '2024-01-10',
                issuedBy: '李店长'
            }
        ];

        this.saveSystemData();
    }

    // 绑定事件
    bindEvents() {
        // 登录表单
        const loginForm = document.getElementById('login-form');
        if (loginForm) {
            loginForm.addEventListener('submit', (e) => this.handleLogin(e));
        }

        // 登出按钮
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => this.handleLogout());
        }

        // 模态框关闭
        const modalClose = document.getElementById('modal-close');
        if (modalClose) {
            modalClose.addEventListener('click', () => this.closeModal());
        }

        // 快捷操作按钮
        const actionBtns = document.querySelectorAll('.action-btn');
        actionBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                this.handleQuickAction(action);
            });
        });
    }

    // 检查登录状态
    checkLoginStatus() {
        const savedUser = localStorage.getItem('currentUser');
        if (savedUser) {
            this.currentUser = JSON.parse(savedUser);
            this.showMainApp();
        } else {
            this.showLoginScreen();
        }
    }

    // 处理登录
    handleLogin(e) {
        e.preventDefault();
        console.log('Login form submitted');
        
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        
        console.log('Username:', username);
        console.log('Password:', password);

        const user = this.systemData.users.find(u => 
            u.username === username && u.password === password && u.isActive
        );

        console.log('Found user:', user);

        if (user) {
            this.currentUser = user;
            localStorage.setItem('currentUser', JSON.stringify(user));
            console.log('Login successful, saving to localStorage');
            this.showNotification(`欢迎回来，${user.realName}！`, 'success');
            this.showMainApp();
        } else {
            console.log('Login failed');
            this.showNotification('用户名或密码错误', 'error');
        }
    }

    // 处理登出
    handleLogout() {
        this.currentUser = null;
        localStorage.removeItem('currentUser');
        this.showLoginScreen();
        this.showNotification('已安全登出', 'info');
    }

    // 显示登录界面
    showLoginScreen() {
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('main-app').classList.add('hidden');
    }

    // 显示主应用界面
    showMainApp() {
        console.log('showMainApp called!');
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('main-app').classList.remove('hidden');
        
        this.updateUserInfo();
        this.updateNavigation();
        
        console.log('About to bind navigation events...');
        this.bindNavigationEvents(); // 确保在显示主界面后绑定导航事件
        
        console.log('About to navigate to dashboard...');
        this.navigateToPage('dashboard');
        this.loadDashboardData();
        
        // 添加测试按钮
        setTimeout(() => {
            this.addTestButton();
        }, 1000);
    }

    // 添加测试按钮
    addTestButton() {
        const testBtn = document.createElement('button');
        testBtn.textContent = '测试导航';
        testBtn.style.cssText = 'position: fixed; top: 10px; right: 10px; z-index: 9999; background: red; color: white; padding: 10px;';
        testBtn.onclick = () => {
            console.log('Test button clicked');
            console.log('Current user:', this.currentUser);
            console.log('Nav items found:', document.querySelectorAll('.nav-item').length);
            
            // 手动测试导航
            const firstNavItem = document.querySelector('.nav-item');
            if (firstNavItem) {
                console.log('First nav item:', firstNavItem);
                console.log('First nav link:', firstNavItem.querySelector('.nav-link'));
                console.log('Data page:', firstNavItem.dataset.page);
                
                // 模拟点击
                const navLink = firstNavItem.querySelector('.nav-link');
                if (navLink) {
                    console.log('Simulating click on nav link...');
                    navLink.click();
                }
            }
            
            this.showNotification('测试按钮工作正常！', 'success');
        };
        document.body.appendChild(testBtn);
        
        // 添加手动导航按钮
        const manualNavBtn = document.createElement('button');
        manualNavBtn.textContent = '手动导航';
        manualNavBtn.style.cssText = 'position: fixed; top: 60px; right: 10px; z-index: 9999; background: green; color: white; padding: 10px;';
        manualNavBtn.onclick = () => {
            console.log('Manual navigation triggered');
            
            // 直接调用导航方法
            try {
                this.navigateToPage('knowledge');
                this.showNotification('手动导航成功！', 'success');
            } catch (error) {
                console.error('Manual navigation error:', error);
                this.showNotification('手动导航失败: ' + error.message, 'error');
            }
        };
        document.body.appendChild(manualNavBtn);
    }

    // 绑定导航事件（单独方法）
    bindNavigationEvents() {
        console.log('Binding navigation events...');
        
        // 等待DOM完全加载
        setTimeout(() => {
            // 导航菜单
            const navItems = document.querySelectorAll('.nav-item');
            console.log('Found nav items:', navItems.length);
            
            if (navItems.length === 0) {
                console.error('No nav items found! Check HTML structure.');
                return;
            }
            
            navItems.forEach((item, index) => {
                console.log(`Processing nav item ${index}:`, item.dataset.page);
                const navLink = item.querySelector('.nav-link');
                
                if (navLink) {
                    console.log(`Found nav link for item ${index}:`, navLink);
                    
                    // 直接绑定事件到整个li元素
                    item.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log('Nav item clicked (li):', item.dataset.page);
                        
                        const page = item.dataset.page;
                        const roles = item.dataset.roles ? item.dataset.roles.split(',') : [];
                        console.log('Page:', page, 'Roles:', roles, 'User role:', this.currentUser.role);
                        
                        if (this.hasPermission(roles)) {
                            this.navigateToPage(page);
                            this.setActiveNavItem(item);
                        } else {
                            this.showNotification('您没有权限访问此功能', 'error');
                        }
                    });
                    
                    // 也绑定到a标签作为备用
                    navLink.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log('Nav link clicked (a):', item.dataset.page);
                        
                        const page = item.dataset.page;
                        const roles = item.dataset.roles ? item.dataset.roles.split(',') : [];
                        
                        if (this.hasPermission(roles)) {
                            this.navigateToPage(page);
                            this.setActiveNavItem(item);
                        } else {
                            this.showNotification('您没有权限访问此功能', 'error');
                        }
                    });
                    
                    console.log(`Events bound successfully to nav item ${index}`);
                } else {
                    console.error('No nav link found for item:', item);
                }
            });
            
            console.log('Navigation events binding completed');
        }, 500);
    }

    // 更新用户信息
    updateUserInfo() {
        if (this.currentUser) {
            document.getElementById('current-user-name').textContent = this.currentUser.realName;
            document.getElementById('current-user-role').textContent = this.getRoleName(this.currentUser.role);
        }
    }

    // 更新导航菜单
    updateNavigation() {
        const navItems = document.querySelectorAll('.nav-item');
        navItems.forEach(item => {
            const roles = item.dataset.roles ? item.dataset.roles.split(',') : [];
            if (this.hasPermission(roles)) {
                item.style.display = 'block';
            } else {
                item.style.display = 'none';
            }
        });
    }

    // 权限检查
    hasPermission(requiredRoles) {
        if (!this.currentUser) {
            console.log('No current user found');
            return false;
        }
        
        if (!requiredRoles || requiredRoles.length === 0) {
            return true;
        }
        
        const hasPermission = requiredRoles.includes(this.currentUser.role);
        console.log('Permission check:', requiredRoles, 'User role:', this.currentUser.role, 'Has permission:', hasPermission);
        return hasPermission;
    }

    // 获取角色名称
    getRoleName(role) {
        const roleNames = {
            admin: '管理员',
            hq_manager: '总部管理层',
            store_manager: '门店店长',
            hq_employee: '总部员工',
            store_employee: '门店员工'
        };
        return roleNames[role] || role;
    }

    // 导航到页面
    navigateToPage(page) {
        console.log('Navigating to page:', page);
        this.currentPage = page;
        
        // 隐藏所有页面
        document.querySelectorAll('.page-content').forEach(p => {
            p.classList.remove('active');
        });

        // 显示目标页面
        let targetPage = document.getElementById(`${page}-page`);
        if (!targetPage) {
            console.log('Creating new page content for:', page);
            targetPage = this.createPageContent(page);
        }
        targetPage.classList.add('active');
        console.log('Page activated:', page);

        // 加载页面数据
        this.loadPageData(page);
    }

    // 设置活动导航项
    setActiveNavItem(activeItem) {
        console.log('Setting active nav item:', activeItem);
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
        });
        if (activeItem) {
            activeItem.classList.add('active');
            console.log('Active item set successfully:', activeItem.dataset.page);
        }
    }

    // 创建页面内容
    createPageContent(page) {
        const container = document.getElementById('other-pages');
        const pageDiv = document.createElement('div');
        pageDiv.id = `${page}-page`;
        pageDiv.className = 'page-content';
        
        switch(page) {
            case 'knowledge':
                pageDiv.innerHTML = this.getKnowledgePageHTML();
                break;
            case 'training':
                pageDiv.innerHTML = this.getTrainingPageHTML();
                break;
            case 'exam':
                pageDiv.innerHTML = this.getExamPageHTML();
                break;
            case 'employees':
                pageDiv.innerHTML = this.getEmployeesPageHTML();
                break;
            case 'promotion':
                pageDiv.innerHTML = this.getPromotionPageHTML();
                break;
            case 'reward':
                pageDiv.innerHTML = this.getRewardPageHTML();
                break;
            case 'stores':
                pageDiv.innerHTML = this.getStoresPageHTML();
                break;
            case 'users':
                pageDiv.innerHTML = this.getUsersPageHTML();
                break;
            case 'announcements':
                pageDiv.innerHTML = this.getAnnouncementsPageHTML();
                break;
            case 'questions':
                pageDiv.innerHTML = this.getQuestionsPageHTML();
                break;
            default:
                pageDiv.innerHTML = '<div class="empty-state"><h3>页面开发中</h3><p>该功能正在开发中，敬请期待</p></div>';
        }
        
        container.appendChild(pageDiv);
        return pageDiv;
    }

    // 加载页面数据
    loadPageData(page) {
        switch(page) {
            case 'dashboard':
                this.loadDashboardData();
                break;
            case 'knowledge':
                this.loadKnowledgeData();
                break;
            case 'training':
                this.loadTrainingData();
                break;
            case 'exam':
                this.loadExamData();
                break;
            case 'employees':
                this.loadEmployeesData();
                break;
            case 'promotion':
                this.loadPromotionData();
                break;
            case 'reward':
                this.loadRewardData();
                break;
        }
    }

    // 加载工作台数据
    loadDashboardData() {
        // 更新统计数据
        document.getElementById('total-employees').textContent = this.systemData.employees.length;
        document.getElementById('total-stores').textContent = this.systemData.stores.length;
        
        // 计算本月学习时长
        const monthlyTrainingHours = this.calculateMonthlyTrainingHours();
        document.getElementById('training-hours').textContent = monthlyTrainingHours;
        
        // 计算待考试数量
        const pendingExams = this.calculatePendingExams();
        document.getElementById('pending-exams').textContent = pendingExams;
        
        // 加载最近活动
        this.loadRecentActivities();
    }

    // 计算本月学习时长
    calculateMonthlyTrainingHours() {
        const currentMonth = new Date().getMonth();
        const currentYear = new Date().getFullYear();
        
        const monthlyRecords = this.systemData.trainingRecords.filter(record => {
            const recordDate = new Date(record.createdAt);
            return recordDate.getMonth() === currentMonth && 
                   recordDate.getFullYear() === currentYear &&
                   record.status === 'completed';
        });
        
        const totalMinutes = monthlyRecords.reduce((sum, record) => sum + record.durationMinutes, 0);
        return Math.round(totalMinutes / 60);
    }

    // 计算待考试数量
    calculatePendingExams() {
        // 这里应该根据当前用户计算待考试数量
        return 3; // 示例数据
    }

    // 加载最近活动
    loadRecentActivities() {
        const activities = [
            { icon: 'fa-user-plus', title: '新增员工', time: '2小时前', color: '#00C896' },
            { icon: 'fa-trophy', title: '发放奖励', time: '4小时前', color: '#ffc107' },
            { icon: 'fa-graduation-cap', title: '完成培训', time: '1天前', color: '#2E5BBA' },
            { icon: 'fa-file-alt', title: '创建考试', time: '2天前', color: '#17a2b8' }
        ];
        
        const activityList = document.getElementById('recent-activities');
        activityList.innerHTML = activities.map(activity => `
            <div class="activity-item">
                <div class="activity-icon" style="color: ${activity.color}">
                    <i class="fas ${activity.icon}"></i>
                </div>
                <div class="activity-content">
                    <div class="activity-title">${activity.title}</div>
                    <div class="activity-time">${activity.time}</div>
                </div>
            </div>
        `).join('');
    }

    // 处理快捷操作
    handleQuickAction(action) {
        switch(action) {
            case 'add-employee':
                this.showAddEmployeeModal();
                break;
            case 'create-exam':
                this.showCreateExamModal();
                break;
            case 'add-knowledge':
                this.showAddKnowledgeModal();
                break;
            case 'publish-announcement':
                this.showPublishAnnouncementModal();
                break;
        }
    }

    // 显示新增员工模态框
    showAddEmployeeModal() {
        const modalContent = `
            <form id="add-employee-form">
                <div class="form-grid">
                    <div class="form-group">
                        <label>姓名 *</label>
                        <input type="text" name="name" required>
                    </div>
                    <div class="form-group">
                        <label>性别</label>
                        <select name="gender">
                            <option value="male">男</option>
                            <option value="female">女</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>手机号</label>
                        <input type="tel" name="phone">
                    </div>
                    <div class="form-group">
                        <label>门店</label>
                        <select name="storeId">
                            ${this.systemData.stores.map(store => 
                                `<option value="${store.id}">${store.name}</option>`
                            ).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>岗位</label>
                        <input type="text" name="position">
                    </div>
                    <div class="form-group">
                        <label>级别</label>
                        <input type="number" name="level" min="1" max="6">
                    </div>
                    <div class="form-group">
                        <label>部门</label>
                        <select name="department">
                            <option value="前厅">前厅</option>
                            <option value="后厨">后厨</option>
                            <option value="管理">管理</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>入职日期</label>
                        <input type="date" name="hireDate">
                    </div>
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" onclick="hrSystem.closeModal()">取消</button>
                    <button type="submit" class="btn btn-primary">保存</button>
                </div>
            </form>
        `;
        
        this.showModal('新增员工', modalContent);
        
        // 绑定表单提交事件
        setTimeout(() => {
            const form = document.getElementById('add-employee-form');
            form.addEventListener('submit', (e) => this.handleAddEmployee(e));
        }, 100);
    }

    // 处理新增员工
    handleAddEmployee(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        
        const newEmployee = {
            id: 'emp-' + Date.now(),
            userId: null,
            name: formData.get('name'),
            gender: formData.get('gender'),
            phone: formData.get('phone'),
            storeId: formData.get('storeId'),
            position: formData.get('position'),
            level: parseInt(formData.get('level')),
            department: formData.get('department'),
            hireDate: formData.get('hireDate'),
            currentSalary: 0,
            workSpecialties: '',
            workAchievements: ''
        };
        
        this.systemData.employees.push(newEmployee);
        this.saveSystemData();
        this.closeModal();
        this.showNotification('员工添加成功', 'success');
        this.loadDashboardData();
    }

    // 显示模态框
    showModal(title, content) {
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-body').innerHTML = content;
        document.getElementById('modal').classList.add('show');
    }

    // 关闭模态框
    closeModal() {
        document.getElementById('modal').classList.remove('show');
    }

    // 显示通知
    showNotification(message, type = 'info') {
        try {
            const notification = document.getElementById('notification');
            if (!notification) {
                console.error('Notification element not found');
                return;
            }
            
            const icon = notification.querySelector('.notification-icon');
            const messageEl = notification.querySelector('.notification-message');
            
            // 设置图标
            const icons = {
                success: 'fa-check-circle',
                error: 'fa-exclamation-circle',
                warning: 'fa-exclamation-triangle',
                info: 'fa-info-circle'
            };
            
            icon.className = `notification-icon fas ${icons[type]}`;
            messageEl.textContent = message;
            
            // 设置样式
            notification.className = `notification ${type} show`;
            
            console.log('Notification shown:', message, type);
            
            // 自动隐藏
            setTimeout(() => {
                notification.classList.remove('show');
            }, 3000);
        } catch (error) {
            console.error('Error showing notification:', error);
            alert(message); // 备用显示方式
        }
    }

    // 获取知识库页面HTML
    getKnowledgePageHTML() {
        return `
            <div class="page-header">
                <h2>知识库管理</h2>
                <div class="page-actions">
                    <button class="btn btn-primary" onclick="hrSystem.showAddKnowledgeModal()">
                        <i class="fas fa-plus"></i>
                        添加知识
                    </button>
                </div>
            </div>
            <div class="knowledge-grid">
                ${this.systemData.knowledgeBase.map(item => `
                    <div class="card">
                        <div class="card-header">
                            <h3 class="card-title">${item.title}</h3>
                            <div class="card-actions">
                                <button class="btn btn-sm btn-primary">查看</button>
                                <button class="btn btn-sm btn-secondary">编辑</button>
                            </div>
                        </div>
                        <div class="card-content">
                            <p>${item.content ? item.content.substring(0, 100) + '...' : '暂无内容'}</p>
                            <div class="card-meta">
                                <span class="tag tag-info">${item.category || '未分类'}</span>
                                <span class="text-muted">创建于: ${item.createdAt || '未知'}</span>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    // 获取培训页面HTML
    getTrainingPageHTML() {
        const monthlyHours = this.calculateMonthlyTrainingHours();
        return `
            <div class="page-header">
                <h2>培训学习</h2>
                <div class="training-stats">
                    <div class="stat-card">
                        <div class="stat-icon">
                            <i class="fas fa-clock"></i>
                        </div>
                        <div class="stat-info">
                            <div class="stat-number">${monthlyHours}</div>
                            <div class="stat-label">本月累计学习时长(小时)</div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="training-grid">
                ${this.systemData.knowledgeBase.map(item => `
                    <div class="card">
                        <div class="card-header">
                            <h3 class="card-title">${item.title}</h3>
                        </div>
                        <div class="card-content">
                            <p>${item.content ? item.content.substring(0, 100) + '...' : '暂无内容'}</p>
                            <button class="btn btn-primary" onclick="hrSystem.startTraining('${item.id}')">
                                <i class="fas fa-play"></i>
                                开始学习
                            </button>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    // 获取考试页面HTML
    getExamPageHTML() {
        return `
            <div class="exam-container">
                <div class="exam-header">
                    <h2>考试测评</h2>
                    <div class="exam-info">
                        <span>剩余时间: <span id="exam-timer">60:00</span></span>
                        <span>题目: <span id="exam-progress">1/10</span></span>
                    </div>
                </div>
                <div class="exam-content">
                    <div class="question-card">
                        <div class="question-header">
                            <h3>第1题</h3>
                            <span class="question-type">单选题</span>
                        </div>
                        <div class="question-body">
                            <p>以下哪项是优质客户服务的核心要素？</p>
                            <div class="options">
                                <label class="option">
                                    <input type="radio" name="answer" value="A">
                                    <span>A. 快速响应</span>
                                </label>
                                <label class="option">
                                    <input type="radio" name="answer" value="B">
                                    <span>B. 专业技能</span>
                                </label>
                                <label class="option">
                                    <input type="radio" name="answer" value="C">
                                    <span>C. 友好态度</span>
                                </label>
                                <label class="option">
                                    <input type="radio" name="answer" value="D">
                                    <span>D. 以上都是</span>
                                </label>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="exam-footer">
                    <button class="btn btn-secondary" onclick="hrSystem.previousQuestion()">上一题</button>
                    <button class="btn btn-primary" onclick="hrSystem.nextQuestion()">下一题</button>
                    <button class="btn btn-success" onclick="hrSystem.submitExam()">提交试卷</button>
                </div>
            </div>
        `;
    }

    // 获取员工档案页面HTML
    getEmployeesPageHTML() {
        const currentUserEmployee = this.systemData.employees.find(emp => emp.userId === this.currentUser.id);
        const employees = this.getFilteredEmployees();
        
        return `
            <div class="page-header">
                <h2>员工档案管理</h2>
                <div class="page-actions">
                    <div class="search-box">
                        <i class="fas fa-search"></i>
                        <input type="text" placeholder="搜索员工..." onkeyup="hrSystem.searchEmployees(this.value)">
                    </div>
                    ${this.hasPermission(['admin', 'hq_manager', 'store_manager']) ? 
                        `<button class="btn btn-primary" onclick="hrSystem.showAddEmployeeModal()">
                            <i class="fas fa-plus"></i>
                            新增员工
                        </button>` : ''}
                </div>
            </div>
            <div class="table-container">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>姓名</th>
                            <th>性别</th>
                            <th>门店</th>
                            <th>岗位</th>
                            <th>级别</th>
                            <th>部门</th>
                            <th>入职时间</th>
                            <th>当前薪资</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${employees.map(emp => `
                            <tr>
                                <td>${emp.name}</td>
                                <td>${emp.gender === 'male' ? '男' : '女'}</td>
                                <td>${this.getStoreName(emp.storeId)}</td>
                                <td>${emp.position}</td>
                                <td>${emp.level}</td>
                                <td>${emp.department}</td>
                                <td>${emp.hireDate}</td>
                                <td>¥${emp.currentSalary}</td>
                                <td>
                                    <button class="btn btn-sm btn-primary" onclick="hrSystem.viewEmployee('${emp.id}')">查看</button>
                                    ${this.hasPermission(['admin', 'hq_manager', 'store_manager']) ? 
                                        `<button class="btn btn-sm btn-secondary" onclick="hrSystem.editEmployee('${emp.id}')">编辑</button>` : ''}
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    // 获取奖惩记录页面HTML
    getRewardPageHTML() {
        const currentUserEmployee = this.systemData.employees.find(emp => emp.userId === this.currentUser.id);
        const records = this.getFilteredRewardRecords();
        
        return `
            <div class="page-header">
                <h2>奖惩记录</h2>
                <div class="reward-stats">
                    <div class="stat-card">
                        <div class="stat-icon">
                            <i class="fas fa-trophy"></i>
                        </div>
                        <div class="stat-info">
                            <div class="stat-number">${this.getRewardCount(records)}</div>
                            <div class="stat-label">奖励</div>
                        </div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon">
                            <i class="fas fa-exclamation-triangle"></i>
                        </div>
                        <div class="stat-info">
                            <div class="stat-number">${this.getPunishmentCount(records)}</div>
                            <div class="stat-label">处罚</div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="table-container">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>类型</th>
                            <th>原因</th>
                            <th>结果</th>
                            <th>积分</th>
                            <th>发放时间</th>
                            <th>发放人</th>
                            <th>状态</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${records.map(record => `
                            <tr>
                                <td>
                                    <span class="status ${record.type === 'reward' ? 'status-approved' : 'status-rejected'}">
                                        ${record.type === 'reward' ? '奖励' : '处罚'}
                                    </span>
                                </td>
                                <td>${record.reason}</td>
                                <td>${record.result}</td>
                                <td>${record.points}</td>
                                <td>${record.issuedDate}</td>
                                <td>${record.issuedBy}</td>
                                <td>
                                    <span class="status status-${record.status}">
                                        ${this.getStatusName(record.status)}
                                    </span>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    // 获取过滤后的员工列表
    getFilteredEmployees() {
        if (this.currentUser.role === 'admin' || this.currentUser.role === 'hq_manager') {
            return this.systemData.employees;
        } else if (this.currentUser.role === 'store_manager') {
            const currentUserEmployee = this.systemData.employees.find(emp => emp.userId === this.currentUser.id);
            return this.systemData.employees.filter(emp => emp.storeId === currentUserEmployee.storeId);
        } else {
            // 普通员工只能看到自己的档案
            const currentUserEmployee = this.systemData.employees.find(emp => emp.userId === this.currentUser.id);
            return currentUserEmployee ? [currentUserEmployee] : [];
        }
    }

    // 获取过滤后的奖惩记录
    getFilteredRewardRecords() {
        if (this.currentUser.role === 'admin' || this.currentUser.role === 'hq_manager') {
            return this.systemData.rewardPunishmentRecords;
        } else if (this.currentUser.role === 'store_manager') {
            const currentUserEmployee = this.systemData.employees.find(emp => emp.userId === this.currentUser.id);
            const storeEmployees = this.systemData.employees.filter(emp => emp.storeId === currentUserEmployee.storeId);
            const storeEmployeeIds = storeEmployees.map(emp => emp.id);
            return this.systemData.rewardPunishmentRecords.filter(record => 
                storeEmployeeIds.includes(record.employeeId)
            );
        } else {
            // 普通员工只能看到自己的奖惩记录
            const currentUserEmployee = this.systemData.employees.find(emp => emp.userId === this.currentUser.id);
            return this.systemData.rewardPunishmentRecords.filter(record => 
                record.employeeId === currentUserEmployee.id
            );
        }
    }

    // 获取门店名称
    getStoreName(storeId) {
        const store = this.systemData.stores.find(s => s.id === storeId);
        return store ? store.name : '未知门店';
    }

    // 获取奖励数量
    getRewardCount(records) {
        return records.filter(r => r.type === 'reward' && r.status === 'approved').length;
    }

    // 获取处罚数量
    getPunishmentCount(records) {
        return records.filter(r => r.type === 'punishment' && r.status === 'approved').length;
    }

    // 获取状态名称
    getStatusName(status) {
        const statusNames = {
            pending: '待审批',
            approved: '已通过',
            rejected: '已拒绝'
        };
        return statusNames[status] || status;
    }

    // 其他页面HTML方法的占位符
    getPromotionPageHTML() {
        return '<div class="empty-state"><h3>晋升管理</h3><p>该功能正在开发中，敬请期待</p></div>';
    }

    getStoresPageHTML() {
        return '<div class="empty-state"><h3>门店管理</h3><p>该功能正在开发中，敬请期待</p></div>';
    }

    getUsersPageHTML() {
        return '<div class="empty-state"><h3>用户管理</h3><p>该功能正在开发中，敬请期待</p></div>';
    }

    getAnnouncementsPageHTML() {
        return '<div class="empty-state"><h3>公告管理</h3><p>该功能正在开发中，敬请期待</p></div>';
    }

    getQuestionsPageHTML() {
        return '<div class="empty-state"><h3>题库管理</h3><p>该功能正在开发中，敬请期待</p></div>';
    }

    // 其他方法的占位符
    loadKnowledgeData() {}
    loadTrainingData() {}
    loadExamData() {}
    loadEmployeesData() {}
    loadPromotionData() {}
    loadRewardData() {}
    
    startTraining(id) {
        this.showNotification('开始学习', 'info');
    }
    
    previousQuestion() {
        this.showNotification('上一题', 'info');
    }
    
    nextQuestion() {
        this.showNotification('下一题', 'info');
    }
    
    submitExam() {
        this.showNotification('考试提交成功', 'success');
    }
    
    viewEmployee(id) {
        this.showNotification('查看员工详情', 'info');
    }
    
    editEmployee(id) {
        this.showNotification('编辑员工信息', 'info');
    }
    
    searchEmployees(query) {
        this.showNotification('搜索员工: ' + query, 'info');
    }
    
    showAddKnowledgeModal() {
        this.showNotification('添加知识', 'info');
    }
    
    showCreateExamModal() {
        this.showNotification('创建考试', 'info');
    }
    
    showPublishAnnouncementModal() {
        this.showNotification('发布公告', 'info');
    }
}

// 初始化系统
let hrSystem;
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM Content Loaded, initializing HR System...');
    console.log('Current URL:', window.location.href);
    console.log('User Agent:', navigator.userAgent);
    
    // 清除可能的缓存问题
    localStorage.removeItem('currentUser');
    
    hrSystem = new HRManagementSystem();
    console.log('HR System initialized successfully');
    console.log('hrSystem object:', hrSystem);
    
    // 显示初始化信息
    setTimeout(() => {
        if (typeof hrSystem !== 'undefined' && hrSystem.showNotification) {
            hrSystem.showNotification('系统已初始化，请尝试登录', 'info');
        }
    }, 1000);
});
