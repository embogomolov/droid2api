/**
 * Keyword filter management UI
 */

let currentEditingRuleId = null;
let filterRules = [];
let filterConfig = {};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Load data when the keyword filter tab is selected
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

// Load filter data
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
            showNotification('Failed to load configuration', 'error');
        }
    } catch (error) {
        console.error('Failed to load filter data:', error);
        showNotification('Failed to load configuration: ' + error.message, 'error');
    }
}

// Update statistics
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
        statusEl.textContent = filterConfig.enabled ? '✅ Enabled' : '⚪ Disabled';
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
        btn.textContent = filterConfig.enabled ? '❌ Disable global filtering' : '✅ Enable global filtering';
        btn.className = filterConfig.enabled
            ? 'btn keyword-action-btn keyword-toggle is-active'
            : 'btn keyword-action-btn keyword-toggle';
    }
}

// Render the rule list
function renderFilterRules() {
    const tbody = document.getElementById('filterRulesTable');
    
    if (filterRules.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No filter rules yet. Click Add rule to create one.</td></tr>';
        return;
    }

    const patternLabels = {
        contains: 'Contains',
        exact: 'Exact match',
        startsWith: 'Starts with',
        endsWith: 'Ends with',
        regex: 'Regular expression'
    };

    const actionLabels = {
        replace: 'Replace',
        delete_keyword: 'Delete keywords',
        block: 'Clear text'
    };
    const deleteModeLabels = {
        inline: 'Remove matches',
        targets: 'Specified keywords',
        segment: 'Whole segment'
    };

    tbody.innerHTML = filterRules.map(rule => {
        const statusClass = rule.enabled ? 'enabled' : 'disabled';
        const patternLabel = patternLabels[rule.pattern.type] || rule.pattern.type;
        const actionLabel = actionLabels[rule.action.type] || rule.action.type;
        const actionChips = [`<span class="keyword-chip action-${rule.action.type}">${actionLabel}</span>`];
        let actionDetail = '—';

        if (rule.action.type === 'replace') {
            actionDetail = `<code>${escapeHtml(rule.action.replacement || '(empty)')}</code>`;
        } else if (rule.action.type === 'delete_keyword') {
            const mode = rule.action.mode || 'inline';
            actionChips.push(`<span class="keyword-chip chip-outline">${deleteModeLabels[mode] || mode}</span>`);

            if (mode === 'targets' && Array.isArray(rule.action.targets) && rule.action.targets.length > 0) {
                actionDetail = rule.action.targets.map(escapeHtml).join(', ');
            } else if (mode === 'segment') {
                const meta = [
                    `Delimiter <code>${escapeHtml(rule.action.delimiter || '\\n\\n')}</code>`
                ];
                if (typeof rule.action.minLength === 'number') {
                    meta.push(`Minimum length ≥ ${rule.action.minLength}`);
                }
                if (Array.isArray(rule.action.preserveKeywords) && rule.action.preserveKeywords.length > 0) {
                    meta.push(`Preserve keywords: ${rule.action.preserveKeywords.map(escapeHtml).join(', ')}`);
                }
                actionDetail = meta.join('<br/>');
            }
        }
        // BaSui: Fix button handlers; do not combine escapeHtml and JSON.stringify for arguments
        // Escape single quotes in the ID and name to generate the onclick attribute
        const ruleIdArg = `'${rule.id.replace(/'/g, "\\'")}'`;
        const ruleNameArg = `'${rule.name.replace(/'/g, "\\'")}'`;

        return `
        <tr class="rule-row ${statusClass}">
            <td>
                <span class="keyword-rule-status ${statusClass}">
                    <span class="status-dot"></span>${rule.enabled ? 'Enabled' : 'Disabled'}
                </span>
            </td>
            <td>
                <div class="keyword-rule-name">${escapeHtml(rule.name)}</div>
                <div class="keyword-rule-description">${escapeHtml(rule.description || 'No description')}</div>
            </td>
            <td>
                <div class="keyword-chip-group">
                    <span class="keyword-chip">${patternLabel}</span>
                    ${rule.pattern.caseSensitive ? '<span class="keyword-chip chip-outline">🔡 Case sensitive</span>' : ''}
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
                    <button onclick="toggleRuleStatus(${ruleIdArg})" class="btn btn-sm keyword-row-btn keyword-row-btn-toggle ${statusClass}" title="${rule.enabled ? 'Disable rule' : 'Enable rule'}">
                        ${rule.enabled ? '⏸️' : '▶️'}
                    </button>
                    <button onclick="editRule(${ruleIdArg})" class="btn btn-sm keyword-row-btn keyword-row-btn-edit" title="Edit rule">
                        ✏️
                    </button>
                    <button onclick="deleteRule(${ruleIdArg}, ${ruleNameArg})" class="btn btn-sm keyword-row-btn keyword-row-btn-delete" title="Delete rule">
                        🗑️
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

// Toggle global filtering
async function toggleGlobalFilter() {
    if (!confirm(`${filterConfig.enabled ? 'Disable' : 'Enable'} global filtering?`)) {
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
            showNotification(`Global filtering ${result.data.enabled ? 'enabled' : 'disabled'}`, 'success');
        } else {
            showNotification('Action failed', 'error');
        }
    } catch (error) {
        console.error('Failed to toggle global filter:', error);
        showNotification('Action failed: ' + error.message, 'error');
    }
}

// Show the Add rule dialog
function showAddRuleModal() {
    currentEditingRuleId = null;
    document.getElementById('ruleModalTitle').textContent = '➕ Add filter rule';
    document.getElementById('saveRuleBtn').textContent = '💾 Save rule';
    
    // Clear the form
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

// Edit rule
function editRule(ruleId) {
    const rule = filterRules.find(r => r.id === ruleId);
    if (!rule) {
        showNotification('Rule not found', 'error');
        return;
    }

    currentEditingRuleId = ruleId;
    document.getElementById('ruleModalTitle').textContent = '✏️ Edit filter rule';
    document.getElementById('saveRuleBtn').textContent = '💾 Update rule';
    
    // Populate the form
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

// Save rule
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

    // Validate
    if (!name) {
        showNotification('Enter a rule name', 'error');
        return;
    }
    if (!patternValue) {
        showNotification('Enter a pattern to match', 'error');
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
                showNotification('Enter at least one keyword to delete', 'error');
                return;
            }

            ruleData.action.targets = targets;
        }

        if (deleteMode === 'segment') {
            ruleData.action.delimiter = deleteDelimiter.trim();

            if (deleteMinLengthValue !== '') {
                const minLengthNumber = Number(deleteMinLengthValue);
                if (Number.isNaN(minLengthNumber) || minLengthNumber < 0) {
                    showNotification('Minimum segment length must be a number greater than or equal to 0.', 'error');
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
            showNotification(currentEditingRuleId ? 'Rule updated' : 'Rule added', 'success');
            closeModal('ruleModal');
            loadFilterData();
        } else {
            const result = await response.json();
            showNotification('Failed to save: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        console.error('Failed to save rule:', error);
        showNotification('Failed to save: ' + error.message, 'error');
    }
}

// Delete rule
async function deleteRule(ruleId, ruleName) {
    if (!confirm(`Delete rule "${ruleName}"? This cannot be undone.`)) {
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
            showNotification('Rule deleted', 'success');
            loadFilterData();
        } else {
            showNotification('Failed to delete rule', 'error');
        }
    } catch (error) {
        console.error('Failed to delete rule:', error);
        showNotification('Failed to delete rule: ' + error.message, 'error');
    }
}

// Toggle rule status
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
            showNotification(`Rule ${result.data.rule.enabled ? 'enabled' : 'disabled'}`, 'success');
            loadFilterData();
        } else {
            showNotification('Action failed', 'error');
        }
    } catch (error) {
        console.error('Failed to toggle rule:', error);
        showNotification('Action failed: ' + error.message, 'error');
    }
}

// Reload configuration
async function reloadFilterConfig() {
    try {
        const response = await fetch('/admin/keyword-filter/reload', {
            method: 'POST',
            headers: {
                'x-admin-key': localStorage.getItem('adminKey')
            }
        });

        if (response.ok) {
            showNotification('Configuration reloaded', 'success');
            loadFilterData();
        } else {
            showNotification('Failed to reload', 'error');
        }
    } catch (error) {
        console.error('Failed to reload config:', error);
        showNotification('Failed to reload: ' + error.message, 'error');
    }
}

// Show the Test rule dialog
function showTestRuleModal() {
    // Populate the rule selector
    const select = document.getElementById('testRuleSelect');
    select.innerHTML = '<option value="">Test all rules</option>';
    filterRules.forEach(rule => {
        select.innerHTML += `<option value="${rule.id}">${escapeHtml(rule.name)} (${rule.pattern.type})</option>`;
    });

    // Clear test results
    document.getElementById('testRuleResult').style.display = 'none';
    document.getElementById('testText').value = '';

    openModal('testRuleModal');
}

// Run the rule test
async function runTestRule() {
    const ruleId = document.getElementById('testRuleSelect').value;
    const text = document.getElementById('testText').value;

    if (!text) {
        showNotification('Enter text to test', 'error');
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
            showNotification('Test failed: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        console.error('Failed to test rule:', error);
        showNotification('Test failed: ' + error.message, 'error');
    }
}

// Display test results
function displayTestResult(data) {
    document.getElementById('testOriginalText').textContent = data.original;
    document.getElementById('testFilteredText').textContent = data.filtered || data.original;
    
    const matchInfo = document.getElementById('testMatchInfo');
    if (data.matched !== undefined) {
        // Single-rule test
        matchInfo.innerHTML = `
            <p><strong>Match status:</strong>${data.matched ? '✅ Matched' : '❌ Not matched'}</p>
            <p><strong>Rule name:</strong>${escapeHtml(data.rule)}</p>
        `;
    } else {
        // Test all rules
        matchInfo.innerHTML = `
            <p><strong>Text changed:</strong>${data.changed ? '✅ Yes' : '❌ No'}</p>
        `;
    }

    document.getElementById('testRuleResult').style.display = 'block';
}

// Update the pattern type hint
function updatePatternHint() {
    const type = document.getElementById('rulePatternType').value;
    const hints = {
        contains: '💡 Contains: matches when the keyword occurs anywhere in the text.',
        exact: '💡 Exact: matches only when the entire text equals the pattern.',
        startsWith: '💡 Starts with: matches when the text begins with the keyword.',
        endsWith: '💡 Ends with: matches when the text ends with the keyword.',
        regex: '💡 Regex: match using a regular expression (e.g. \\b(password|key)\\b).'
    };
    document.getElementById('patternHint').textContent = hints[type] || '';
}

// Update action field visibility
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

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Display a notification (internal helper using alert)
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

// Open a dialog
function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'block';
    }
}

// Close a dialog
function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'none';
    }
}

// Export to the global scope for HTML onclick handlers
// Export after the function definitions, at the end of the file
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
    
    // Export only if these helpers were not already defined in app.js
    if (!window.openModal) {
        window.openModal = openModal;
    }
    if (!window.closeModal) {
        window.closeModal = closeModal;
    }
    // Keep showNotification internal; do not export it to window
}
