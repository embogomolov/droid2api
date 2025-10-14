/**
 * 关键词过滤管理前端 UI
 */

let currentEditingRuleId = null;
let filterRules = [];
let filterConfig = {};

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', () => {
    // 监听 tab 切换，当切换到关键词过滤 tab 时加载数据
    const originalSwitchTab = window.switchTab;
    if (originalSwitchTab) {
        window.switchTab = function(tabName) {
            originalSwitchTab(tabName);
            if (tabName === 'keywordFilter') {
                loadFilterData();
            }
        };
    }
});

// 加载过滤器数据
async function loadFilterData() {
    try {
        const response = await fetch('/admin/keyword-filter/config', {
            headers: {
                'x-admin-key': localStorage.getItem('adminKey')
            }
        });

        if (response.ok) {
            const result = await response.json();
            filterConfig = result.data;
            filterRules = result.data.rules || [];
            
            updateFilterStats();
            renderFilterRules();
        } else {
            showNotification('加载配置失败', 'error');
        }
    } catch (error) {
        console.error('Failed to load filter data:', error);
        showNotification('加载配置失败: ' + error.message, 'error');
    }
}

// 更新统计信息
function updateFilterStats() {
    const total = filterRules.length;
    const enabledCount = filterRules.filter(r => r.enabled).length;

    const totalEl = document.getElementById('filterStatTotal');
    if (totalEl) {
        totalEl.textContent = total;
    }

    const enabledEl = document.getElementById('filterStatEnabled');
    if (enabledEl) {
        enabledEl.textContent = enabledCount;
    }

    const statusEl = document.getElementById('filterStatStatus');
    if (statusEl) {
        statusEl.textContent = filterConfig.enabled ? '✅ 已启用' : '⚪ 已关闭';
    }

    const statusPill = document.querySelector('.keyword-status-pill');
    if (statusPill) {
        statusPill.classList.toggle('is-enabled', filterConfig.enabled);
        statusPill.classList.toggle('is-disabled', !filterConfig.enabled);
    }

    const coverageEl = document.getElementById('filterCoverageValue');
    if (coverageEl) {
        const percent = total === 0 ? 0 : Math.round((enabledCount / total) * 100);
        coverageEl.textContent = `${percent}%`;
    }

    const tableCountEl = document.getElementById('keywordTableCount');
    if (tableCountEl) {
        tableCountEl.textContent = total;
    }

    const btn = document.getElementById('toggleGlobalBtn');
    if (btn) {
        btn.textContent = filterConfig.enabled ? '❌ 关闭全局过滤' : '✅ 启用全局过滤';
        btn.className = filterConfig.enabled
            ? 'btn keyword-action-btn keyword-toggle is-active'
            : 'btn keyword-action-btn keyword-toggle';
    }
}

