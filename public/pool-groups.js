// ========== 🚀 BaSui：多级密钥池管理功能 (Multi-Tier Pool Groups) ==========

// 全局池子数据
let poolGroupsData = [];
let currentChangePoolKeyId = null;

/**
 * 加载并显示池子统计信息
 */
async function loadPoolGroups() {
    try {
        // 并行获取密钥池统计和Token使用量统计
        const [poolResponse, tokenResponse] = await Promise.all([
            fetch('/admin/pool-groups', {
                headers: { 'x-admin-key': adminKey }
            }),
            fetch('/admin/token/by-pool', {
                headers: { 'x-admin-key': adminKey }
            })
        ]);

        if (!poolResponse.ok) {
            throw new Error(`加载池子失败: ${poolResponse.status}`);
        }

        const poolResult = await poolResponse.json();
        if (poolResult.success) {
            poolGroupsData = poolResult.data || [];
            
            // 如果Token统计请求成功，合并数据
            if (tokenResponse.ok) {
                const tokenResult = await tokenResponse.json();
                if (tokenResult.success) {
                    const tokenPools = tokenResult.data.pools;
                    
                    // 将Token统计数据合并到密钥池数据中
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
        console.error('加载密钥池失败:', err);
        // 静默失败，不影响其他功能
    }
}

/**
 * 渲染池子卡片
 */
function renderPoolGroups() {
    const container = document.getElementById('poolGroupsContainer');
    const grid = document.getElementById('poolGroupsGrid');

    // 🆕 始终显示容器（即使没有池组，也要显示"创建密钥池"按钮）
    container.style.display = 'block';

    if (!poolGroupsData || poolGroupsData.length === 0) {
        // 显示空状态提示
        grid.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 40px; background: rgba(255,255,255,0.95); border-radius: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
                <div style="font-size: 3em; margin-bottom: 15px;">🎯</div>
                <h3 style="color: #666; margin-bottom: 10px;">暂无密钥池</h3>
                <p style="color: #999; margin-bottom: 20px;">点击下方"➕ 创建密钥池"按钮开始创建您的第一个密钥池！</p>
                <button onclick="showCreatePoolModal()" class="btn btn-primary" style="font-size: 16px; padding: 12px 30px;">
                    ➕ 创建第一个密钥池
                </button>
            </div>
        `;
        return;
    }

    // 按优先级排序
    const sortedGroups = [...poolGroupsData].sort((a, b) => a.priority - b.priority);

    grid.innerHTML = sortedGroups.map(group => {
        const usagePercent = ((group.active / group.total) * 100).toFixed(0);
        let statusClass = 'pool-group-safe';
        if (group.active === 0) {
            statusClass = 'pool-group-empty';
        } else if (group.active < group.total * 0.3) {
            statusClass = 'pool-group-warning';
        }

        // Token使用量显示 - 优化版
        let tokenStatsHtml = '';
        if (group.token_stats && group.token_stats.keys_with_data > 0) {
            const { total_used, total_limit, total_remaining, percentage } = group.token_stats;
            const percentNum = parseFloat(percentage);
            let tokenColor = '#10b981';  // 绿色
            let tokenBgColor = 'rgba(16, 185, 129, 0.1)';
            if (percentNum > 80) {
                tokenColor = '#ef4444';  // 红色
                tokenBgColor = 'rgba(239, 68, 68, 0.1)';
            } else if (percentNum > 60) {
                tokenColor = '#f59e0b';  // 橙色
                tokenBgColor = 'rgba(245, 158, 11, 0.1)';
            } else if (percentNum > 40) {
                tokenColor = '#fbbf24';  // 黄色
                tokenBgColor = 'rgba(251, 191, 36, 0.1)';
            }

            tokenStatsHtml = `
                <div class="pool-token-section" style="margin-top: 15px; padding: 15px; background: ${tokenBgColor}; border-radius: 12px; border: 2px solid ${tokenColor};">
                    <div class="pool-token-header" style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                        <span style="font-size: 20px;">💰</span>
                        <span style="font-weight: 700; color: ${tokenColor}; font-size: 14px;">Token使用统计</span>
                    </div>
                    <div class="pool-token-stats" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 12px;">
                        <div class="pool-token-item" style="text-align: center; padding: 10px; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
                            <div style="font-size: 18px; font-weight: 700; color: ${tokenColor}; margin-bottom: 4px;">${formatTokens(total_used)}</div>
                            <div style="font-size: 12px; color: #6b7280;">已使用</div>
                        </div>
                        <div class="pool-token-item" style="text-align: center; padding: 10px; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
                            <div style="font-size: 18px; font-weight: 700; color: #10b981; margin-bottom: 4px;">${formatTokens(total_remaining)}</div>
                            <div style="font-size: 12px; color: #6b7280;">剩余</div>
                        </div>
                        <div class="pool-token-item" style="text-align: center; padding: 10px; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
                            <div style="font-size: 18px; font-weight: 700; color: #6b7280; margin-bottom: 4px;">${formatTokens(total_limit)}</div>
                            <div style="font-size: 12px; color: #6b7280;">总额度</div>
                        </div>
                    </div>
                    <div class="pool-token-progress">
                        <div class="pool-progress-bar" style="height: 8px; background: rgba(0,0,0,0.1); border-radius: 4px; overflow: hidden;">
                            <div class="pool-progress-fill" style="width: ${percentage}%; height: 100%; background: linear-gradient(90deg, ${tokenColor}, ${tokenColor}dd); transition: width 0.3s ease;"></div>
                        </div>
                        <div class="pool-progress-text" style="text-align: center; margin-top: 6px; font-weight: 600; color: ${tokenColor}; font-size: 13px;">⚡ 使用率：${percentage}%</div>
                    </div>
                </div>
            `;
        } else {
            tokenStatsHtml = `
                <div class="pool-token-section" style="margin-top: 15px; padding: 15px; background: rgba(156, 163, 175, 0.1); border-radius: 12px; border: 2px dashed #d1d5db;">
                    <div style="text-align: center; color: #9ca3af;">
                        <div style="font-size: 32px; margin-bottom: 8px;">📊</div>
                        <div style="font-size: 14px; font-weight: 600; margin-bottom: 4px;">暂无Token使用数据</div>
                        <div style="font-size: 12px;">该池子的密钥尚未同步Token统计</div>
                    </div>
                </div>
            `;
        }

        return `
            <div class="pool-group-card ${statusClass}">
                <div class="pool-group-header">
                    <div class="pool-group-title">
                        <span class="pool-group-priority">优先级 ${group.priority}</span>
                        <h3>${group.name}</h3>
                    </div>
                    <div class="pool-group-actions">
                        <button onclick="deletePoolGroup('${group.id}')" class="btn btn-danger btn-sm" title="删除池子">
                            🗑️
                        </button>
                    </div>
                </div>
                <div class="pool-group-stats">
                    <div class="pool-stat">
                        <div class="pool-stat-value">${group.total}</div>
                        <div class="pool-stat-label">总密钥</div>
                    </div>
                    <div class="pool-stat pool-stat-success">
                        <div class="pool-stat-value">${group.active}</div>
                        <div class="pool-stat-label">可用</div>
                    </div>
                    <div class="pool-stat pool-stat-warning">
                        <div class="pool-stat-value">${group.disabled}</div>
                        <div class="pool-stat-label">禁用</div>
                    </div>
                    <div class="pool-stat pool-stat-danger">
                        <div class="pool-stat-value">${group.banned}</div>
                        <div class="pool-stat-label">封禁</div>
                    </div>
                </div>
                <div class="pool-group-progress">
                    <div class="pool-progress-bar">
                        <div class="pool-progress-fill" style="width: ${usagePercent}%"></div>
                    </div>
                    <div class="pool-progress-text">可用率：${usagePercent}%</div>
                </div>
                ${tokenStatsHtml}
                ${group.description ? `<div class="pool-group-description">${escapeHtml(group.description)}</div>` : ''}
            </div>
        `;
    }).join('');
}

/**
 * 刷新池子数据
 */
async function refreshPoolGroups() {
    await loadPoolGroups();
    alert('✅ 密钥池数据已刷新！');
}

/**
 * 显示创建池子模态框
 */
function showCreatePoolModal() {
    document.getElementById('newPoolId').value = '';
    document.getElementById('newPoolName').value = '';
    document.getElementById('newPoolPriority').value = '';
    document.getElementById('newPoolDescription').value = '';
    showModal('createPoolModal');
}

/**
 * 创建新池子
 */
async function createPool() {
    const id = document.getElementById('newPoolId').value.trim();
    const name = document.getElementById('newPoolName').value.trim();
    const priority = parseInt(document.getElementById('newPoolPriority').value);
    const description = document.getElementById('newPoolDescription').value.trim();

    // 验证输入
    if (!id) {
        alert('❌ 请输入池子ID');
        return;
    }

    if (!/^[a-z0-9-]+$/i.test(id)) {
        alert('❌ 池子ID只能包含英文字母、数字和短横线');
        return;
    }

    if (!name) {
        alert('❌ 请输入池子名称');
        return;
    }

    if (!priority || priority < 1 || priority > 100) {
        alert('❌ 优先级必须在 1-100 之间');
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
            throw new Error(error.message || `创建失败: ${response.status}`);
        }

        alert('✅ 密钥池创建成功！');
        closeModal('createPoolModal');
        await loadPoolGroups();
    } catch (err) {
        alert('❌ 创建失败: ' + err.message);
    }
}

/**
 * 删除池子
 */
async function deletePoolGroup(groupId) {
    const group = poolGroupsData.find(g => g.id === groupId);
    if (!group) return;

    if (!confirm(`确认删除密钥池 "${group.name}"？\n\n该池子的 ${group.total} 个密钥将移动到 default 池。`)) {
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
            throw new Error(error.message || `删除失败: ${response.status}`);
        }

        const result = await response.json();
        alert(`✅ 密钥池已删除！\n${result.data.affected_keys} 个密钥已移动到 default 池。`);
        await loadPoolGroups();
        await refreshData();  // 刷新密钥列表
    } catch (err) {
        alert('❌ 删除失败: ' + err.message);
    }
}

/**
 * 更新筛选下拉框的池子选项
 */
function updatePoolFilterDropdown() {
    const select = document.getElementById('poolGroupFilter');
    if (!select) return;

    // 保存当前选中值
    const currentValue = select.value;

    // 清空并重新填充
    select.innerHTML = '<option value="all">全部池子</option>';

    poolGroupsData.forEach(group => {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = `${group.name} (${group.active}/${group.total})`;
        select.appendChild(option);
    });

    // 恢复选中值
    select.value = currentValue;
}

/**
 * 更新所有池子选择下拉框
 */
function updatePoolGroupSelects() {
    // 更新添加密钥模态框的下拉框
    const newKeyPoolSelect = document.getElementById('newKeyPoolGroup');
    if (newKeyPoolSelect) {
        const currentValue = newKeyPoolSelect.value;
        newKeyPoolSelect.innerHTML = '<option value="">默认池 (default)</option>';

        poolGroupsData.forEach(group => {
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = `${group.name} (优先级 ${group.priority})`;
            newKeyPoolSelect.appendChild(option);
        });

        newKeyPoolSelect.value = currentValue;
    }

    // 更新修改池子模态框的下拉框
    const changePoolSelect = document.getElementById('changePoolSelect');
    if (changePoolSelect) {
        const currentValue = changePoolSelect.value;
        changePoolSelect.innerHTML = '<option value="default">默认池 (default)</option>';

        poolGroupsData.forEach(group => {
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = `${group.name} (优先级 ${group.priority})`;
            changePoolSelect.appendChild(option);
        });

        changePoolSelect.value = currentValue;
    }

    // 🆕 更新批量导入模态框的下拉框
    const batchImportPoolSelect = document.getElementById('batchImportPoolGroup');
    if (batchImportPoolSelect) {
        const currentValue = batchImportPoolSelect.value;
        batchImportPoolSelect.innerHTML = '<option value="">默认池 (default)</option>';

        poolGroupsData.forEach(group => {
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = `${group.name} (优先级 ${group.priority})`;
            batchImportPoolSelect.appendChild(option);
        });

        batchImportPoolSelect.value = currentValue;
    }

    // 🆕 更新编辑密钥模态框的下拉框
    const editKeyPoolSelect = document.getElementById('editKeyPoolGroup');
    if (editKeyPoolSelect) {
        const currentValue = editKeyPoolSelect.value;
        editKeyPoolSelect.innerHTML = '<option value="default">默认池 (default)</option>';

        poolGroupsData.forEach(group => {
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = `${group.name} (优先级 ${group.priority})`;
            editKeyPoolSelect.appendChild(option);
        });

        editKeyPoolSelect.value = currentValue;
    }
}

/**
 * 显示修改密钥池模态框
 */
function showChangePoolModal(keyId) {
    currentChangePoolKeyId = keyId;
    document.getElementById('changePoolKeyId').textContent = keyId;
    updatePoolGroupSelects();  // 确保下拉框是最新的
    showModal('changePoolModal');
}

/**
 * 修改密钥所属池子
 */
async function changeKeyPool() {
    const poolGroup = document.getElementById('changePoolSelect').value;

    if (!currentChangePoolKeyId) {
        alert('❌ 密钥ID丢失');
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
            throw new Error(error.message || `修改失败: ${response.status}`);
        }

        alert('✅ 密钥池已修改！');
        closeModal('changePoolModal');
        currentChangePoolKeyId = null;
        await refreshData();
        await loadPoolGroups();
    } catch (err) {
        alert('❌ 修改失败: ' + err.message);
    }
}

/**
 * 修改 addKey 函数，支持池子选择
 */
const originalAddKey = window.addKey;
window.addKey = async function() {
    const key = document.getElementById('newKeyInput').value.trim();
    const notes = document.getElementById('newKeyNotes').value.trim();
    const poolGroup = document.getElementById('newKeyPoolGroup').value || null;

    if (!key) {
        alert('请输入密钥');
        return;
    }

    if (!key.startsWith('fk-')) {
        alert('密钥格式错误，必须以 fk- 开头');
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
            throw new Error(error.message || `添加失败: ${response.status}`);
        }

        alert('添加成功');
        closeModal('addKeyModal');
        refreshData();
        loadPoolGroups();
    } catch (err) {
        alert('添加失败: ' + err.message);
    }
};

/**
 * 修改 renderKeysTable，添加池子列显示
 */
const originalRenderKeysTable = window.renderKeysTable;
window.renderKeysTable = function(keys) {
    const tbody = document.getElementById('keysTableBody');

    if (keys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="14" class="loading">暂无数据</td></tr>';
        return;
    }

    tbody.innerHTML = keys.map(key => {
        // 生成测试结果的详细显示
        let testResultHtml = '';
        if (key.last_test_result === 'success') {
            testResultHtml = '<span class="test-success">✅ 测试通过</span>';
        } else if (key.last_test_result === 'failed') {
            let statusCode = '';
            let errorMsg = key.last_error || '未知错误';
            if (key.last_error && key.last_error.includes(':')) {
                const parts = key.last_error.split(':');
                statusCode = parts[0].trim();
                errorMsg = parts.slice(1).join(':').trim();
            }

            const statusText = statusCode ? getStatusMessage(parseInt(statusCode)) : '测试失败';
            testResultHtml = `<span class="test-failed" title="${escapeHtml(errorMsg)}">❌ ${statusText}${statusCode ? ` (${statusCode})` : ''}</span>`;
        } else {
            testResultHtml = '<span class="test-untested">⏸️ 未测试</span>';
        }

        // 计算成功率
        const totalRequests = key.total_requests || key.usage_count || 0;
        const errorCount = key.error_count || 0;
        const successRequests = key.success_requests !== undefined
            ? key.success_requests
            : (totalRequests - errorCount);
        const successRate = totalRequests > 0 ? (successRequests / totalRequests) : 0;
        const successRateText = totalRequests > 0 ? (successRate * 100).toFixed(1) + '%' : 'N/A';
        const successRateClass = successRate >= 0.9 ? 'success-rate-high' :
                               successRate >= 0.7 ? 'success-rate-medium' :
                               successRate > 0 ? 'success-rate-low' : 'success-rate-none';

        // Token使用量显示
        let tokenUsageHtml = '-';
        if (key.token_usage) {
            const { used, limit, remaining, percentage } = key.token_usage;
            const percentNum = parseFloat(percentage);
            let tokenColor = '#10b981';
            if (percentNum > 80) {
                tokenColor = '#ef4444';
            } else if (percentNum > 60) {
                tokenColor = '#f59e0b';
            } else if (percentNum > 40) {
                tokenColor = '#fbbf24';
            }

            tokenUsageHtml = `
                <div style="display: flex; flex-direction: column; align-items: center;">
                    <span style="font-weight: 600;">${formatTokens(used)} / ${formatTokens(limit)}</span>
                    <span style="color: ${tokenColor}; font-size: 0.85em;">(剩余 ${formatTokens(remaining)})</span>
                    <span style="color: ${tokenColor}; font-weight: 600;">${percentage}%</span>
                </div>
            `;
        }

        // 🎯 密钥池标签显示
        const poolGroup = key.poolGroup || 'default';
        const poolGroupName = poolGroupsData.find(g => g.id === poolGroup)?.name || poolGroup;
        const poolGroupHtml = `
            <span class="pool-group-badge" title="所属密钥池">
                ${poolGroupName}
            </span>
            <button onclick="showChangePoolModal('${key.id}')" class="btn btn-info btn-sm" style="margin-top: 5px;">
                🔄 改池
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
            <td>${tokenUsageHtml}</td>
            <td><span class="score-badge">${(key.weight_score || 0).toFixed(1)}</span></td>
            <td>${formatDate(key.last_used_at)}</td>
            <td>${testResultHtml}</td>
            <td>${key.notes || '-'}</td>
            <td>
                <button onclick="testKey('${key.id}')" class="btn btn-info btn-sm">测试</button>
                <button onclick="toggleKeyStatus('${key.id}', '${key.status}')" class="btn ${getToggleButtonClass(key.status)} btn-sm">
                    ${getToggleButtonText(key.status)}
                </button>
                <button onclick="showEditKeyModal('${key.id}', '${key.key}', '${escapeHtml(key.notes || '')}', '${poolGroup}')" class="btn btn-primary btn-sm">编辑</button>
                <button onclick="showEditNotesModal('${key.id}', '${escapeHtml(key.notes || '')}')" class="btn btn-secondary btn-sm">备注</button>
                <button onclick="deleteKey('${key.id}')" class="btn btn-danger btn-sm">删除</button>
            </td>
        </tr>
        `;
    }).join('');
};

/**
 * 修改 filterChanged，支持池子筛选
 */
const originalFilterChanged = window.filterChanged;
window.filterChanged = function() {
    const statusFilter = document.getElementById('statusFilter').value;
    const poolGroupFilter = document.getElementById('poolGroupFilter')?.value || 'all';

    currentStatus = statusFilter;
    currentPage = 1;

    // 如果有池子筛选，在API请求中添加参数
    // TODO: 后端需要支持 poolGroup 参数
    fetchKeys();
};

// ===== 📥 导出密钥功能 =====

/**
 * 显示导出密钥模态框
 */
function showExportKeysModal() {
    updatePoolGroupSelects();
    showModal('exportKeysModal');
}

/**
 * 切换"全部池"选项
 */
function toggleExportAllPools() {
    const allPoolsChecked = document.getElementById('exportAllPools').checked;
    const poolOptions = document.getElementById('exportPoolOptions');
    poolOptions.style.display = allPoolsChecked ? 'none' : 'block';
}

/**
 * 确认导出密钥
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
                alert('请至少选择一个池子！');
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
        alert(`✅ 导出成功！文件名: ${filename}`);
    } catch (error) {
        console.error('❌ 导出失败:', error);
        alert(`导出失败: ${error.message}`);
    }
}

// ===== 🧪 批量测试功能 =====

/**
 * 显示批量测试模态框
 */
function showBatchTestModal() {
    updatePoolGroupSelects();
    document.getElementById('testResult').innerHTML = '';
    showModal('batchTestModal');
}

/**
 * 切换测试池子选项
 */
function toggleTestPoolOptions() {
    const testSpecific = document.querySelector('input[name="testPool"][value="specific"]').checked;
    const poolOptions = document.getElementById('testPoolOptions');
    poolOptions.style.display = testSpecific ? 'block' : 'none';
}

/**
 * 确认批量测试
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
        resultDiv.innerHTML = '<div class="loading">🧪 正在测试中，请稍候...</div>';

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
        message += '<h3>🎉 批量测试完成</h3>';
        message += `<p>📊 总密钥数: ${data.total} 个</p>`;
        message += `<p>🔍 已测试: ${data.tested} 个</p>`;
        message += `<p>✅ 测试通过: ${data.success} 个</p>`;
        message += `<p>❌ 测试失败: ${data.failed} 个</p>`;
        message += `<p>🚫 自动封禁: ${data.banned} 个</p>`;
        if (data.banned > 0) {
            message += '<p class="hint">💡 提示: 已自动封禁余额不足的密钥</p>';
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
        console.error('❌ 批量测试失败:', error);
        const resultDiv = document.getElementById('testResult');
        resultDiv.innerHTML = `<div class="result-summary error">❌ 测试失败: ${error.message}</div>`;
    }
}

// 监听单选按钮变化
document.addEventListener('DOMContentLoaded', () => {
    const testPoolRadios = document.querySelectorAll('input[name="testPool"]');
    testPoolRadios.forEach(radio => {
        radio.addEventListener('change', toggleTestPoolOptions);
    });
});

// 页面加载时初始化池子数据
window.addEventListener('DOMContentLoaded', () => {
    // 等待主程序的 autoAuthenticate 完成后加载池子
    setTimeout(() => {
        if (adminKey) {
            loadPoolGroups();
        }
    }, 1000);
});

console.log('✅ 多级密钥池管理功能已加载 - BaSui');
