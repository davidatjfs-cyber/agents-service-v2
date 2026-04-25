#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// 验证配置
const VALIDATION_CHECKS = {
    // 必需的函数
    requiredFunctions: [
        'initMobileNavigation',
        'syncMobileNavigation',
        'mobileNavigateTo',
        'showPage'
    ],
    
    // 必需的HTML元素
    requiredElements: [
        'mobile-nav',
        'mobile-nav-item',
        'mobile-nav-icon',
        'mobile-nav-label'
    ],
    
    // 必需的CSS类
    requiredCSS: [
        '.mobile-nav',
        '.mobile-nav-item',
        '.mobile-nav-item.active',
        '@media (max-width: 768px)'
    ],
    
    // 必需的事件监听器
    requiredEventListeners: [
        'DOMContentLoaded',
        'resize',
        'click'
    ]
};

class MobileNavValidator {
    constructor(filePath) {
        this.filePath = filePath;
        this.content = '';
        this.errors = [];
        this.warnings = [];
        this.passed = [];
    }

    loadFile() {
        try {
            this.content = fs.readFileSync(this.filePath, 'utf8');
            return true;
        } catch (error) {
            this.addError(`无法读取文件: ${error.message}`);
            return false;
        }
    }

    addError(message) {
        this.errors.push(message);
    }

    addWarning(message) {
        this.warnings.push(message);
    }

    addPass(message) {
        this.passed.push(message);
    }

    validateFunctions() {
        console.log('\n🔍 验证必需函数...');
        
        VALIDATION_CHECKS.requiredFunctions.forEach(funcName => {
            const pattern = new RegExp(`function\\s+${funcName}|${funcName}\\s*=\\s*function|const\\s+${funcName}\\s*=`, 'i');
            if (pattern.test(this.content)) {
                this.addPass(`✅ 函数 ${funcName} 存在`);
            } else {
                this.addError(`❌ 缺少必需函数: ${funcName}`);
            }
        });
    }

    validateHTMLStructure() {
        console.log('\n🔍 验证HTML结构...');
        
        VALIDATION_CHECKS.requiredElements.forEach(elementId => {
            const pattern = new RegExp(`class=["'][^"']*\\b${elementId}\\b[^"']*["']|id=["'][^"']*\\b${elementId}\\b[^"']*["']`, 'i');
            if (pattern.test(this.content)) {
                this.addPass(`✅ HTML元素 ${elementId} 存在`);
            } else {
                this.addError(`❌ 缺少必需HTML元素: ${elementId}`);
            }
        });

        // 检查移动端导航的data-page属性
        const dataPagePattern = /data-page="(dashboard|attendance|approvals|profile)"/g;
        const dataPageMatches = this.content.match(dataPagePattern);
        if (dataPageMatches && dataPageMatches.length >= 4) {
            this.addPass(`✅ 移动端导航项配置完整 (${dataPageMatches.length}个)`);
        } else {
            this.addError(`❌ 移动端导航项配置不完整 (${dataPageMatches ? dataPageMatches.length : 0}个)`);
        }
    }