// 渲染规则列表
function renderFilterRules() {
    const tbody = document.getElementById('filterRulesTable');
    
    if (filterRules.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">暂无过滤规则，点击“添加规则”按钮创建</td></tr>';
        return;
    }

    const patternLabels = {
        contains: '包含匹配',
        exact: '精确匹配',
        startsWith: '开头匹配',
        endsWith: '结尾匹配',
        regex: '正则表达式'
    };

    const actionLabels = {
        replace: '替换',
        delete_keyword: '删除关键词',
        block: '阻止'
    };
    const deleteModeLabels = {
        inline: '逐字删除',
        targets: '指定词',
        segment: '整段'
    };

    tbody.innerHTML = filterRules.map(rule => {
        const statusClass = rule.enabled ? 'enabled' : 'disabled';
        const patternLabel = patternLabels[rule.pattern.type] || rule.pattern.type;
        const actionLabel = actionLabels[rule.action.type] || rule.action.type;
        const actionChips = [`<span class="keyword-chip action-${rule.action.type}">${actionLabel}</span>`];
        let actionDetail = '—';

        if (rule.action.type === 'replace') {
            actionDetail = `<code>${escapeHtml(rule.action.replacement || '（空）')}</code>`;
        } else if (rule.action.type === 'delete_keyword') {
            const mode = rule.action.mode || 'inline';
            actionChips.push(`<span class="keyword-chip chip-outline">${deleteModeLabels[mode] || mode}</span>`);

            if (mode === 'targets' && Array.isArray(rule.action.targets) && rule.action.targets.length > 0) {
                actionDetail = rule.action.targets.map(escapeHtml).join(', ');
            } else if (mode === 'segment') {
                const meta = [
                    `分隔符 <code>${escapeHtml(rule.action.delimiter || '\\n\\n')}</code>`
                ];
                if (typeof rule.action.minLength === 'number') {
                    meta.push(`最小长度 ≥ ${rule.action.minLength}`);
                }
                if (Array.isArray(rule.action.preserveKeywords) && rule.action.preserveKeywords.length > 0) {
                    meta.push(`保留关键词: ${rule.action.preserveKeywords.map(escapeHtml).join(', ')}`);
                }
                actionDetail = meta.join('<br/>');
            }
        }
        // BaSui：修复按钮点击问题 - 不要对参数使用 escapeHtml + JSON.stringify 组合
        // 只需要对 ID 和名称进行单引号转义，生成正确的 onclick 属性
        const ruleIdArg = `'${rule.id.replace(/'/g, "\\'")}'`;
        const ruleNameArg = `'${rule.name.replace(/'/g, "\\'")}'`;

        return `
        <tr class="rule-row ${statusClass}">
            <td>
                <span class="keyword-rule-status ${statusClass}">
                    <span class="status-dot"></span>${rule.enabled ? '启用' : '禁用'}
                </span>
            </td>
            <td>
                <div class="keyword-rule-name">${escapeHtml(rule.name)}</div>
                <div class="keyword-rule-description">${escapeHtml(rule.description || '暂无描述')}</div>
            </td>
            <td>
                <div class="keyword-chip-group">
                    <span class="keyword-chip">${patternLabel}</span>
                    ${rule.pattern.caseSensitive ? '<span class="keyword-chip chip-outline">🔡 区分大小写</span>' : ''}
                </div>
                <div class="keyword-rule-pattern"><code>${escapeHtml(rule.pattern.value)}</code></div>
            </td>
            <td>
                <div class="keyword-chip-group">
                    ${actionChips.join('')}
                </div>
                <div class="keyword-rule-replacement">${actionDetail}</div>
            </td>
            <td>
                <div class="keyword-row-actions">
                    <button onclick="toggleRuleStatus(${ruleIdArg})" class="btn btn-sm keyword-row-btn keyword-row-btn-toggle ${statusClass}" title="${rule.enabled ? '禁用规则' : '启用规则'}">
                        ${rule.enabled ? '⏸️' : '▶️'}
                    </button>
                    <button onclick="editRule(${ruleIdArg})" class="btn btn-sm keyword-row-btn keyword-row-btn-edit" title="编辑规则">
                        ✏️
                    </button>
                    <button onclick="deleteRule(${ruleIdArg}, ${ruleNameArg})" class="btn btn-sm keyword-row-btn keyword-row-btn-delete" title="删除规则">
                        🗑️
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

// 切换全局过滤状态
async function toggleGlobalFilter() {
    if (!confirm(`确定要${filterConfig.enabled ? '关闭' : '启用'}全局过滤吗？`)) {
        return;
    }

    try {
        const response = await fetch('/admin/keyword-filter/toggle', {
            method: 'PATCH',
            headers: {
                'x-admin-key': localStorage.getItem('adminKey')
            }
        });

        if (response.ok) {
            const result = await response.json();
            filterConfig.enabled = result.data.enabled;
            updateFilterStats();
            showNotification(`全局过滤已${result.data.enabled ? '启用' : '关闭'}`, 'success');
        } else {
            showNotification('操作失败', 'error');
        }
    } catch (error) {
        console.error('Failed to toggle global filter:', error);
        showNotification('操作失败: ' + error.message, 'error');
    }
}

// 显示添加规则模态框
function showAddRuleModal() {
    currentEditingRuleId = null;
    document.getElementById('ruleModalTitle').textContent = '➕ 添加过滤规则';
    document.getElementById('saveRuleBtn').textContent = '💾 保存规则';
    
    // 清空表单
    document.getElementById('ruleName').value = '';
    document.getElementById('rulePatternType').value = 'contains';
    document.getElementById('rulePatternValue').value = '';
    document.getElementById('ruleCaseSensitive').checked = false;
    document.getElementById('ruleActionType').value = 'replace';
    document.getElementById('ruleReplacement').value = '';
    document.getElementById('ruleDeleteMode').value = 'inline';
    document.getElementById('ruleDeleteTargets').value = '';
    document.getElementById('ruleDeleteDelimiter').value = '';
    document.getElementById('ruleDeleteMinLength').value = '';
    document.getElementById('ruleDeletePreserveKeywords').value = '';
    document.getElementById('ruleDescription').value = '';
    document.getElementById('ruleEnabled').checked = true;
    
    updatePatternHint();
    updateActionFields();
    
    openModal('ruleModal');
}

// 编辑规则
function editRule(ruleId) {
    const rule = filterRules.find(r => r.id === ruleId);
    if (!rule) {
        showNotification('规则不存在', 'error');
        return;
    }

    currentEditingRuleId = ruleId;
    document.getElementById('ruleModalTitle').textContent = '✏️ 编辑过滤规则';
    document.getElementById('saveRuleBtn').textContent = '💾 更新规则';
    
    // 填充表单
    document.getElementById('ruleName').value = rule.name;
    document.getElementById('rulePatternType').value = rule.pattern.type;
    document.getElementById('rulePatternValue').value = rule.pattern.value;
    document.getElementById('ruleCaseSensitive').checked = rule.pattern.caseSensitive || false;
    document.getElementById('ruleActionType').value = rule.action.type;
    document.getElementById('ruleReplacement').value = rule.action.replacement || '';
    document.getElementById('ruleDeleteMode').value = rule.action.mode || 'inline';
    document.getElementById('ruleDeleteTargets').value = Array.isArray(rule.action.targets)
        ? rule.action.targets.join(', ')
        : '';
    document.getElementById('ruleDeleteDelimiter').value = rule.action.delimiter || '';
    document.getElementById('ruleDeleteMinLength').value = rule.action.minLength ?? '';
    document.getElementById('ruleDeletePreserveKeywords').value = Array.isArray(rule.action.preserveKeywords)
        ? rule.action.preserveKeywords.join(', ')
        : '';
    document.getElementById('ruleDescription').value = rule.description || '';
    document.getElementById('ruleEnabled').checked = rule.enabled;
    
    updatePatternHint();
    updateActionFields();
    
    openModal('ruleModal');
}

// 保存规则
async function saveRule() {
    const name = document.getElementById('ruleName').value.trim();
    const patternType = document.getElementById('rulePatternType').value;
    const patternValue = document.getElementById('rulePatternValue').value.trim();
    const caseSensitive = document.getElementById('ruleCaseSensitive').checked;
    const actionType = document.getElementById('ruleActionType').value;
    const replacement = document.getElementById('ruleReplacement').value;
    const deleteMode = document.getElementById('ruleDeleteMode').value;
    const deleteTargetsInput = document.getElementById('ruleDeleteTargets').value;
    const deleteDelimiter = document.getElementById('ruleDeleteDelimiter').value;
    const deleteMinLengthValue = document.getElementById('ruleDeleteMinLength').value;
    const deletePreserveKeywordsInput = document.getElementById('ruleDeletePreserveKeywords').value;
    const description = document.getElementById('ruleDescription').value.trim();
    const enabled = document.getElementById('ruleEnabled').checked;

    // 验证
    if (!name) {
        showNotification('请输入规则名称', 'error');
        return;
    }
    if (!patternValue) {
        showNotification('请输入匹配值', 'error');
        return;
    }

    const ruleData = {
        name,
        enabled,
        pattern: {
            type: patternType,
            value: patternValue,
            caseSensitive
        },
        action: {
            type: actionType
        },
        description
    };

    if (actionType === 'replace') {
        ruleData.action.replacement = replacement;
    } else if (actionType === 'delete_keyword') {
        ruleData.action.mode = deleteMode;

        if (deleteMode === 'targets') {
            const targets = deleteTargetsInput
                .split(/[\n,]/)
                .map(item => item.trim())
                .filter(Boolean);

            if (targets.length === 0) {
                showNotification('请至少填写一个要删除的关键词', 'error');
                return;
            }

            ruleData.action.targets = targets;
        }

        if (deleteMode === 'segment') {
            ruleData.action.delimiter = deleteDelimiter.trim();

            if (deleteMinLengthValue !== '') {
                const minLengthNumber = Number(deleteMinLengthValue);
                if (Number.isNaN(minLengthNumber) || minLengthNumber < 0) {
                    showNotification('最小段落长度必须是大于等于 0 的数字', 'error');
                    return;
                }
                ruleData.action.minLength = minLengthNumber;
            }

            const preserveKeywords = deletePreserveKeywordsInput
                .split(/[\n,]/)
                .map(item => item.trim())
                .filter(Boolean);

            if (preserveKeywords.length > 0) {
                ruleData.action.preserveKeywords = preserveKeywords;
            }
        }
    }

    try {
        const url = currentEditingRuleId 
            ? `/admin/keyword-filter/rules/${currentEditingRuleId}`
            : '/admin/keyword-filter/rules';
        
        const method = currentEditingRuleId ? 'PUT' : 'POST';

        const response = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'x-admin-key': localStorage.getItem('adminKey')
            },
            body: JSON.stringify(ruleData)
        });

        if (response.ok) {
            showNotification(currentEditingRuleId ? '规则已更新' : '规则已添加', 'success');
            closeModal('ruleModal');
            loadFilterData();
        } else {
            const result = await response.json();
            showNotification('保存失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('Failed to save rule:', error);
        showNotification('保存失败: ' + error.message, 'error');
    }
}

// 删除规则
async function deleteRule(ruleId, ruleName) {
    if (!confirm(`确定要删除规则"${ruleName}"吗？此操作不可恢复！`)) {
        return;
    }

    try {
        const response = await fetch(`/admin/keyword-filter/rules/${ruleId}`, {
            method: 'DELETE',
            headers: {
                'x-admin-key': localStorage.getItem('adminKey')
            }
        });

        if (response.ok) {
            showNotification('规则已删除', 'success');
            loadFilterData();
        } else {
            showNotification('删除失败', 'error');
        }
    } catch (error) {
        console.error('Failed to delete rule:', error);
        showNotification('删除失败: ' + error.message, 'error');
    }
}

// 切换规则状态
async function toggleRuleStatus(ruleId) {
    try {
        const response = await fetch(`/admin/keyword-filter/rules/${ruleId}/toggle`, {
            method: 'PATCH',
            headers: {
                'x-admin-key': localStorage.getItem('adminKey')
            }
        });

        if (response.ok) {
            const result = await response.json();
            showNotification(`规则已${result.data.rule.enabled ? '启用' : '禁用'}`, 'success');
            loadFilterData();
        } else {
            showNotification('操作失败', 'error');
        }
    } catch (error) {
        console.error('Failed to toggle rule:', error);
        showNotification('操作失败: ' + error.message, 'error');
    }
}

// 重新加载配置
async function reloadFilterConfig() {
    try {
        const response = await fetch('/admin/keyword-filter/reload', {
            method: 'POST',
            headers: {
                'x-admin-key': localStorage.getItem('adminKey')
            }
        });

        if (response.ok) {
            showNotification('配置已重新加载', 'success');
            loadFilterData();
        } else {
            showNotification('重新加载失败', 'error');
        }
    } catch (error) {
        console.error('Failed to reload config:', error);
        showNotification('重新加载失败: ' + error.message, 'error');
    }
}

// 显示测试规则模态框
function showTestRuleModal() {
    // 填充规则选择下拉框
    const select = document.getElementById('testRuleSelect');
    select.innerHTML = '<option value="">测试所有规则</option>';
    filterRules.forEach(rule => {
        select.innerHTML += `<option value="${rule.id}">${escapeHtml(rule.name)} (${rule.pattern.type})</option>`;
    });

    // 清空测试结果
    document.getElementById('testRuleResult').style.display = 'none';
    document.getElementById('testText').value = '';

    openModal('testRuleModal');
}

// 运行测试规则
async function runTestRule() {
    const ruleId = document.getElementById('testRuleSelect').value;
    const text = document.getElementById('testText').value;

    if (!text) {
        showNotification('请输入测试文本', 'error');
        return;
    }

    try {
        const response = await fetch('/admin/keyword-filter/test', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-key': localStorage.getItem('adminKey')
            },
            body: JSON.stringify({
                text,
                ruleId: ruleId || undefined
            })
        });

        if (response.ok) {
            const result = await response.json();
            displayTestResult(result.data);
        } else {
            const result = await response.json();
            showNotification('测试失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('Failed to test rule:', error);
        showNotification('测试失败: ' + error.message, 'error');
    }
}

// 显示测试结果
function displayTestResult(data) {
    document.getElementById('testOriginalText').textContent = data.original;
    document.getElementById('testFilteredText').textContent = data.filtered || data.original;
    
    const matchInfo = document.getElementById('testMatchInfo');
    if (data.matched !== undefined) {
        // 单个规则测试
        matchInfo.innerHTML = `
            <p><strong>匹配状态：</strong>${data.matched ? '✅ 匹配' : '❌ 不匹配'}</p>
            <p><strong>规则名称：</strong>${escapeHtml(data.rule)}</p>
        `;
    } else {
        // 所有规则测试
        matchInfo.innerHTML = `
            <p><strong>是否改变：</strong>${data.changed ? '✅ 是' : '❌ 否'}</p>
        `;
    }

    document.getElementById('testRuleResult').style.display = 'block';
}

// 更新匹配类型提示
function updatePatternHint() {
    const type = document.getElementById('rulePatternType').value;
    const hints = {
        contains: '💡 包含匹配：只要文本中出现该关键词就会匹配',
        exact: '💡 精确匹配：只有完全相同的文本才会匹配',
        startsWith: '💡 开头匹配：文本以该关键词开头时匹配',
        endsWith: '💡 结尾匹配：文本以该关键词结尾时匹配',
        regex: '💡 正则表达式：使用强大的正则表达式进行匹配 (例如: \\b(密码|密钥)\\b)'
    };
    document.getElementById('patternHint').textContent = hints[type] || '';
}

// 更新动作字段显示
function updateActionFields() {
    const type = document.getElementById('ruleActionType').value;
    const replacementField = document.getElementById('replacementField');
    const deleteModeField = document.getElementById('deleteModeField');
    const deleteTargetsField = document.getElementById('deleteTargetsField');
    const deleteDelimiterField = document.getElementById('deleteDelimiterField');
    const deleteMinLengthField = document.getElementById('deleteMinLengthField');
    const deletePreserveKeywordsField = document.getElementById('deletePreserveKeywordsField');
    const deleteModeSelect = document.getElementById('ruleDeleteMode');
    const deleteMode = deleteModeSelect ? deleteModeSelect.value : 'inline';

    if (type === 'replace') {
        replacementField.style.display = 'block';
    } else {
        replacementField.style.display = 'none';
    }

    if (type === 'delete_keyword') {
        deleteModeField.style.display = 'block';

        if (deleteMode === 'targets') {
            deleteTargetsField.style.display = 'block';
        } else {
            deleteTargetsField.style.display = 'none';
        }

        if (deleteMode === 'segment') {
            deleteDelimiterField.style.display = 'block';
            deleteMinLengthField.style.display = 'block';
            deletePreserveKeywordsField.style.display = 'block';
        } else {
            deleteDelimiterField.style.display = 'none';
            deleteMinLengthField.style.display = 'none';
            deletePreserveKeywordsField.style.display = 'none';
        }
    } else {
        deleteModeField.style.display = 'none';
        deleteTargetsField.style.display = 'none';
        deleteDelimiterField.style.display = 'none';
        deleteMinLengthField.style.display = 'none';
        deletePreserveKeywordsField.style.display = 'none';
    }
}

// HTML 转义
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 显示通知 (内部函数，直接使用alert)
function showNotification(message, type = 'info') {
    const typeIcons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
    };
    const icon = typeIcons[type] || typeIcons.info;
    alert(`${icon} ${message}`);
}

// 打开模态框
function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'block';
    }
}

// 关闭模态框
function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'none';
    }
}

// 导出到全局作用域，供 HTML onclick 使用
// 注意：这些函数必须在定义后导出，所以放在文件末尾
if (typeof window !== 'undefined') {
    window.loadFilterData = loadFilterData;
    window.toggleGlobalFilter = toggleGlobalFilter;
    window.showAddRuleModal = showAddRuleModal;
    window.editRule = editRule;
    window.saveRule = saveRule;
    window.deleteRule = deleteRule;
    window.toggleRuleStatus = toggleRuleStatus;
    window.reloadFilterConfig = reloadFilterConfig;
    window.showTestRuleModal = showTestRuleModal;
    window.runTestRule = runTestRule;
    window.updatePatternHint = updatePatternHint;
    window.updateActionFields = updateActionFields;
    
    // 这些函数可能在 app.js 中已定义，只在不存在时才导出
    if (!window.openModal) {
        window.openModal = openModal;
    }
    if (!window.closeModal) {
        window.closeModal = closeModal;
    }
    // showNotification 保持为内部函数，不导出到 window
}
