// ========== Multi-tier key pool management (BaSui) ==========
// Check dependencies: adminKey must be defined
if (typeof adminKey === 'undefined') {
    console.error('❌ Load pool-groups.js after app.js; adminKey is undefined.');
}

// Global pool data
let poolGroupsData = [];
let currentChangePoolKeyId = null;

/**
 * Load and display pool statistics
 */
async function loadPoolGroups() {
    try {
        // Fetch key pool and token usage statistics concurrently
        const [poolResponse, tokenResponse] = await Promise.all([
            fetch('/admin/pool-groups', {
                headers: { 'x-admin-key': adminKey }
            }),
            fetch('/admin/token/by-pool', {
                headers: { 'x-admin-key': adminKey }
            })
        ]);

        if (!poolResponse.ok) {
            throw new Error(`Failed to load pools: ${poolResponse.status}`);
        }

        const poolResult = await poolResponse.json();
        if (poolResult.success) {
            poolGroupsData = poolResult.data || [];
            
            // Merge token statistics when the request succeeds
            if (tokenResponse.ok) {
                const tokenResult = await tokenResponse.json();
                if (tokenResult.success) {
                    const tokenPools = tokenResult.data.pools;
                    
                    // Merge token statistics into the key pool data
                    poolGroupsData.forEach(pool => {
                        const tokenStats = tokenPools[pool.id];
                        if (tokenStats) {
                            pool.token_stats = {
                                total_used: tokenStats.total_used,
                                total_limit: tokenStats.total_limit,
                                total_remaining: tokenStats.total_remaining,
                                percentage: tokenStats.percentage,
                                keys_with_data: tokenStats.keys_with_data
                            };
                        }
                    });
                }
            }
            
            renderPoolGroups();
            updatePoolFilterDropdown();
            updatePoolGroupSelects();
        }
    } catch (err) {
        console.error('Failed to load key pools:', err);
        // Fail quietly without disrupting other features
    }
}

/**
 * Render pool cards
 */