    validateCSS() {
        console.log('\n🔍 验证CSS样式...');
        
        VALIDATION_CHECKS.requiredCSS.forEach(cssRule => {
            if (this.content.includes(cssRule)) {
                this.addPass(`✅ CSS规则 ${cssRule} 存在`);
            } else {
                this.addWarning(`⚠️  建议添加CSS规则: ${cssRule}`);
            }
        });

        // 检查移动端CSS显示规则
        const mobileDisplayPattern1 = /\.mobile-nav\s*\{[^}]*display\s*:\s*none/;
        const mobileDisplayPattern2 = /@media.*max-width.*768px[^}]*\.mobile-nav[^}]*display\s*:\s*flex/;
        if (mobileDisplayPattern1.test(this.content) && mobileDisplayPattern2.test(this.content)) {
            this.addPass(`✅ 移动端显示规则正确`);
        } else {
            this.addError(`❌ 移动端显示规则缺失或错误`);
        }
    }

    validateEventListeners() {
        console.log('\n🔍 验证事件监听器...');
        
        VALIDATION_CHECKS.requiredEventListeners.forEach(event => {
            const pattern = new RegExp(`addEventListener\\s*\\(\\s*['"]${event}['"]`, 'i');
            if (pattern.test(this.content)) {
                this.addPass(`✅ 事件监听器 ${event} 存在`);
            } else {
                this.addWarning(`⚠️  建议添加事件监听器: ${event}`);
            }
        });

        // 检查初始化调用
        if (this.content.includes('initMobileNavigation()')) {
            this.addPass(`✅ 移动端导航初始化调用存在`);
        } else {
            this.addError(`❌ 缺少移动端导航初始化调用`);
        }
    }

    validateLogicFlow() {
        console.log('\n🔍 验证逻辑流程...');
        
        // 检查页面切换时的同步调用
        const syncCallPattern = /syncMobileNavigation\s*\(\s*pageName\s*\)/;
        if (syncCallPattern.test(this.content)) {
            this.addPass(`✅ 页面切换同步调用正确`);
        } else {
            this.addError(`❌ 缺少页面切换同步调用`);
        }

        // 检查移动端检测逻辑
        const mobileCheckPattern = /window\.innerWidth\s*<=\s*768/;
        if (mobileCheckPattern.test(this.content)) {
            this.addPass(`✅ 移动端检测逻辑正确`);
        } else {
            this.addError(`❌ 移动端检测逻辑错误`);
        }

        // 检查错误处理
        const nullCheckPattern = /if\s*\([^)]*\)\s*\{[^}]*style\./;
        if (nullCheckPattern.test(this.content)) {
            this.addPass(`✅ 包含空值检查`);
        } else {
            this.addWarning(`⚠️  建议添加空值检查`);
        }
    }

    validatePerformance() {
        console.log('\n🔍 验证性能优化...');
        
        // 检查是否有性能优化措施
        const performanceChecks = [
            { pattern: /console\.log/, message: '包含调试日志（生产环境建议移除）', type: 'warning' },
            { pattern: /querySelector.*forEach/, message: '使用forEach进行批量操作', type: 'pass' },
            { pattern: /classList\.(add|remove)/, message: '使用classList进行样式操作', type: 'pass' }
        ];

        performanceChecks.forEach(check => {
            if (check.pattern.test(this.content)) {
                if (check.type === 'pass') {
                    this.addPass(`✅ ${check.message}`);
                } else if (check.type === 'warning') {
                    this.addWarning(`⚠️  ${check.message}`);
                }
            }
        });
    }

    runValidation() {
        console.log('🚀 开始移动端导航功能验证...\n');
        console.log(`📁 验证文件: ${this.filePath}`);

        if (!this.loadFile()) {
            return false;
        }

        // 执行所有验证
        this.validateFunctions();
        this.validateHTMLStructure();
        this.validateCSS();
        this.validateEventListeners();
        this.validateLogicFlow();
        this.validatePerformance();

        // 输出结果
        this.printResults();

        return this.errors.length === 0;
    }

    printResults() {
        console.log('\n' + '='.repeat(60));
        console.log('📊 验证结果汇总');
        console.log('='.repeat(60));

        console.log(`\n✅ 通过检查 (${this.passed.length}):`);
        this.passed.forEach(item => console.log(`  ${item}`));

        if (this.warnings.length > 0) {
            console.log(`\n⚠️  警告信息 (${this.warnings.length}):`);
            this.warnings.forEach(item => console.log(`  ${item}`));
        }

        if (this.errors.length > 0) {
            console.log(`\n❌ 错误信息 (${this.errors.length}):`);
            this.errors.forEach(item => console.log(`  ${item}`));
        }

        console.log('\n' + '='.repeat(60));
        
        const totalChecks = this.passed.length + this.warnings.length + this.errors.length;
        const passRate = ((this.passed.length / totalChecks) * 100).toFixed(1);
        
        console.log(`📈 验证统计:`);
        console.log(`  - 总检查项: ${totalChecks}`);
        console.log(`  - 通过: ${this.passed.length}`);
        console.log(`  - 警告: ${this.warnings.length}`);
        console.log(`  - 错误: ${this.errors.length}`);
        console.log(`  - 通过率: ${passRate}%`);

        if (this.errors.length === 0) {
            console.log('\n🎉 验证通过！移动端导航功能符合要求。');
        } else {
            console.log('\n🚨 验证失败！请修复错误后重新验证。');
        }
    }
}

// 执行验证
if (require.main === module) {
    const filePath = process.argv[2] || './working-fixed.html';
    const validator = new MobileNavValidator(filePath);
    const success = validator.runValidation();
    
    process.exit(success ? 0 : 1);
}

module.exports = MobileNavValidator;