function renderPoolGroups() {
    const container = document.getElementById('poolGroupsContainer');
    const grid = document.getElementById('poolGroupsGrid');

    // 🆕 Always show the container so Create pool remains available even with no pools
    container.style.display = 'block';

    if (!poolGroupsData || poolGroupsData.length === 0) {
        // Show the empty state
        grid.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 40px; background: rgba(255,255,255,0.95); border-radius: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
                <div style="font-size: 3em; margin-bottom: 15px;">🎯</div>
                <h3 style="color: #666; margin-bottom: 10px;">No key pools yet</h3>
                <p style="color: #999; margin-bottom: 20px;">Click Create pool below to create your first key pool.</p>
                <button onclick="showCreatePoolModal()" class="btn btn-primary" style="font-size: 16px; padding: 12px 30px;">
                    ➕ Create your first pool
                </button>
            </div>
        `;
        return;
    }

    // Sort by priority
    const sortedGroups = [...poolGroupsData].sort((a, b) => a.priority - b.priority);

    grid.innerHTML = sortedGroups.map(group => {
        const usagePercent = ((group.active / group.total) * 100).toFixed(0);
        let statusClass = 'pool-group-safe';
        if (group.active === 0) {
            statusClass = 'pool-group-empty';
        } else if (group.active < group.total * 0.3) {
            statusClass = 'pool-group-warning';
        }

        // Optimized token usage display
        let tokenStatsHtml = '';
        if (group.token_stats && group.token_stats.keys_with_data > 0) {
            const { total_used, total_limit, total_remaining, percentage } = group.token_stats;
            const percentNum = parseFloat(percentage);
            let tokenColor = '#10b981';  // Green
            let tokenBgColor = 'rgba(16, 185, 129, 0.1)';
            if (percentNum > 80) {
                tokenColor = '#ef4444';  // Red
                tokenBgColor = 'rgba(239, 68, 68, 0.1)';
            } else if (percentNum > 60) {
                tokenColor = '#f59e0b';  // Orange
                tokenBgColor = 'rgba(245, 158, 11, 0.1)';
            } else if (percentNum > 40) {
                tokenColor = '#fbbf24';  // Yellow
                tokenBgColor = 'rgba(251, 191, 36, 0.1)';
            }

            tokenStatsHtml = `
                <div class="pool-token-section" style="margin-top: 15px; padding: 15px; background: ${tokenBgColor}; border-radius: 12px; border: 2px solid ${tokenColor};">
                    <div class="pool-token-header" style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                        <span style="font-size: 20px;">💰</span>
                        <span style="font-weight: 700; color: ${tokenColor}; font-size: 14px;">Token usage statistics</span>
                    </div>
                    <div class="pool-token-stats" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 12px;">
                        <div class="pool-token-item" style="text-align: center; padding: 10px; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
                            <div style="font-size: 18px; font-weight: 700; color: ${tokenColor}; margin-bottom: 4px;">${formatTokens(total_used)}</div>
                            <div style="font-size: 12px; color: #6b7280;">Used</div>
                        </div>
                        <div class="pool-token-item" style="text-align: center; padding: 10px; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
                            <div style="font-size: 18px; font-weight: 700; color: #10b981; margin-bottom: 4px;">${formatTokens(total_remaining)}</div>
                            <div style="font-size: 12px; color: #6b7280;">Remaining</div>
                        </div>
                        <div class="pool-token-item" style="text-align: center; padding: 10px; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
                            <div style="font-size: 18px; font-weight: 700; color: #6b7280; margin-bottom: 4px;">${formatTokens(total_limit)}</div>
                            <div style="font-size: 12px; color: #6b7280;">Total quota</div>
                        </div>
                    </div>
                    <div class="pool-token-progress">
                        <div class="pool-progress-bar" style="height: 8px; background: rgba(0,0,0,0.1); border-radius: 4px; overflow: hidden;">
                            <div class="pool-progress-fill" style="width: ${percentage}%; height: 100%; background: linear-gradient(90deg, ${tokenColor}, ${tokenColor}dd); transition: width 0.3s ease;"></div>
                        </div>
                        <div class="pool-progress-text" style="text-align: center; margin-top: 6px; font-weight: 600; color: ${tokenColor}; font-size: 13px;">⚡ Usage: ${percentage}%</div>
                    </div>
                </div>
            `;
        } else {
            tokenStatsHtml = `
                <div class="pool-token-section" style="margin-top: 15px; padding: 15px; background: rgba(156, 163, 175, 0.1); border-radius: 12px; border: 2px dashed #d1d5db;">
                    <div style="text-align: center; color: #9ca3af;">
                        <div style="font-size: 32px; margin-bottom: 8px;">📊</div>
                        <div style="font-size: 14px; font-weight: 600; margin-bottom: 4px;">No token usage data</div>
                        <div style="font-size: 12px;">Token statistics for this pool have not been synchronized yet.</div>
                    </div>
                </div>
            `;
        }

        return `
            <div class="pool-group-card ${statusClass}">
                <div class="pool-group-header">
                    <div class="pool-group-title">
                        <span class="pool-group-priority">Priority ${group.priority}</span>
                        <h3>${group.name}</h3>
                    </div>
                    <div class="pool-group-actions">
                        <button onclick="deletePoolGroup('${group.id}')" class="btn btn-danger btn-sm" title="Delete pool">
                            🗑️
                        </button>
                    </div>
                </div>
                <div class="pool-group-stats">
                    <div class="pool-stat">
                        <div class="pool-stat-value">${group.total}</div>
                        <div class="pool-stat-label">Total keys</div>
                    </div>
                    <div class="pool-stat pool-stat-success">
                        <div class="pool-stat-value">${group.active}</div>
                        <div class="pool-stat-label">Active</div>
                    </div>
                    <div class="pool-stat pool-stat-warning">
                        <div class="pool-stat-value">${group.disabled}</div>
                        <div class="pool-stat-label">Disabled</div>
                    </div>
                    <div class="pool-stat pool-stat-danger">
                        <div class="pool-stat-value">${group.banned}</div>
                        <div class="pool-stat-label">Blocked by proxy</div>
                    </div>
                </div>
                <div class="pool-group-progress">
                    <div class="pool-progress-bar">
                        <div class="pool-progress-fill" style="width: ${usagePercent}%"></div>
                    </div>
                    <div class="pool-progress-text">Active keys: ${usagePercent}%</div>
                </div>
                ${tokenStatsHtml}
                ${group.description ? `<div class="pool-group-description">${escapeHtml(group.description)}</div>` : ''}
            </div>
        `;
    }).join('');
}

/**
 * Refresh pool data
 */
async function refreshPoolGroups() {
    await loadPoolGroups();
    alert('✅ Key pool data refreshed.');
}

/**
 * Show the Create pool dialog
 */
function showCreatePoolModal() {
    document.getElementById('newPoolId').value = '';
    document.getElementById('newPoolName').value = '';
    document.getElementById('newPoolPriority').value = '';
    document.getElementById('newPoolDescription').value = '';
    showModal('createPoolModal');
}

/**
 * Create a new pool
 */
async function createPool() {
    const id = document.getElementById('newPoolId').value.trim();
    const name = document.getElementById('newPoolName').value.trim();
    const priority = parseInt(document.getElementById('newPoolPriority').value);
    const description = document.getElementById('newPoolDescription').value.trim();

    // Validate input
    if (!id) {
        alert('❌ Enter a pool ID');
        return;
    }

    if (!/^[a-z0-9-]+$/i.test(id)) {
        alert('❌ Pool IDs may contain only ASCII letters, digits, and hyphens.');
        return;
    }

    if (!name) {
        alert('❌ Enter a pool name');
        return;
    }

    if (!priority || priority < 1 || priority > 100) {
        alert('❌ Priority must be between 1 and 100.');
        return;
    }

    try {
        const response = await fetch('/admin/pool-groups', {
            method: 'POST',
            headers: {
                'x-admin-key': adminKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ id, name, priority, description })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `Failed to create pool: ${response.status}`);
        }

        alert('✅ Key pool created.');
        closeModal('createPoolModal');
        await loadPoolGroups();
    } catch (err) {
        alert('❌ Failed to create pool: ' + err.message);
    }
}

/**
 * Delete pool
 */
async function deletePoolGroup(groupId) {
    const group = poolGroupsData.find(g => g.id === groupId);
    if (!group) return;

    if (!confirm(`Delete key pool "${group.name}"?\n\nIts ${group.total} keys will be moved to the default pool.`)) {
        return;
    }

    try {
        const response = await fetch(`/admin/pool-groups/${groupId}`, {
            method: 'DELETE',
            headers: {
                'x-admin-key': adminKey
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `Failed to delete: ${response.status}`);
        }

        const result = await response.json();
        alert(`✅ Key pool deleted.\nMoved ${result.data.affected_keys} keys to the default pool.`);
        await loadPoolGroups();
        await refreshData();  // Refresh the key list
    } catch (err) {
        alert('❌ Failed to delete: ' + err.message);
    }
}

/**
 * Update pool options in the filter
 */
function updatePoolFilterDropdown() {
    const select = document.getElementById('poolGroupFilter');
    if (!select) return;

    // Save the current selection
    const currentValue = select.value;

    // Clear and repopulate
    select.innerHTML = '<option value="all">All pools</option>';

    poolGroupsData.forEach(group => {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = `${group.name} (${group.active}/${group.total})`;
        select.appendChild(option);
    });

    // Restore the selection
    select.value = currentValue;
}

/**
 * Update all pool selectors
 */
function updatePoolGroupSelects() {
    // Update the pool selector in the Add key dialog
    const newKeyPoolSelect = document.getElementById('newKeyPoolGroup');
    if (newKeyPoolSelect) {
        const currentValue = newKeyPoolSelect.value;
        newKeyPoolSelect.innerHTML = '<option value="">Default pool (default)</option>';

        poolGroupsData.forEach(group => {
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = `${group.name} (Priority ${group.priority})`;
            newKeyPoolSelect.appendChild(option);
        });

        newKeyPoolSelect.value = currentValue;
    }

    // Update the destination selector in the Move pool dialog
    const changePoolSelect = document.getElementById('changePoolSelect');
    if (changePoolSelect) {
        const currentValue = changePoolSelect.value;
        changePoolSelect.innerHTML = '<option value="default">Default pool (default)</option>';

        poolGroupsData.forEach(group => {
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = `${group.name} (Priority ${group.priority})`;
            changePoolSelect.appendChild(option);
        });

        changePoolSelect.value = currentValue;
    }

    // 🆕 Update the pool selector in the bulk import dialog
    const batchImportPoolSelect = document.getElementById('batchImportPoolGroup');
    if (batchImportPoolSelect) {
        const currentValue = batchImportPoolSelect.value;
        batchImportPoolSelect.innerHTML = '<option value="">Default pool (default)</option>';

        poolGroupsData.forEach(group => {
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = `${group.name} (Priority ${group.priority})`;
            batchImportPoolSelect.appendChild(option);
        });

        batchImportPoolSelect.value = currentValue;
    }

    // 🆕 Update the pool selector in the Edit key dialog
    const editKeyPoolSelect = document.getElementById('editKeyPoolGroup');
    if (editKeyPoolSelect) {
        const currentValue = editKeyPoolSelect.value;
        editKeyPoolSelect.innerHTML = '<option value="default">Default pool (default)</option>';

        poolGroupsData.forEach(group => {
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = `${group.name} (Priority ${group.priority})`;
            editKeyPoolSelect.appendChild(option);
        });

        editKeyPoolSelect.value = currentValue;
    }

    // 🆕 Update the pool multiselect in the Export keys dialog
    const exportPoolSelect = document.getElementById('exportPoolGroup');
    if (exportPoolSelect) {
        const selectedValues = Array.from(exportPoolSelect.selectedOptions || []).map(option => option.value);
        exportPoolSelect.innerHTML = '<option value="default">Default pool (default)</option>';

        poolGroupsData.forEach(group => {
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = `${group.name} (Priority ${group.priority})`;
            exportPoolSelect.appendChild(option);
        });

        // Restore selected options
        selectedValues.forEach(value => {
            const option = exportPoolSelect.querySelector(`option[value="${value}"]`);
            if (option) {
                option.selected = true;
            }
        });
    }

    // 🆕 Update the pool selector in the bulk test dialog
    const testPoolSelect = document.getElementById('testPoolGroup');
    if (testPoolSelect) {
        const currentValue = testPoolSelect.value;
        testPoolSelect.innerHTML = '<option value="default">Default pool (default)</option>';

        poolGroupsData.forEach(group => {
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = `${group.name} (Priority ${group.priority})`;
            testPoolSelect.appendChild(option);
        });

        testPoolSelect.value = currentValue;
    }
}

/**
 * Show the Move pool dialog
 */
function showChangePoolModal(keyId) {
    currentChangePoolKeyId = keyId;
    document.getElementById('changePoolKeyId').textContent = keyId;
    updatePoolGroupSelects();  // Keep the selector up to date
    showModal('changePoolModal');
}

/**
 * Move a key to another pool
 */
async function changeKeyPool() {
    const poolGroup = document.getElementById('changePoolSelect').value;

    if (!currentChangePoolKeyId) {
        alert('❌ Missing key ID');
        return;
    }

    try {
        const response = await fetch(`/admin/keys/${currentChangePoolKeyId}/pool`, {
            method: 'PATCH',
            headers: {
                'x-admin-key': adminKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ poolGroup })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `Failed to move key: ${response.status}`);
        }

        alert('✅ Key moved to the selected pool.');
        closeModal('changePoolModal');
        currentChangePoolKeyId = null;
        await refreshData();
        await loadPoolGroups();
    } catch (err) {
        alert('❌ Failed to move key: ' + err.message);
    }
}

/**
 * Extend addKey to support pool selection
 */
const originalAddKey = window.addKey;
window.addKey = async function() {
    const key = document.getElementById('newKeyInput').value.trim();
    const notes = document.getElementById('newKeyNotes').value.trim();
    const poolGroup = document.getElementById('newKeyPoolGroup').value || null;

    if (!key) {
        alert('Enter a key');
        return;
    }

    if (!key.startsWith('fk-')) {
        alert('Invalid key format. Keys must begin with fk-.');
        return;
    }

    try {
        const response = await fetch('/admin/keys', {
            method: 'POST',
            headers: {
                'x-admin-key': adminKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ key, notes, poolGroup })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `Failed to add key: ${response.status}`);
        }

        alert('Key added successfully');
        closeModal('addKeyModal');
        refreshData();
        loadPoolGroups();
    } catch (err) {
        alert('Failed to add key: ' + err.message);
    }
};

/**
 * Extend renderKeysTable to display the pool column
 */
const originalRenderKeysTable = window.renderKeysTable;
window.renderKeysTable = function(keys) {
    const tbody = document.getElementById('keysTableBody');

    if (keys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="14" class="loading">No data available</td></tr>';
        return;
    }

    tbody.innerHTML = keys.map(key => {
        // Build detailed test result labels
        let testResultHtml = '';
        if (key.last_test_result === 'success') {
            testResultHtml = '<span class="test-success">✅ Test passed</span>';
        } else if (key.last_test_result === 'failed') {
            let statusCode = '';
            let errorMsg = key.last_error || 'Unknown error';
            if (key.last_error && key.last_error.includes(':')) {
                const parts = key.last_error.split(':');
                statusCode = parts[0].trim();
                errorMsg = parts.slice(1).join(':').trim();
            }

            const statusText = statusCode ? getStatusMessage(parseInt(statusCode)) : 'Test failed';
            testResultHtml = `<span class="test-failed" title="${escapeHtml(errorMsg)}">❌ ${statusText}${statusCode ? ` (${statusCode})` : ''}</span>`;
        } else {
            testResultHtml = '<span class="test-untested">⏸️ Not tested</span>';
        }

        // Calculate success rate
        const totalRequests = key.total_requests || key.usage_count || 0;
        const errorCount = key.error_count || 0;
        const successRequests = key.success_requests !== undefined
            ? key.success_requests
            : Math.max(0, totalRequests - errorCount);
        const successRate = totalRequests > 0 ? (successRequests / totalRequests) : 0;
        const successRateText = totalRequests > 0 ? (successRate * 100).toFixed(1) + '%' : 'N/A';
        const successRateClass = successRate >= 0.9 ? 'success-rate-high' :
                               successRate >= 0.7 ? 'success-rate-medium' :
                               successRate > 0 ? 'success-rate-low' : 'success-rate-none';

        // Display token usage


        // 🎯 Display key pool labels
        const poolGroup = key.poolGroup || 'default';
        const poolGroupName = poolGroupsData.find(g => g.id === poolGroup)?.name || poolGroup;
        const poolGroupHtml = `
            <span class="pool-group-badge" title="Assigned key pool">
                ${poolGroupName}
            </span>
            <button onclick="showChangePoolModal('${key.id}')" class="btn btn-info btn-sm" style="margin-top: 5px;">
                🔄 Move pool
            </button>
        `;

        return `
        <tr>
            <td><code>${key.id}</code></td>
            <td><code>${maskKey(key.key)}</code></td>
            <td>${poolGroupHtml}</td>
            <td><span class="status-badge status-${key.status}">${getStatusText(key.status)}</span></td>
            <td>${key.usage_count || 0}</td>
            <td>${successRequests}</td>
            <td>${errorCount}</td>
            <td><span class="${successRateClass}">${successRateText}</span></td>
            <td data-key-limits="${escapeHtml(key.id)}">Loading limits…</td>
            <td><span class="score-badge">${(key.weight_score || 0).toFixed(1)}</span></td>
            <td>${formatDate(key.last_used_at)}</td>
            <td>${testResultHtml}</td>
            <td>${key.notes || '-'}</td>
            <td>
                <button onclick="testKey('${key.id}')" class="btn btn-info btn-sm">Test</button>
                <button onclick="toggleKeyStatus('${key.id}', '${key.status}')" class="btn ${getToggleButtonClass(key.status)} btn-sm">
                    ${getToggleButtonText(key.status)}
                </button>
                <button onclick="showEditKeyModal('${key.id}', '${key.key}', '${escapeHtml(key.notes || '')}', '${poolGroup}')" class="btn btn-primary btn-sm">Edit</button>
                <button onclick="showEditNotesModal('${key.id}', '${escapeHtml(key.notes || '')}')" class="btn btn-secondary btn-sm">Notes</button>
                <button onclick="deleteKey('${key.id}')" class="btn btn-danger btn-sm">Delete</button>
            </td>
        </tr>
        `;
    }).join('');
    if (typeof updateBalanceDisplay === 'function') updateBalanceDisplay();
};

/**
 * Extend filterChanged to support pool filtering
 */
const originalFilterChanged = window.filterChanged;
window.filterChanged = function() {
    const statusFilter = document.getElementById('statusFilter').value;
    const poolGroupFilter = document.getElementById('poolGroupFilter')?.value || 'all';

    currentStatus = statusFilter;
    currentPoolGroup = poolGroupFilter;  // BaSui: Fix filtering by updating currentPoolGroup
    currentPage = 1;

    // Call fetchKeys, which filters using currentPoolGroup
    fetchKeys();
};

// ===== 📥 Key export =====

/**
 * Show the Export keys dialog
 */
async function showExportKeysModal() {
    // BaSui: Load pool data before updating the selector
    if (!poolGroupsData || poolGroupsData.length === 0) {
        await loadPoolGroups();
    }
    updatePoolGroupSelects();
    showModal('exportKeysModal');
}

/**
 * Toggle the All pools option
 */
function toggleExportAllPools() {
    const allPoolsChecked = document.getElementById('exportAllPools').checked;
    const poolOptions = document.getElementById('exportPoolOptions');
    poolOptions.style.display = allPoolsChecked ? 'none' : 'block';
}

/**
 * Confirm key export
 */
async function confirmExportKeys() {
    try {
        const exportAll = document.getElementById('exportAllPools').checked;
        const format = document.querySelector('input[name="exportFormat"]:checked').value;
        const status = document.getElementById('exportStatusFilter').value;

        let poolGroups = [];
        if (!exportAll) {
            const select = document.getElementById('exportPoolGroup');
            poolGroups = Array.from(select.selectedOptions).map(opt => opt.value);
            if (poolGroups.length === 0) {
                alert('Select at least one pool.');
                return;
            }
        }

        let url = `/admin/keys/export?status=${status}&format=${format}`;
        if (!exportAll && poolGroups.length > 0) {
            url += `&poolGroups=${poolGroups.join(',')}`;
        }

        const response = await fetch(url, {
            method: 'GET',
            headers: { 'x-admin-key': adminKey }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `HTTP ${response.status}`);
        }

        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = 'keys_export.json';
        if (contentDisposition) {
            const match = contentDisposition.match(/filename="?(.+)"?/);
            if (match) filename = match[1];
        }

        const blob = await response.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(downloadUrl);

        closeModal('exportKeysModal');
        alert(`✅ Export complete. Filename: ${filename}`);
    } catch (error) {
        console.error('❌ Export failed:', error);
        alert(`Export failed: ${error.message}`);
    }
}

// ===== 🧪 Bulk testing =====

/**
 * Show the bulk test dialog
 */
async function showBatchTestModal() {
    // BaSui: Load pool data before updating the selector
    if (!poolGroupsData || poolGroupsData.length === 0) {
        await loadPoolGroups();
    }
    updatePoolGroupSelects();
    document.getElementById('testResult').innerHTML = '';
    showModal('batchTestModal');
}

/**
 * Toggle the pool selection for testing
 */
function toggleTestPoolOptions() {
    const testSpecific = document.querySelector('input[name="testPool"][value="specific"]').checked;
    const poolOptions = document.getElementById('testPoolOptions');
    poolOptions.style.display = testSpecific ? 'block' : 'none';
}

/**
 * Confirm bulk testing
 */
async function confirmBatchTest() {
    try {
        const testAll = document.querySelector('input[name="testPool"][value="all"]').checked;
        const concurrency = document.getElementById('testConcurrency').value;
        const autoRefresh = document.getElementById('testAutoRefresh').checked;

        let poolGroup = null;
        if (!testAll) {
            poolGroup = document.getElementById('testPoolGroup').value;
        }

        const resultDiv = document.getElementById('testResult');
        resultDiv.innerHTML = '<div class="loading">🧪 Testing, please wait...</div>';

        let url = `/admin/keys/test-all?concurrency=${concurrency}`;
        if (poolGroup) {
            url += `&poolGroup=${poolGroup}`;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'x-admin-key': adminKey }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `HTTP ${response.status}`);
        }

        const result = await response.json();
        const data = result.data;

        let message = '<div class="result-summary success">';
        message += '<h3>🎉 Bulk test complete</h3>';
        message += `<p>📊 Total keys: ${data.total}</p>`;
        message += `<p>🔍 Tested: ${data.tested}</p>`;
        message += `<p>✅ Passed: ${data.success}</p>`;
        message += `<p>❌ Failed: ${data.failed}</p>`;
        message += `<p>🚫 Automatically blocked by proxy: ${data.banned}</p>`;
        if (data.banned > 0) {
            message += '<p class="hint">💡 Keys with insufficient balance were automatically blocked by the proxy.</p>';
        }
        message += '</div>';

        resultDiv.innerHTML = message;

        if (autoRefresh) {
            setTimeout(() => {
                refreshData();
                closeModal('batchTestModal');
            }, 2000);
        }
    } catch (error) {
        console.error('❌ Bulk test failed:', error);
        const resultDiv = document.getElementById('testResult');
        resultDiv.innerHTML = `<div class="result-summary error">❌ Test failed: ${error.message}</div>`;
    }
}

// Listen for radio button changes
document.addEventListener('DOMContentLoaded', () => {
    const testPoolRadios = document.querySelectorAll('input[name="testPool"]');
    testPoolRadios.forEach(radio => {
        radio.addEventListener('change', toggleTestPoolOptions);
    });
});

// Initialize pool data on page load
window.addEventListener('DOMContentLoaded', () => {
    // Load pools after the main autoAuthenticate handler completes
    setTimeout(() => {
        if (adminKey) {
            loadPoolGroups();
        }
    }, 1000);
});

console.log('✅ Multi-tier key pool management loaded - BaSui');
