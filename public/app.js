// 全局变量
let adminKey = '';
let currentPage = 1;
let currentStatus = 'all';
let currentPoolGroup = 'all';  // 当前选择的密钥池
let currentPageSize = 10;  // 每页显示行数
let currentEditKeyId = null;
// BaSui: 批量操作模态框状态变量
let batchModalKeyIds = new Set();
let batchModalAllKeys = [];
let batchModalFilterStatus = 'all';
let batchModalFilterPool = 'all';

// BaSui：localStorage的key名称
const STORAGE_KEY_ADMIN = 'droid2api_admin_key';
const STORAGE_KEY_LOGIN_TIME = 'droid2api_login_time';
const LOGIN_EXPIRE_HOURS = 1; // 1小时过期

// BaSui：HTTP状态码中文映射，让用户看懂这些SB代码是啥意思
const HTTP_STATUS_MAP = {
    200: '请求成功',
    201: '创建成功',
    400: '请求参数错误',
    401: '认证失败 - 密钥无效',
    402: '余额不足 - 没有可用额度',
    403: '权限不足 - 禁止访问',
    404: '资源不存在',
    429: '请求过于频繁 - 触发限流',
    500: '服务器内部错误',
    502: '网关错误',
    503: '服务不可用',
    504: '网关超时',
    0: '网络错误或请求超时'
};

// BaSui：根据状态码获取中文说明
function getStatusMessage(statusCode) {
    return HTTP_STATUS_MAP[statusCode] || `未知错误 (${statusCode})`;
}

// 认证
function authenticate() {
    const key = document.getElementById('adminKeyInput').value.trim();
    if (!key) {
        alert('请输入管理员密钥');
        return;
    }

    adminKey = key;

    // 测试认证
    fetchStats()
        .then(() => {
            // BaSui：认证成功后保存到localStorage，包含密钥和登录时间
            localStorage.setItem(STORAGE_KEY_ADMIN, key);
            localStorage.setItem(STORAGE_KEY_LOGIN_TIME, Date.now().toString());

            document.getElementById('authSection').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            refreshData(true);  // BaSui: 传递true确保初始加载时显示Token和余额数据
        })
        .catch(err => {
            alert('认证失败: ' + err.message);
            adminKey = '';
        });
}

// BaSui：退出登录功能
function logout() {
    if (!confirm('确认退出登录？')) return;

    // 清除localStorage和内存中的密钥和登录时间
    localStorage.removeItem(STORAGE_KEY_ADMIN);
    localStorage.removeItem(STORAGE_KEY_LOGIN_TIME);
    adminKey = '';

    // 切换显示
    document.getElementById('authSection').style.display = 'flex';
    document.getElementById('mainContent').style.display = 'none';

    // 清空密码输入框
    document.getElementById('adminKeyInput').value = '';
}

// BaSui：检查登录是否过期
function isLoginExpired() {
    const loginTime = localStorage.getItem(STORAGE_KEY_LOGIN_TIME);
    if (!loginTime) return true; // 没有登录时间，认为过期

    const loginTimestamp = parseInt(loginTime);
    const now = Date.now();
    const expireTime = LOGIN_EXPIRE_HOURS * 60 * 60 * 1000; // 转换为毫秒

    return (now - loginTimestamp) > expireTime;
}

// BaSui：清除过期的登录信息
function clearExpiredLogin() {
    localStorage.removeItem(STORAGE_KEY_ADMIN);
    localStorage.removeItem(STORAGE_KEY_LOGIN_TIME);
    adminKey = '';
}

// BaSui：页面加载时自动认证
function autoAuthenticate() {
    const savedKey = localStorage.getItem(STORAGE_KEY_ADMIN);

    if (!savedKey) {
        // 没有保存的密钥，显示登录界面
        return;
    }

    // BaSui：检查登录是否过期
    if (isLoginExpired()) {
        console.log('登录已过期，清除登录信息');
        clearExpiredLogin();
        alert(`登录已过期（超过${LOGIN_EXPIRE_HOURS}小时），请重新输入管理员密钥`);
        return;
    }

    adminKey = savedKey;

    // 测试保存的密钥是否有效
    fetchStats()
        .then(() => {
            // 密钥有效，直接进入主界面
            document.getElementById('authSection').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            refreshData(true);  // BaSui: 传递true确保初始加载时显示Token和余额数据
        })
        .catch(err => {
            // 密钥无效，清除保存的密钥，显示登录界面
            console.error('自动认证失败:', err);
            clearExpiredLogin();
            alert('登录已过期，请重新输入管理员密钥');
        });
}

// BaSui：页面加载时执行自动认证
window.addEventListener('DOMContentLoaded', autoAuthenticate);

// API 请求封装
async function apiRequest(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: {
            'x-admin-key': adminKey,
            'Content-Type': 'application/json'
        }
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(`/admin${endpoint}`, options);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || `HTTP ${response.status}`);
    }

    return response.json();
}

// 获取统计信息
async function fetchStats() {
    const response = await apiRequest('/stats');
    const data = response.data;  // 解包后端的 {success, data} 结构
    document.getElementById('statTotal').textContent = data.total;
    document.getElementById('statActive').textContent = data.active;
    document.getElementById('statDisabled').textContent = data.disabled;
    document.getElementById('statBanned').textContent = data.banned;

    // BaSui：同时获取当前轮询算法配置并显示
    try {
        const configResponse = await apiRequest('/config');
        const config = configResponse.data;
        const algorithmElement = document.getElementById('statAlgorithm');
        if (algorithmElement) {
            algorithmElement.textContent = getAlgorithmText(config.algorithm);
        }
    } catch (err) {
        console.error('Failed to fetch config:', err);
    }
    
    // BaSui：获取并更新Token和请求统计
    await updateDashboardStats();
}

// 获取密钥列表
async function fetchKeys() {
    const params = new URLSearchParams({
        page: currentPage,
        limit: currentPageSize,
        status: currentStatus,
        poolGroup: currentPoolGroup,  // BaSui: 密钥池筛选参数
        includeTokenUsage: 'true'  // BaSui: 包含Token使用量信息
    });

    const response = await apiRequest(`/keys?${params}`);
    const data = response.data;  // 解包后端的 {success, data} 结构
    renderKeysTable(data.keys);
    renderPagination(data.pagination);
    // BaSui：新增图表渲染
    renderCharts(data.keys);
    // 更新总数显示
    const totalCountEl = document.getElementById('totalKeysCount');
    if (totalCountEl) {
        totalCountEl.textContent = data.pagination.total || 0;
    }
}

// 渲染密钥表格 - 优化版本，使用DocumentFragment减少重排
function renderKeysTable(keys) {
    const tbody = document.getElementById('keysTableBody');

    if (keys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="15" class="loading-modern"><div class="loading-spinner"></div><span>暂无数据</span></td></tr>';
        return;
    }

    // 使用DocumentFragment批量插入，避免频繁DOM操作
    const fragment = document.createDocumentFragment();
    const tempContainer = document.createElement('tbody');
    
    tempContainer.innerHTML = keys.map(key => {
        // BaSui：生成测试结果的详细显示（包含状态码和中文说明）
        let testResultHtml = '';
        if (key.last_test_result === 'success') {
            testResultHtml = '<span class="test-success">✅ 测试通过</span>';
        } else if (key.last_test_result === 'failed') {
            // 从last_error中提取状态码（格式：402: xxx）
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

        // 计算成功率和评分 - BaSui修复：确保成功次数准确
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

        // BaSui: Token使用量显示（带颜色提示和剩余token）
        let tokenUsageHtml = '-';
        if (key.token_usage) {
            const { used, limit, remaining, percentage } = key.token_usage;
            const percentNum = parseFloat(percentage);
            let tokenColor = '#10b981';  // 绿色 (低使用率)
            if (percentNum > 80) {
                tokenColor = '#ef4444';  // 红色 (高使用率)
            } else if (percentNum > 60) {
                tokenColor = '#f59e0b';  // 橙色
            } else if (percentNum > 40) {
                tokenColor = '#fbbf24';  // 黄色
            }

            tokenUsageHtml = `
                <div style="display: flex; flex-direction: column; align-items: center;">
                    <span style="font-weight: 600;">${formatTokens(used)} / ${formatTokens(limit)}</span>
                    <span style="color: ${tokenColor}; font-size: 0.85em;">(剩余 ${formatTokens(remaining)})</span>
                    <span style="color: ${tokenColor}; font-weight: 600;">${percentage}%</span>
                </div>
            `;
        }

        // BaSui：密钥池显示（小字体、横向、无emoji）
        const poolGroupDisplay = key.poolGroup || 'default';
        const poolGroupBadge = poolGroupDisplay === 'default'
            ? `<span class="pool-badge-compact pool-default">${poolGroupDisplay}</span>`
            : `<span class="pool-badge-compact pool-custom">${poolGroupDisplay}</span>`;

        return `
        <tr>
            <td><code class="key-id-short" title="${key.id}">${key.id.substring(0, 16)}...</code></td>
            <td><code>${maskKey(key.key)}</code></td>
            <td>${poolGroupBadge}</td>
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
                <button onclick="showEditKeyModal('${key.id}', '${key.key}', '${escapeHtml(key.notes || '')}', '${poolGroupDisplay}')" class="btn btn-primary btn-sm">编辑</button>
                <button onclick="showEditNotesModal('${key.id}', '${escapeHtml(key.notes || '')}')" class="btn btn-secondary btn-sm">备注</button>
                <button onclick="showChangePoolModal('${key.id}', '${poolGroupDisplay}')" class="btn btn-warning btn-sm">修改池</button>
                <button onclick="deleteKey('${key.id}')" class="btn btn-danger btn-sm">删除</button>
            </td>
        </tr>
        `;
    }).join('');
    
    // 批量移动所有子节点到fragment
    while (tempContainer.firstChild) {
        fragment.appendChild(tempContainer.firstChild);
    }
    
    // 一次性替换tbody内容
    tbody.innerHTML = '';
    tbody.appendChild(fragment);
}

// 渲染分页
function renderPagination(pagination) {
    const container = document.getElementById('pagination');
    const { page, total_pages, total } = pagination;

    container.innerHTML = `
        <button ${page <= 1 ? 'disabled' : ''} onclick="changePage(${page - 1})">上一页</button>
        <span class="page-info">第 ${page} / ${total_pages} 页 (共 ${total} 条)</span>
        <button ${page >= total_pages ? 'disabled' : ''} onclick="changePage(${page + 1})">下一页</button>
    `;
}

// 工具函数
function maskKey(key) {
    if (key.length <= 10) return key;
    return key.substring(0, 6) + '...' + key.substring(key.length - 4);
}

function getStatusText(status) {
    const map = {
        'active': '可用',
        'disabled': '已禁用',
        'banned': '已封禁'
    };
    return map[status] || status;
}

// BaSui：已经不需要这个简陋的函数了，被更强大的状态码映射替代

function getToggleButtonClass(status) {
    switch (status) {
        case 'active':
            return 'btn-warning';  // 禁用按钮
        case 'disabled':
            return 'btn-success';  // 启用按钮
        case 'banned':
            return 'btn-info';     // 解除封禁按钮
        default:
            return 'btn-secondary';
    }
}

function getToggleButtonText(status) {
    switch (status) {
        case 'active':
            return '禁用';
        case 'disabled':
            return '启用';
        case 'banned':
            return '解封';
        default:
            return '操作';
    }
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN');
}

function escapeHtml(text) {
    return text.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

// 防抖函数 - 减少频繁调用
function debounce(func, wait = 300) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// 节流函数 - 限制执行频率
function throttle(func, limit = 100) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// 优化后的fetchKeys函数（带防抖）
const debouncedFetchKeys = debounce(fetchKeys, 300);

// 页面操作
function changePage(page) {
    currentPage = page;
    debouncedFetchKeys();
}

function filterChanged() {
    currentStatus = document.getElementById('statusFilter').value;
    currentPoolGroup = document.getElementById('poolGroupFilter').value;
    currentPage = 1;
    debouncedFetchKeys();
}

// BaSui：每页显示行数变化
function pageSizeChanged() {
    const pageSizeSelect = document.getElementById('pageSizeSelect');
    currentPageSize = parseInt(pageSizeSelect.value);
    currentPage = 1;  // 重置到第一页
    fetchKeys();
}

// ========== 🚀 BaSui: 批量操作功能 ==========

async function loadBatchModalPoolGroups() {
    try {
        const response = await apiRequest('/pool-groups');
        const poolGroups = response.data || [];
        
        // 更新目标池选择器
        const targetPoolSelect = document.getElementById('batchActionPoolSelect');
        if (targetPoolSelect) {
            targetPoolSelect.innerHTML = '<option value="">-- 请选择目标池 --</option><option value="default">默认池 (default)</option>';
            poolGroups.forEach(group => {
                if (group.id !== 'default') {
                    const option = document.createElement('option');
                    option.value = group.id;
                    option.textContent = `${group.name || group.id} (${group.id})`;
                    targetPoolSelect.appendChild(option);
                }
            });
        }
        
        // 更新筛选器的密钥池选项
        const filterPoolSelect = document.getElementById('batchModalPoolFilter');
        if (filterPoolSelect) {
            filterPoolSelect.innerHTML = '<option value="all">全部池</option><option value="default">默认池</option>';
            poolGroups.forEach(group => {
                if (group.id !== 'default') {
                    const option = document.createElement('option');
                    option.value = group.id;
                    option.textContent = `${group.name || group.id} (${group.id})`;
                    filterPoolSelect.appendChild(option);
                }
            });
        }
    } catch (err) {
        console.error('加载密钥池列表失败:', err);
        // 失败时使用默认选项
    }
}

/**
 * 打开批量操作模态框
 * @param {string} actionType - 操作类型：'changePool' | 'enable' | 'disable' | 'delete'
 */
async function openBatchActionModal(actionType) {
    // 清空之前的选择
    batchModalKeyIds.clear();
    batchModalFilterStatus = 'all';
    batchModalFilterPool = 'all';
    
    // 设置模态框标题和操作类型
    const modalTitle = {
        'changePool': '🔄 批量改池',
        'enable': '✅ 批量启用',
        'disable': '⏸️ 批量禁用',
        'delete': '🗑️ 批量删除'
    }[actionType] || '批量操作';
    
    document.getElementById('batchActionModalTitle').textContent = modalTitle;
    document.getElementById('batchActionModalType').value = actionType;
    
    // 显示/隐藏目标池选择器（只有改池操作需要）
    const poolSelectorDiv = document.getElementById('batchActionPoolSelector');
    if (poolSelectorDiv) {
        poolSelectorDiv.style.display = actionType === 'changePool' ? 'block' : 'none';
    }
    
    // 加载密钥池列表
    await loadBatchModalPoolGroups();
    
    // 加载所有密钥
    await loadBatchModalKeys();
    
    // 显示模态框
    showModal('batchActionModal');
}

/**
 * 加载批量操作模态框的密钥列表
 */
async function loadBatchModalKeys() {
    try {
        // 优化：减少一次性加载的数据量，改为100条
        const params = new URLSearchParams({
            page: 1,
            limit: 100, // 减少到100条，避免性能问题
            status: 'all',
            includeTokenUsage: 'false'  // 不需要Token信息，减少数据传输
        });
        
        const response = await apiRequest(`/keys?${params}`);
        batchModalAllKeys = response.data.keys || [];
        
        // 渲染模态框内的密钥列表
        renderBatchModalKeys();
        updateBatchModalCount();
    } catch (err) {
        console.error('加载密钥列表失败:', err);
        alert('加载密钥列表失败: ' + err.message);
    }
}

/**
 * 渲染批量操作模态框内的密钥列表
 */
function renderBatchModalKeys() {
    // 应用筛选
    let filteredKeys = batchModalAllKeys;
    
    // 按状态筛选
    if (batchModalFilterStatus !== 'all') {
        filteredKeys = filteredKeys.filter(k => k.status === batchModalFilterStatus);
    }
    
    // 按密钥池筛选
    if (batchModalFilterPool !== 'all') {
        filteredKeys = filteredKeys.filter(k => (k.poolGroup || 'default') === batchModalFilterPool);
    }
    
    const tbody = document.getElementById('batchModalKeysTableBody');
    
    if (filteredKeys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #999;">暂无符合条件的密钥</td></tr>';
        return;
    }
    
    tbody.innerHTML = filteredKeys.map(key => {
        const checked = batchModalKeyIds.has(key.id) ? 'checked' : '';
        const poolBadge = key.poolGroup || 'default';
        const statusBadge = getStatusText(key.status);
        
        return `
            <tr>
                <td><input type="checkbox" class="batch-modal-checkbox" data-key-id="${key.id}" ${checked} onchange="toggleBatchModalKey('${key.id}', this.checked)"></td>
                <td><code style="font-size: 0.85em;">${key.id}</code></td>
                <td><code style="font-size: 0.85em;">${maskKey(key.key)}</code></td>
                <td><span class="pool-badge">${poolBadge}</span></td>
                <td><span class="status-badge status-${key.status}">${statusBadge}</span></td>
            </tr>
        `;
    }).join('');
}

/**
 * 切换批量操作模态框内的密钥选择
 */
function toggleBatchModalKey(keyId, checked) {
    if (checked) {
        batchModalKeyIds.add(keyId);
    } else {
        batchModalKeyIds.delete(keyId);
    }
    updateBatchModalCount();
}

/**
 * 全选/取消全选（模态框内）
 */
function toggleBatchModalSelectAll(checked) {
    // 获取当前筛选后的密钥
    let filteredKeys = batchModalAllKeys;
    
    if (batchModalFilterStatus !== 'all') {
        filteredKeys = filteredKeys.filter(k => k.status === batchModalFilterStatus);
    }
    
    if (batchModalFilterPool !== 'all') {
        filteredKeys = filteredKeys.filter(k => (k.poolGroup || 'default') === batchModalFilterPool);
    }
    
    // 更新选中状态
    filteredKeys.forEach(key => {
        if (checked) {
            batchModalKeyIds.add(key.id);
        } else {
            batchModalKeyIds.delete(key.id);
        }
    });
    
    // 重新渲染列表
    renderBatchModalKeys();
    updateBatchModalCount();
}

/**
 * 批量操作模态框的筛选器变更
 */
function batchModalFilterChanged() {
    batchModalFilterStatus = document.getElementById('batchModalStatusFilter').value;
    batchModalFilterPool = document.getElementById('batchModalPoolFilter').value;
    renderBatchModalKeys();
}

/**
 * 更新批量操作模态框的选中数量显示
 */
function updateBatchModalCount() {
    const count = batchModalKeyIds.size;
    document.getElementById('batchModalSelectedCount').textContent = count;
    
    // 更新全选复选框状态
    const selectAllCheckbox = document.getElementById('batchModalSelectAll');
    if (selectAllCheckbox) {
        // 获取当前筛选后的密钥数量
        let filteredKeys = batchModalAllKeys;
        if (batchModalFilterStatus !== 'all') {
            filteredKeys = filteredKeys.filter(k => k.status === batchModalFilterStatus);
        }
        if (batchModalFilterPool !== 'all') {
            filteredKeys = filteredKeys.filter(k => (k.poolGroup || 'default') === batchModalFilterPool);
        }
        
        // 如果当前筛选的密钥全部被选中，则勾选全选框
        const allSelected = filteredKeys.length > 0 && filteredKeys.every(k => batchModalKeyIds.has(k.id));
        selectAllCheckbox.checked = allSelected;
    }
    
    // 启用/禁用确认按钮
    const confirmButton = document.getElementById('batchActionConfirmBtn');
    if (confirmButton) {
        confirmButton.disabled = count === 0;
    }
}

/**
 * 执行批量操作
 */
async function confirmBatchAction() {
    const actionType = document.getElementById('batchActionModalType').value;
    const selectedCount = batchModalKeyIds.size;
    
    if (selectedCount === 0) {
        alert('请至少选择一个密钥');
        return;
    }
    
    const keyIds = Array.from(batchModalKeyIds);
    
    try {
        switch (actionType) {
            case 'changePool':
                await executeBatchChangePool(keyIds);
                break;
            case 'enable':
                await executeBatchToggleStatus(keyIds, 'active');
                break;
            case 'disable':
                await executeBatchToggleStatus(keyIds, 'disabled');
                break;
            case 'delete':
                await executeBatchDelete(keyIds);
                break;
            default:
                alert('未知的操作类型');
                return;
        }
    } catch (err) {
        console.error('批量操作失败:', err);
    }
}

/**
 * 执行批量改池
 */
async function executeBatchChangePool(keyIds) {
    const poolGroup = document.getElementById('batchActionPoolSelect').value;
    
    if (!poolGroup) {
        alert('请选择目标密钥池');
        return;
    }
    
    if (!confirm(`确认将 ${keyIds.length} 个密钥移动到池「${poolGroup}」？`)) {
        return;
    }
    
    try {
        const result = await apiRequest('/keys/batch-change-pool', 'PATCH', {
            keyIds,
            poolGroup
        });
        
        alert(`✅ 批量改池成功！\n已移动 ${result.data.count} 个密钥到「${poolGroup}」`);
        closeModal('batchActionModal');
        refreshData();
    } catch (err) {
        alert('❌ 批量改池失败: ' + err.message);
    }
}

/**
 * 执行批量启用/禁用
 */
async function executeBatchToggleStatus(keyIds, status) {
    const action = status === 'active' ? '启用' : '禁用';
    
    if (!confirm(`确认${action} ${keyIds.length} 个密钥？`)) {
        return;
    }
    
    try {
        const result = await apiRequest('/keys/batch-toggle-status', 'PATCH', {
            keyIds,
            status
        });
        
        alert(`✅ 批量${action}成功！\n已${action} ${result.data.count} 个密钥`);
        closeModal('batchActionModal');
        refreshData();
    } catch (err) {
        alert(`❌ 批量${action}失败: ` + err.message);
    }
}

/**
 * 执行批量删除
 */
async function executeBatchDelete(keyIds) {
    if (!confirm(`⚠️ 确认删除 ${keyIds.length} 个密钥？\n删除后无法恢复！`)) {
        return;
    }
    
    try {
        const result = await apiRequest('/keys/batch-delete', 'DELETE', {
            keyIds
        });
        
        alert(`✅ 批量删除成功！\n已删除 ${result.data.count} 个密钥`);
        closeModal('batchActionModal');
        refreshData();
    } catch (err) {
        alert('❌ 批量删除失败: ' + err.message);
    }
}

// 批量操作功能代码块结束

// 模态框操作
function showModal(modalId) {
    document.getElementById(modalId).style.display = 'block';
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

async function showAddKeyModal() {
    // BaSui: 先确保池子数据已加载，再打开模态框
    if (typeof poolGroupsData !== 'undefined' && (!poolGroupsData || poolGroupsData.length === 0)) {
        if (typeof loadPoolGroups === 'function') {
            await loadPoolGroups();
        }
    }
    if (typeof updatePoolGroupSelects === 'function') {
        updatePoolGroupSelects();
    }
    document.getElementById('newKeyInput').value = '';
    document.getElementById('newKeyNotes').value = '';
    showModal('addKeyModal');
}

async function showBatchImportModal() {
    // BaSui: 先确保池子数据已加载，再打开模态框
    if (typeof poolGroupsData !== 'undefined' && (!poolGroupsData || poolGroupsData.length === 0)) {
        if (typeof loadPoolGroups === 'function') {
            await loadPoolGroups();
        }
    }
    if (typeof updatePoolGroupSelects === 'function') {
        updatePoolGroupSelects();
    }
    document.getElementById('batchKeysInput').value = '';
    document.getElementById('importResult').innerHTML = '';
    showModal('batchImportModal');
}

function showEditNotesModal(keyId, notes) {
    currentEditKeyId = keyId;
    document.getElementById('editNotesInput').value = notes.replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    showModal('editNotesModal');
}

// BaSui: 显示编辑密钥模态框（支持修改密钥池）
function showEditKeyModal(keyId, key, notes, poolGroup) {
    currentEditKeyId = keyId;
    document.getElementById('editKeyInput').value = key;
    document.getElementById('editKeyNotesInput').value = notes.replace(/&#39;/g, "'").replace(/&quot;/g, '"');

    // BaSui：更新池子选择器列表（如果 pool-groups.js 已加载）
    if (typeof updatePoolGroupSelects === 'function') {
        updatePoolGroupSelects();
    }

    // BaSui：设置密钥池选择器的值
    const poolSelect = document.getElementById('editKeyPoolGroup');
    if (poolSelect) {
        poolSelect.value = poolGroup || 'default';
    }

    showModal('editKeyModal');
}

// 密钥操作
async function addKey() {
    const key = document.getElementById('newKeyInput').value.trim();
    const notes = document.getElementById('newKeyNotes').value.trim();
    const poolGroup = document.getElementById('newKeyPoolGroup')?.value || null;

    if (!key) {
        alert('请输入密钥');
        return;
    }

    if (!key.startsWith('fk-')) {
        alert('密钥格式错误，必须以 fk- 开头');
        return;
    }

    try {
        await apiRequest('/keys', 'POST', { key, notes, poolGroup });
        alert('添加成功');
        closeModal('addKeyModal');
        refreshData();
    } catch (err) {
        alert('添加失败: ' + err.message);
    }
}

async function batchImport() {
    const keysText = document.getElementById('batchKeysInput').value.trim();
    const poolGroup = document.getElementById('batchImportPoolGroup').value || null;

    if (!keysText) {
        alert('请输入密钥');
        return;
    }

    const keys = keysText.split('\n').map(k => k.trim()).filter(k => k);

    try {
        const response = await apiRequest('/keys/batch', 'POST', { keys, poolGroup });
        const result = response.data; // BaSui: 后端数据在response.data里

        const resultDiv = document.getElementById('importResult');

        // 根据导入结果智能判断状态（BaSui我可不喜欢SB的提示）
        let statusClass = 'success';
        let statusEmoji = '✅';
        let summaryText = '';

        if (result.success > 0) {
            // 有成功导入的密钥
            statusClass = 'success';
            statusEmoji = '✅';
            summaryText = `成功导入 ${result.success} 个密钥！`;
        } else if (result.duplicate > 0 && result.invalid === 0) {
            // 全部重复，没有无效
            statusClass = 'warning';
            statusEmoji = '🔄';
            summaryText = `所有密钥都已存在（${result.duplicate} 个重复）`;
        } else if (result.invalid > 0 && result.duplicate === 0) {
            // 全部无效
            statusClass = 'error';
            statusEmoji = '❌';
            summaryText = `所有密钥都无效（${result.invalid} 个）`;
        } else {
            // 混合情况
            statusClass = 'warning';
            statusEmoji = '⚠️';
            summaryText = '导入完成，但部分密钥有问题';
        }

        resultDiv.className = `import-result ${statusClass}`;
        resultDiv.innerHTML = `
            <h3>${statusEmoji} ${summaryText}</h3>
            <div class="result-details">
                <p>✅ 成功导入: ${result.success} 个</p>
                <p>🔄 已存在(跳过): ${result.duplicate} 个</p>
                <p>❌ 格式错误: ${result.invalid} 个</p>
            </div>
            ${result.errors && result.errors.length > 0 ? `<p class=\"error-info\">错误详情: ${result.errors.join(', ')}</p>` : ''}
        `;

        refreshData();
    } catch (err) {
        const resultDiv = document.getElementById('importResult');
        resultDiv.className = 'import-result error';
        resultDiv.innerHTML = `<p>❌ 请求失败: ${err.message}</p>`;
    }
}

// BaSui：导出密钥功能 - 下载txt文件（一个密钥一行）
async function exportKeys() {
    try {
        // 获取当前筛选状态（用户可以先筛选状态，然后导出对应的密钥）
        const status = document.getElementById('statusFilter').value;

        // 构造导出URL
        const url = `/admin/keys/export?status=${status}`;

        // 发送请求（必须带x-admin-key认证头）
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'x-admin-key': adminKey
            }
        });

        // BaSui：处理错误响应
        if (!response.ok) {
            let errorMsg = `HTTP ${response.status}`;
            try {
                const error = await response.json();
                errorMsg = error.message || errorMsg;
            } catch (e) {
                // 响应不是JSON格式，使用状态码
            }
            throw new Error(errorMsg);
        }

        // BaSui：获取文件内容（Blob对象）
        const blob = await response.blob();

        // BaSui：从响应头提取文件名（后端设置的Content-Disposition）
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = `keys_${status}_${new Date().toISOString().split('T')[0]}.txt`;

        if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
            if (filenameMatch && filenameMatch[1]) {
                filename = filenameMatch[1];
            }
        }

        // BaSui：创建下载链接并触发下载（这招屡试不爽！）
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();

        // BaSui：清理临时对象，避免内存泄漏
        setTimeout(() => {
            window.URL.revokeObjectURL(downloadUrl);
            document.body.removeChild(a);
        }, 100);

        // BaSui：显示成功提示
        alert(`✅ 导出成功！\n文件名：${filename}\n状态筛选：${status === 'all' ? '全部' : status}`);

    } catch (err) {
        alert('❌ 导出失败: ' + err.message);
        console.error('Export keys error:', err);
    }
}

async function testKey(keyId) {
    if (!confirm('确认测试此密钥？')) return;

    try {
        const result = await apiRequest(`/keys/${keyId}/test`, 'POST');
        const data = result.data;

        // BaSui：显示完整的中文测试结果
        let message = '━━━━━━━━━━━━━━━━━━━━\n';
        message += '📊 密钥测试结果\n';
        message += '━━━━━━━━━━━━━━━━━━━━\n\n';

        if (data.success) {
            message += '✅ 测试通过\n\n';
            message += `状态码: ${data.status}\n`;
            message += `说明: ${getStatusMessage(data.status)}\n`;
            message += `密钥状态: ${getStatusText(data.key_status)}`;
        } else {
            message += '❌ 测试失败\n\n';
            message += `状态码: ${data.status}\n`;
            message += `错误类型: ${getStatusMessage(data.status)}\n`;
            message += `错误详情: ${data.message}\n`;
            message += `密钥状态: ${getStatusText(data.key_status)}`;
        }

        alert(message);
        refreshData();
    } catch (err) {
        alert('❌ 测试请求失败\n\n' + err.message);
    }
}

async function testAllKeys() {
    if (!confirm('确认批量测试所有密钥？这可能需要较长时间')) return;

    try {
        const result = await apiRequest('/keys/test-all', 'POST');
        const data = result.data;

        // BaSui：批量测试结果也要中文化
        let message = '━━━━━━━━━━━━━━━━━━━━\n';
        message += '🧪 批量测试完成\n';
        message += '━━━━━━━━━━━━━━━━━━━━\n\n';
        message += `📊 总密钥数: ${data.total} 个\n`;
        message += `🔍 已测试: ${data.tested} 个\n`;
        message += `✅ 测试通过: ${data.success} 个\n`;
        message += `❌ 测试失败: ${data.failed} 个\n`;
        message += `🚫 自动封禁: ${data.banned} 个\n\n`;

        if (data.banned > 0) {
            message += '💡 提示: 已自动封禁余额不足的密钥\n';
            message += '可点击「删除封禁密钥」批量清理';
        }

        alert(message);
        refreshData();
    } catch (err) {
        alert('❌ 批量测试失败\n\n' + err.message);
    }
}

async function deleteBannedKeys() {
    // BaSui：先拿统计信息，看看有多少个封禁密钥
    try {
        const statsResponse = await apiRequest('/stats');
        const bannedCount = statsResponse.data.banned;

        if (bannedCount === 0) {
            alert('没有封禁的密钥需要删除');
            return;
        }

        if (!confirm(`确认删除所有 ${bannedCount} 个封禁密钥？\n删除后无法恢复！`)) return;

        // BaSui：调用删除封禁密钥API
        const result = await apiRequest('/keys/banned', 'DELETE');

        // BaSui：检查返回数据结构，防止空指针错误
        const deletedCount = result && result.data && result.data.count ? result.data.count : 0;
        alert(`删除成功！\n已删除 ${deletedCount} 个封禁密钥`);
        refreshData();
    } catch (err) {
        console.error('删除封禁密钥失败:', err);
        alert('删除封禁密钥失败: ' + err.message);
    }
}

async function deleteDisabledKeys() {
    // BaSui：先拿统计信息，看看有多少个禁用密钥
    try {
        const statsResponse = await apiRequest('/stats');
        const disabledCount = statsResponse.data.disabled;

        if (disabledCount === 0) {
            alert('没有禁用的密钥需要删除');
            return;
        }

        if (!confirm(`确认删除所有 ${disabledCount} 个禁用密钥？\n删除后无法恢复！`)) return;

        // BaSui：调用删除禁用密钥API
        const result = await apiRequest('/keys/disabled', 'DELETE');

        // BaSui：检查返回数据结构，防止空指针错误
        const deletedCount = result && result.data && result.data.count ? result.data.count : 0;
        alert(`删除成功！\n已删除 ${deletedCount} 个禁用密钥`);
        refreshData();
    } catch (err) {
        console.error('删除禁用密钥失败:', err);
        alert('删除禁用密钥失败: ' + err.message);
    }
}

async function toggleKeyStatus(keyId, currentStatus) {
    let newStatus, action, confirmMessage;

    // BaSui：根据当前状态确定操作
    switch (currentStatus) {
        case 'active':
            newStatus = 'disabled';
            action = '禁用';
            confirmMessage = `确认禁用此密钥？\n禁用后不会参与轮询，但可以重新启用。`;
            break;
        case 'disabled':
            newStatus = 'active';
            action = '启用';
            confirmMessage = `确认启用此密钥？`;
            break;
        case 'banned':
            newStatus = 'active';
            action = '解除封禁';
            confirmMessage = `确认解除封禁此密钥？\n解除封禁后密钥将重新参与轮询。`;
            break;
        default:
            // BaSui：未知状态，默认设为禁用
            newStatus = 'disabled';
            action = '禁用';
            confirmMessage = `确认禁用此密钥？`;
    }

    if (!confirm(confirmMessage)) return;

    try {
        // BaSui：对于封禁状态的密钥，直接调用toggle API（后端会清除封禁标记）
        await apiRequest(`/keys/${keyId}/toggle`, 'PATCH', { status: newStatus });
        alert(`${action}成功`);
        refreshData();
    } catch (err) {
        console.error(`${action}失败:`, err);
        alert(`${action}失败: ` + err.message);
    }
}

async function deleteKey(keyId) {
    if (!confirm('确认删除此密钥？删除后无法恢复！')) return;

    try {
        await apiRequest(`/keys/${keyId}`, 'DELETE');
        alert('删除成功');
        refreshData();
    } catch (err) {
        alert('删除失败: ' + err.message);
    }
}

async function saveNotes() {
    const notes = document.getElementById('editNotesInput').value.trim();

    try {
        // BaSui：后端用的是PATCH不是PUT
        await apiRequest(`/keys/${currentEditKeyId}/notes`, 'PATCH', { notes });
        alert('保存成功');
        closeModal('editNotesModal');
        refreshData();
    } catch (err) {
        alert('保存失败: ' + err.message);
    }
}

// BaSui: 保存编辑的密钥（调用PUT /admin/keys/:id + PATCH /admin/keys/:id/pool）
async function saveEditedKey() {
    const key = document.getElementById('editKeyInput').value.trim();
    const notes = document.getElementById('editKeyNotesInput').value.trim();
    const poolGroup = document.getElementById('editKeyPoolGroup')?.value || 'default';

    if (!key) {
        alert('请输入密钥');
        return;
    }

    if (!key.startsWith('fk-')) {
        alert('密钥格式错误，必须以 fk- 开头');
        return;
    }

    try {
        // BaSui：先更新密钥本身和备注
        await apiRequest(`/keys/${currentEditKeyId}`, 'PUT', { key, notes });

        // BaSui：然后更新密钥池（如果有变化）
        try {
            await apiRequest(`/keys/${currentEditKeyId}/pool`, 'PATCH', { poolGroup });
        } catch (poolErr) {
            console.warn('更新密钥池失败（可能密钥池未变化）:', poolErr);
        }

        alert('✅ 密钥更新成功！');
        closeModal('editKeyModal');
        refreshData();
    } catch (err) {
        alert('❌ 更新失败: ' + err.message);
    }
}

// BaSui：点击模态框外部关闭，使用addEventListener避免覆盖其他事件
window.addEventListener('click', function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
});

// ============================================
// BaSui：配置管理功能（轮询算法、重试机制等）
// ============================================

/**
 * 显示配置模态框
 */
async function showConfigModal() {
    try {
        // 加载当前配置
        const response = await apiRequest('/config');
        const config = response.data;

        // 填充表单
        document.getElementById('configAlgorithm').value = config.algorithm;

        document.getElementById('configRetryEnabled').checked = config.retry.enabled;
        document.getElementById('configRetryMaxRetries').value = config.retry.maxRetries;
        document.getElementById('configRetryDelay').value = config.retry.retryDelay;

        document.getElementById('configAutoBanEnabled').checked = config.autoBan.enabled;
        document.getElementById('configAutoBanThreshold').value = config.autoBan.errorThreshold;
        document.getElementById('configAutoBan402').checked = config.autoBan.ban402;
        document.getElementById('configAutoBan401').checked = config.autoBan.ban401;

        document.getElementById('configConcurrentLimit').value = config.performance.concurrentLimit;
        document.getElementById('configRequestTimeout').value = config.performance.requestTimeout;

        showModal('configModal');
    } catch (err) {
        alert('❌ 加载配置失败\n\n' + err.message);
    }
}

/**
 * 保存配置
 */
async function saveConfig() {
    try {
        const config = {
            // 基础配置
            port: parseInt(document.getElementById('configPort').value),
            user_agent: document.getElementById('configUserAgent').value,
            dev_mode: document.getElementById('configDevMode').checked,
            system_prompt: document.getElementById('configSystemPrompt').value,
            
            // 限制配置
            limits: {
                notes_max_length: parseInt(document.getElementById('configNotesMaxLength').value),
                max_json_log_size: parseInt(document.getElementById('configMaxJsonLogSize').value)
            },
            
            // 推理Token配置
            reasoning_tokens: {
                low: parseInt(document.getElementById('configReasoningLow').value),
                medium: parseInt(document.getElementById('configReasoningMedium').value),
                high: parseInt(document.getElementById('configReasoningHigh').value)
            },
            
            // 余额同步配置
            balance_sync: {
                sync_interval_minutes: parseInt(document.getElementById('configSyncInterval').value),
                save_interval_minutes: parseInt(document.getElementById('configSaveInterval').value)
            },
            
            // 密钥池配置
            key_pool: {
                algorithm: document.getElementById('configAlgorithm').value,
                retry: {
                    enabled: document.getElementById('configRetryEnabled').checked,
                    maxRetries: parseInt(document.getElementById('configRetryMaxRetries').value),
                    retryDelay: parseInt(document.getElementById('configRetryDelay').value)
                },
                autoBan: {
                    enabled: document.getElementById('configAutoBanEnabled').checked,
                    errorThreshold: parseInt(document.getElementById('configAutoBanThreshold').value),
                    ban402: document.getElementById('configAutoBan402').checked,
                    ban401: document.getElementById('configAutoBan401').checked
                },
                performance: {
                    concurrentLimit: parseInt(document.getElementById('configConcurrentLimit').value),
                    requestTimeout: parseInt(document.getElementById('configRequestTimeout').value)
                },
                multiTier: {
                    enabled: document.getElementById('configMultiTierEnabled').checked,
                    autoFallback: document.getElementById('configMultiTierAutoFallback').checked
                }
            },
            
            // Redis 配置
            redis: {
                enabled: document.getElementById('configRedisEnabled').checked,
                host: document.getElementById('configRedisHost').value,
                port: parseInt(document.getElementById('configRedisPort').value),
                password: document.getElementById('configRedisPassword').value,
                db: parseInt(document.getElementById('configRedisDb').value),
                key_prefix: document.getElementById('configRedisKeyPrefix').value
            },
            
            // 集群配置
            cluster: {
                enabled: document.getElementById('configClusterEnabled').checked,
                workers: parseInt(document.getElementById('configClusterWorkers').value)
            }
        };

        // BaSui：验证输入合法性
        if (config.port < 1 || config.port > 65535) {
            alert('❌ 端口必须在 1-65535 之间');
            return;
        }
        if (config.limits.notes_max_length < 100 || config.limits.notes_max_length > 10000) {
            alert('❌ 备注最大长度必须在 100-10000 之间');
            return;
        }
        if (config.limits.max_json_log_size < 1000 || config.limits.max_json_log_size > 50000) {
            alert('❌ JSON日志最大长度必须在 1000-50000 之间');
            return;
        }
        if (config.reasoning_tokens.low < 1024 || config.reasoning_tokens.low > 32768) {
            alert('❌ 低级推理Token必须在 1024-32768 之间');
            return;
        }
        if (config.reasoning_tokens.medium < 1024 || config.reasoning_tokens.medium > 32768) {
            alert('❌ 中级推理Token必须在 1024-32768 之间');
            return;
        }
        if (config.reasoning_tokens.high < 1024 || config.reasoning_tokens.high > 65536) {
            alert('❌ 高级推理Token必须在 1024-65536 之间');
            return;
        }
        if (config.balance_sync.sync_interval_minutes < 5 || config.balance_sync.sync_interval_minutes > 1440) {
            alert('❌ 同步间隔必须在 5-1440分钟 之间');
            return;
        }
        if (config.balance_sync.save_interval_minutes < 1 || config.balance_sync.save_interval_minutes > 60) {
            alert('❌ 保存间隔必须在 1-60分钟 之间');
            return;
        }
        if (config.key_pool.retry.maxRetries < 0 || config.key_pool.retry.maxRetries > 10) {
            alert('❌ 最大重试次数必须在 0-10 之间');
            return;
        }
        if (config.key_pool.retry.retryDelay < 0 || config.key_pool.retry.retryDelay > 10000) {
            alert('❌ 重试延迟必须在 0-10000ms 之间');
            return;
        }
        if (config.key_pool.autoBan.errorThreshold < 1 || config.key_pool.autoBan.errorThreshold > 100) {
            alert('❌ 错误阈值必须在 1-100 之间');
            return;
        }
        if (config.key_pool.performance.concurrentLimit < 1 || config.key_pool.performance.concurrentLimit > 1000) {
            alert('❌ 并发限制必须在 1-1000 之间');
            return;
        }
        if (config.key_pool.performance.requestTimeout < 1000 || config.key_pool.performance.requestTimeout > 60000) {
            alert('❌ 请求超时必须在 1000-60000ms 之间');
            return;
        }
        if (config.redis.port < 1 || config.redis.port > 65535) {
            alert('❌ Redis端口必须在 1-65535 之间');
            return;
        }
        if (config.redis.db < 0 || config.redis.db > 15) {
            alert('❌ Redis数据库编号必须在 0-15 之间');
            return;
        }
        if (config.cluster.workers < 0 || config.cluster.workers > 32) {
            alert('❌ Worker进程数必须在 0-32 之间');
            return;
        }

        await apiRequest('/config', 'PUT', config);
        
        // 检查是否修改了需要重启的配置
        const needsRestart = config.port !== originalPort || 
                           config.redis.enabled !== originalRedisEnabled ||
                           config.cluster.enabled !== originalClusterEnabled;
        
        if (needsRestart) {
            alert('✅ 配置保存成功！\n\n⚠️ 重要提示：\n- 端口修改需重启服务器\n- Redis 配置修改需重启服务器\n- 集群模式配置修改需重启服务器');
        } else {
            alert('✅ 配置保存成功！');
        }
        
        refreshData(); // 刷新统计信息以显示新算法
    } catch (err) {
        alert('❌ 保存配置失败\n\n' + err.message);
    }
}

/**
 * 重置配置为默认值
 */
async function resetConfigToDefault() {
    if (!confirm('确认重置所有配置为默认值？')) return;

    try {
        await apiRequest('/config/reset', 'POST');
        alert('✅ 配置已重置为默认值！');
        closeModal('configModal');
        refreshData();
    } catch (err) {
        alert('❌ 重置配置失败\n\n' + err.message);
    }
}

/**
 * 获取轮询算法的中文名称
 */
function getAlgorithmText(algorithm) {
    const map = {
        // 📋 传统算法
        'round-robin': '轮询',
        'random': '随机',
        'least-used': '最少使用',
        'weighted-score': '加权评分',

        // 🆕 基于Token用量的智能算法
        'least-token-used': '最少Token用量',
        'max-remaining': '最大剩余配额',

        // 🚀 高级智能算法
        'weighted-usage': '加权综合评分',
        'quota-aware': '配额感知',
        'time-window': '时间窗口'
    };
    return map[algorithm] || algorithm;
}

// BaSui：新增图表渲染功能（优化版）
/**
 * 渲染所有统计图表 - 使用requestAnimationFrame优化
 */
function renderCharts(keys) {
    // 使用requestAnimationFrame优化渲染顺序
    requestAnimationFrame(() => {
        renderStatusChart(keys);
        requestAnimationFrame(() => {
            renderSuccessRateChart(keys);
            requestAnimationFrame(() => {
                renderUsageChart(keys);
                requestAnimationFrame(() => {
                    renderTokenTrendChart(keys);
                });
            });
        });
    });
}

/**
 * 渲染密钥状态分布饼图
 */
function renderStatusChart(keys) {
    const statusCount = {
        active: 0,
        disabled: 0,
        banned: 0
    };

    keys.forEach(key => {
        statusCount[key.status] = (statusCount[key.status] || 0) + 1;
    });

    const total = keys.length;
    if (total === 0) {
        document.getElementById('statusChart').innerHTML = '<p style="color: #999;">暂无数据</p>';
        return;
    }

    // 计算角度
    const activeAngle = (statusCount.active / total) * 360;
    const disabledAngle = (statusCount.disabled / total) * 360;
    const bannedAngle = (statusCount.banned / total) * 360;

    // 生成饼图背景
    const pieBackground = `conic-gradient(
        #28a745 0deg ${activeAngle}deg,
        #ffc107 ${activeAngle}deg ${activeAngle + disabledAngle}deg,
        #dc3545 ${activeAngle + disabledAngle}deg ${activeAngle + disabledAngle + bannedAngle}deg,
        #6c757d ${activeAngle + disabledAngle + bannedAngle}deg
    )`;

    // 生成图例
    const legend = `
        <div class="pie-chart-legend">
            <div class="pie-legend-item">
                <div class="pie-legend-color" style="background: #28a745;"></div>
                <span>可用 (${statusCount.active})</span>
            </div>
            <div class="pie-legend-item">
                <div class="pie-legend-color" style="background: #ffc107;"></div>
                <span>已禁用 (${statusCount.disabled})</span>
            </div>
            <div class="pie-legend-item">
                <div class="pie-legend-color" style="background: #dc3545;"></div>
                <span>已封禁 (${statusCount.banned})</span>
            </div>
        </div>
    `;

    document.getElementById('statusChart').innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center;">
            <div class="simple-pie-chart" style="background: ${pieBackground};"></div>
            ${legend}
        </div>
    `;
}

/**
 * 渲染成功率排行榜
 */
function renderSuccessRateChart(keys) {
    // 只统计有使用记录的密钥
    const keysWithStats = keys.filter(key => (key.total_requests || key.usage_count || 0) > 0);

    if (keysWithStats.length === 0) {
        document.getElementById('successRateList').innerHTML = '<p style="color: #999;">暂无使用数据</p>';
        return;
    }

    // 计算成功率并排序
    const keysWithRate = keysWithStats.map(key => {
        const totalRequests = key.total_requests || key.usage_count || 0;
        const successRequests = key.success_requests || (totalRequests - (key.error_count || 0));
        const successRate = totalRequests > 0 ? (successRequests / totalRequests) : 0;

        return {
            ...key,
            successRate: successRate,
            successRateText: (successRate * 100).toFixed(1) + '%'
        };
    }).sort((a, b) => b.successRate - a.successRate).slice(0, 10); // 只显示前10名

    const successRateHtml = keysWithRate.map((key, index) => {
        const poolGroup = key.pool_group || 'default';
        const poolBadge = `<span class="pool-badge pool-badge-${poolGroup}">${poolGroup}</span>`;
        const rankColor = index < 3 ? ['#fbbf24', '#c0c0c0', '#cd7f32'][index] : '#6b7280';
        
        return `
        <div class="success-rate-item">
            <div class="success-rate-key" title="${key.key}">
                <span class="rank-badge" style="background: ${rankColor};">#${index + 1}</span>
                ${poolBadge}
                <span class="key-text">${key.key.substring(0, 18)}...</span>
            </div>
            <div class="success-rate-value">
                <div class="success-rate-bar">
                    <div class="success-rate-fill" style="width: ${key.successRate * 100}%"></div>
                </div>
                <div class="success-rate-text">${key.successRateText}</div>
            </div>
        </div>
    `}).join('');

    document.getElementById('successRateList').innerHTML = successRateHtml;
}

/**
 * 渲染使用热力图
 */
function renderUsageChart(keys) {
    // 统计使用次数
    const keysWithUsage = keys.filter(key => (key.usage_count || 0) > 0);

    if (keysWithUsage.length === 0) {
        document.getElementById('usageStats').innerHTML = '<p style="color: #999;">暂无使用数据</p>';
        return;
    }

    // 计算总使用次数
    const totalUsage = keysWithUsage.reduce((sum, key) => sum + (key.usage_count || 0), 0);

    // 按使用次数排序
    const sortedKeys = keysWithUsage.sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0)).slice(0, 8);

    const usageHtml = sortedKeys.map((key, index) => {
        const usage = key.usage_count || 0;
        const percentage = (usage / totalUsage * 100).toFixed(1);
        const poolGroup = key.pool_group || 'default';
        const poolBadge = `<span class="pool-badge pool-badge-${poolGroup}">${poolGroup}</span>`;
        const rankColor = index < 3 ? ['#fbbf24', '#c0c0c0', '#cd7f32'][index] : '#6b7280';

        return `
            <div class="usage-stat-item">
                <div class="usage-stat-key" title="${key.key}">
                    <span class="rank-badge" style="background: ${rankColor};">#${index + 1}</span>
                    ${poolBadge}
                    <span class="key-text">${key.key.substring(0, 18)}...</span>
                </div>
                <div class="usage-stat-bar-container">
                    <div class="usage-stat-bar" style="width: ${percentage}%">
                        <span class="usage-stat-count">${usage}</span>
                    </div>
                </div>
                <div class="usage-stat-percentage">${percentage}%</div>
            </div>
        `;
    }).join('');

    document.getElementById('usageStats').innerHTML = usageHtml;
}

/**
 * 渲染Token使用趋势图表（使用新的 /admin/token/trend 接口）
 */
async function renderTokenTrendChart(keys) {
    try {
        // 调用新的趋势API
        const response = await fetch('/admin/token/trend', {
            headers: {
                'x-admin-key': adminKey
            }
        });

        if (!response.ok) {
            throw new Error(`获取Token趋势失败: ${response.status}`);
        }

        const result = await response.json();
        if (!result.success || !result.data) {
            throw new Error('Token趋势数据格式错误');
        }

        const { top_keys, summary } = result.data;

        if (!top_keys || top_keys.length === 0) {
            document.getElementById('tokenTrendStats').innerHTML = '<p style="color: #999;">暂无Token使用数据，请点击刷新按钮加载</p>';
            return;
        }

        // 生成Token趋势HTML
        const trendHtml = top_keys.map((keyData, index) => {
            // 根据使用率设置颜色
            const percentage = parseFloat(keyData.percentage);
            let barColor = '#10b981'; // 绿色（低使用率）
            if (percentage > 80) {
                barColor = '#ef4444'; // 红色（高使用率）
            } else if (percentage > 60) {
                barColor = '#f59e0b'; // 橙色（中等使用率）
            } else if (percentage > 40) {
                barColor = '#fbbf24'; // 黄色（偏中等使用率）
            }

            // BaSui: 添加密钥池标签和排名徽章
            const poolGroup = keyData.pool_group || 'default';
            const poolBadge = `<span class="pool-badge pool-badge-${poolGroup}">${poolGroup}</span>`;
            const rankColor = index < 3 ? ['#fbbf24', '#c0c0c0', '#cd7f32'][index] : '#6b7280';

            return `
                <div class="token-trend-item">
                    <div class="token-trend-header">
                        <span class="rank-badge" style="background: ${rankColor};">#${index + 1}</span>
                        ${poolBadge}
                        <span class="token-trend-key" title="${keyData.key}">${keyData.key}</span>
                    </div>
                    <div class="token-trend-bar-container">
                        <div class="token-trend-bar" style="width: ${keyData.percentage}%; background: ${barColor};">
                            <span class="token-trend-count">${formatTokens(keyData.used)} / ${formatTokens(keyData.limit)}</span>
                        </div>
                    </div>
                    <div class="token-trend-percentage" style="color: ${barColor};">${keyData.percentage}%</div>
                </div>
            `;
        }).join('');

        document.getElementById('tokenTrendStats').innerHTML = trendHtml;

    } catch (error) {
        console.error('渲染Token趋势失败:', error);
        document.getElementById('tokenTrendStats').innerHTML = `<p style="color: #ef4444;">加载失败: ${error.message}</p>`;
    }
}

// ===================== Token使用量管理功能 =====================
let tokenUsageData = {};  // 存储Token使用量数据

// BaSui：用户手动刷新Token使用量统计
async function refreshTokenUsage() {
    try {
        await fetchTokenUsage();
        alert('✅ Token使用量统计已更新！');
    } catch (err) {
        console.error('刷新Token统计失败:', err);
        alert('❌ 刷新Token统计失败: ' + err.message);
    }
}

// 获取Token使用量统计
async function fetchTokenUsage() {
    try {
        const response = await fetch('/admin/token/usage', {
            headers: {
                'x-admin-key': adminKey  // BaSui：统一使用小写，和其他API保持一致
            }
        });

        if (!response.ok) {
            throw new Error(`获取Token使用量失败: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (data.success) {
            tokenUsageData = data.keys || {};
            updateTokenUsageDisplay();
        }
    } catch (err) {
        console.error('获取Token使用量失败:', err);
        // 不抛出错误，避免影响其他功能
    }
}

// 更新Token使用量显示
async function updateTokenUsageDisplay() {
    // BaSui: 从密钥池获取请求统计 + Factory API获取Token统计
    let totalTokens = 0;
    let totalRequests = 0;
    let todayTokens = 0;  // 暂时不支持今日统计
    let todayRequests = 0;

    try {
        // BaSui: 调用新的统计摘要API
        const response = await fetch('/admin/stats/summary', {
            headers: {
                'x-admin-key': adminKey
            }
        });

        if (!response.ok) {
            throw new Error(`获取统计数据失败: ${response.status}`);
        }

        const result = await response.json();
        if (result.success && result.data) {
            totalTokens = result.data.total_tokens || 0;
            totalRequests = result.data.total_requests || 0;
            todayTokens = result.data.today_tokens || 0;
            todayRequests = result.data.today_requests || 0;
        }
    } catch (err) {
        console.error('获取统计数据失败:', err);
        // 失败时显示为0
    }

    // 更新Token使用量卡片
    const tokenCard = document.getElementById('tokenUsageCard');
    if (tokenCard) {
        tokenCard.innerHTML = `
            <div class="stat-value">${formatTokenNumber(totalTokens)}</div>
            <div class="stat-label">总Token使用量</div>
            <div class="token-details">
                <div>总请求数: ${formatNumber(totalRequests)}</div>
                <div>今日使用: ${formatTokenNumber(todayTokens)} tokens</div>
                <div>今日请求: ${todayRequests} 次</div>
            </div>
        `;
    }

    // 更新顶部统计显示
    updateMainStats(totalTokens, totalRequests, todayTokens, todayRequests);
}

// 格式化Token数量显示
function formatTokenNumber(num) {
    if (num > 1000000) {
        return (num / 1000000).toFixed(2) + 'M';
    } else if (num > 1000) {
        return (num / 1000).toFixed(2) + 'K';
    }
    return num.toString();
}

// 更新主要统计信息
function updateMainStats(totalTokens, totalRequests, todayTokens, todayRequests) {
    // BaSui：直接更新HTML中已有的元素（美化版仪表盘）
    const tokenUsedEl = document.getElementById('statTokenUsed');
    const tokenTodayEl = document.getElementById('statTokenToday');
    const totalRequestsEl = document.getElementById('statTotalRequests');
    const todayRequestsEl = document.getElementById('statTodayRequests');
    
    if (tokenUsedEl) tokenUsedEl.textContent = formatTokenNumber(totalTokens);
    if (tokenTodayEl) tokenTodayEl.textContent = formatTokenNumber(todayTokens);
    if (totalRequestsEl) totalRequestsEl.textContent = formatNumber(totalRequests);
    if (todayRequestsEl) todayRequestsEl.textContent = todayRequests;
}

// BaSui：新增独立的仪表盘统计更新函数
async function updateDashboardStats() {
    try {
        // 并行请求Token和请求统计数据
        const response = await fetch('/admin/stats/summary', {
            headers: {
                'x-admin-key': adminKey
            }
        });

        if (!response.ok) {
            console.warn('获取统计数据失败:', response.status);
            return;
        }

        const result = await response.json();
        if (result.success && result.data) {
            const { total_tokens = 0, total_requests = 0, today_tokens = 0, today_requests = 0 } = result.data;
            updateMainStats(total_tokens, total_requests, today_tokens, today_requests);
        }
    } catch (err) {
        console.error('更新仪表盘统计失败:', err);
        // 失败时显示为0，避免影响用户体验
        updateMainStats(0, 0, 0, 0);
    }
}

// 获取所有密钥的余额（使用Factory专用API，带缓存）
async function fetchAllBalances(forceRefresh = false) {
    // TODO: Factory余额API尚未实现
    console.warn('余额查询功能暂时不可用 - Factory余额API尚未实现');
    balanceData = [];
    updateBalanceDisplay();
    return;

    /* 原始代码 - 等待后端实现后启用
    try {
        const url = forceRefresh
            ? '/factory/balance/all?forceRefresh=true'
            : '/factory/balance/all';

        const response = await fetch(url, {
            headers: {
                'X-Admin-Key': adminKey
            }
        });

        if (!response.ok) {
            throw new Error(`获取余额失败: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (data.success) {
            balanceData = data.results || [];
            updateBalanceDisplay();

            // 显示缓存状态
            if (data.fromCache) {
                console.log('使用缓存的余额数据，上次同步:', data.summary?.lastSync);
            } else {
                console.log('余额数据已刷新');
            }

            // 显示下次同步时间
            if (data.summary?.lastSync) {
                const nextSync = new Date(new Date(data.summary.lastSync).getTime() + 30 * 60 * 1000);
                console.log('下次自动同步时间:', nextSync.toLocaleString());
            }
        }
    } catch (err) {
        console.error('获取余额失败:', err);
    }
    */
}

// 获取单个密钥的余额
async function checkKeyBalance(keyId) {
    // TODO: 余额API尚未实现
    console.warn('单个密钥余额查询暂时不可用');
    return null;

    /* 原始代码 - 等待后端实现后启用
    try {
        // 使用Factory专用API，支持缓存
        const response = await fetch(`/factory/balance/check/${keyId}`, {
            headers: {
                'X-Admin-Key': adminKey
            }
        });

        if (!response.ok) {
            // 如果Factory API失败，尝试通用API
            const fallbackResponse = await fetch(`/admin/balance/check/${keyId}`, {
                headers: {
                    'X-Admin-Key': adminKey
                }
            });

            if (!fallbackResponse.ok) {
                throw new Error(`获取余额失败: ${fallbackResponse.status} ${fallbackResponse.statusText}`);
            }

            const data = await fallbackResponse.json();
            if (data.success) {
                updateSingleKeyBalance(keyId, data);
                alert(`余额查询成功！\n${formatBalanceInfo(data)}`);
            }
            return data;
        }

        const data = await response.json();
        if (data.success) {
            updateSingleKeyBalance(keyId, data);
            const cacheInfo = data.fromCache ? '（来自缓存）' : '（实时查询）';
            alert(`余额查询成功${cacheInfo}！\n${formatBalanceInfo(data)}`);
        }

        return data;
    } catch (err) {
        console.error(`获取密钥 ${keyId} 余额失败:`, err);
        alert('获取余额失败: ' + err.message);
    }
    */
}

// 更新单个密钥的余额信息
function updateSingleKeyBalance(keyId, data) {
    const index = balanceData.findIndex(b => b.id === keyId);
    if (index !== -1) {
        balanceData[index] = data;
    } else {
        balanceData.push(data);
    }
    updateBalanceDisplay();
}

// 格式化余额信息
function formatBalanceInfo(data) {
    if (!data.balance || !data.balance.success) {
        return '查询失败：' + (data.balance?.error || '未知错误');
    }

    const balance = data.balance;
    let info = `提供商: ${balance.provider}\n`;

    if (balance.provider === 'openai') {
        info += `可用余额: $${balance.balance?.total_available || 0}\n`;
        info += `本月使用: $${balance.usage?.current_month_usd || 0}`;
    } else if (balance.provider === 'anthropic') {
        info += balance.message || 'Anthropic暂不支持余额查询';
    } else if (balance.provider === 'glm') {
        info += `剩余余额: ¥${balance.balance?.remaining_balance || 0}`;
    } else if (balance.provider === 'factory') {
        if (balance.balance) {
            if (balance.balance.remaining_credits !== undefined) {
                info += `剩余额度: ${balance.balance.remaining_credits} credits\n`;
                info += `已使用: ${balance.balance.used_credits || 0} credits\n`;
                info += `总额度: ${balance.balance.total_credits || 0} credits`;
            } else if (balance.balance.total_balance !== undefined) {
                info += `总余额: $${balance.balance.total_balance}\n`;
                info += `货币: ${balance.balance.currency || 'USD'}`;
            } else {
                info += balance.message || '请登录Factory控制台查看余额';
            }
        }
        if (balance.tokens) {
            info += `\n\n令牌使用:\n`;
            info += `已使用: ${balance.tokens.used || 0}\n`;
            info += `限制: ${balance.tokens.limit || 0}\n`;
            info += `剩余: ${balance.tokens.remaining || 0}`;
        }
    }

    return info;
}

// 批量查询余额（支持强制刷新）
async function checkAllBalances(forceRefresh = false) {
    const message = forceRefresh
        ? '强制刷新将重新查询所有密钥余额，可能需要较长时间，是否继续？'
        : '将使用缓存数据快速加载余额信息，是否继续？';

    if (!confirm(message)) {
        return;
    }

    // 显示加载提示
    const btn = event.target;
    const originalText = btn.textContent;
    btn.textContent = forceRefresh ? '🔄 刷新中...' : '📊 加载中...';
    btn.disabled = true;

    try {
        await fetchAllBalances(forceRefresh);

        // TODO: 后台同步功能待实现
        // 如果是强制刷新，触发后台同步
        /*
        if (forceRefresh) {
            fetch('/factory/balance/sync', {
                method: 'POST',
                headers: {
                    'X-Admin-Key': adminKey
                }
            }).then(() => {
                console.log('后台同步已触发');
            });
        }
        */

        // alert('余额查询完成！数据每30分钟自动更新一次。');
        alert('余额查询功能暂时不可用');
    } catch (err) {
        alert('批量查询失败: ' + err.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

// ===================== Factory Token余额管理功能 (BaSui新增) =====================

// 全局余额数据存储 - 初始化完整结构避免"余额数据不完整"警告
let factoryBalanceData = {
    keys: {},     // 密钥余额数据
    summary: {}   // 汇总信息
};
let countdownInterval = null;

// 格式化Token数量 (20M/38M显示)
function formatTokens(tokens) {
    if (!tokens && tokens !== 0) return '-';
    if (tokens >= 1000000) {
        return `${(tokens / 1000000).toFixed(1)}M`;
    } else if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`;
    }
    return tokens.toString();
}

// 格式化数字 (带千分位)
function formatNumber(num) {
    if (!num && num !== 0) return '-';
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 刷新余额数据 (调用/admin/token/usage API)
async function refreshBalanceData(forceRefresh = false) {
    try {
        const url = forceRefresh 
            ? '/admin/token/usage?forceRefresh=true' 
            : '/admin/token/usage';
        
        const response = await fetch(url, {
            headers: {
                'x-admin-key': adminKey
            }
        });

        if (!response.ok) {
            throw new Error(`获取余额数据失败: ${response.status}`);
        }

        const result = await response.json();
        if (result.success) {
            // BaSui: 确保数据结构完整
            factoryBalanceData = {
                success: true,
                keys: result.keys || result.data?.keys || {},
                summary: result.summary || result.data?.summary || {}
            };
            updateBalanceDisplay();
            startCountdownTimer();

            // 显示余额概览区域
            document.getElementById('balanceOverview').style.display = 'block';
        }
    } catch (err) {
        console.error('刷新余额数据失败:', err);
        // 静默失败,不影响其他功能
    }
}

// 更新余额显示
function updateBalanceDisplay() {
    // 确保数据结构完整
    const keys = factoryBalanceData.keys || {};
    const summary = factoryBalanceData.summary || {};

    // 如果没有任何密钥数据，静默返回（避免初始加载时的警告）
    if (Object.keys(keys).length === 0) {
        console.debug('余额数据尚未加载');
        return;
    }

    // 计算总余额
    let totalRemaining = 0;
    let totalUsed = 0;
    let totalLimit = 0;
    let earliestExpiry = null;

    Object.values(keys).forEach(keyData => {
        // BaSui修复：兼容性判断，只要有standard字段就处理
        if (keyData.standard) {
            // 只统计成功的数据（success不为false）
            if (keyData.success !== false) {
                totalRemaining += keyData.standard.remaining || 0;
                totalUsed += keyData.standard.orgTotalTokensUsed || 0;
                totalLimit += keyData.standard.totalAllowance || 0;
            }

            // 找到最早过期时间
            if (keyData.trialEndDate) {
                const expiryTime = new Date(keyData.trialEndDate).getTime();
                if (!earliestExpiry || expiryTime < earliestExpiry.time) {
                    earliestExpiry = {
                        time: expiryTime,
                        date: keyData.trialEndDate
                    };
                }
            }
        }
    });

    // 更新统计卡片
    document.getElementById('totalRemainingBalance').textContent = formatTokens(totalRemaining);
    document.getElementById('totalUsedBalance').textContent = formatTokens(totalUsed);
    document.getElementById('totalAllowanceBalance').textContent = formatTokens(totalLimit);

    // 更新过期倒计时
    updateExpiryCountdown(earliestExpiry);
}

// 更新过期倒计时显示
function updateExpiryCountdown(earliestExpiry) {
    const countdownEl = document.getElementById('expiryCountdown');
    const hintEl = document.getElementById('expiryHint');
    const cardEl = document.getElementById('expiryCard');
    const warningEl = document.getElementById('expiryWarning');
    const warningTextEl = document.getElementById('expiryWarningText');

    if (!earliestExpiry) {
        countdownEl.textContent = '无过期';
        hintEl.textContent = '所有密钥永久有效';
        cardEl.className = 'balance-stat-card balance-expiry expiry-safe';
        warningEl.style.display = 'none';
        return;
    }

    const now = Date.now();
    const expiryTime = earliestExpiry.time;
    const diffMs = expiryTime - now;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    // 格式化倒计时显示
    if (diffMs < 0) {
        countdownEl.textContent = '已过期';
        hintEl.textContent = '密钥已失效';
        cardEl.className = 'balance-stat-card balance-expiry expiry-critical';
        
        warningEl.style.display = 'flex';
        warningEl.className = 'expiry-warning critical';
        warningTextEl.textContent = '有密钥已过期!请及时更新!';
    } else if (diffDays < 3) {
        // 3天内过期 - 危急
        countdownEl.textContent = diffDays === 0 
            ? `${diffHours}小时${diffMinutes}分` 
            : `${diffDays}天${diffHours}小时`;
        hintEl.textContent = `${new Date(expiryTime).toLocaleDateString()} 过期`;
        cardEl.className = 'balance-stat-card balance-expiry expiry-critical';
        
        warningEl.style.display = 'flex';
        warningEl.className = 'expiry-warning critical';
        warningTextEl.textContent = `警告!最早将在${diffDays}天${diffHours}小时后过期!`;
    } else if (diffDays < 7) {
        // 7天内过期 - 警告
        countdownEl.textContent = `${diffDays}天${diffHours}小时`;
        hintEl.textContent = `${new Date(expiryTime).toLocaleDateString()} 过期`;
        cardEl.className = 'balance-stat-card balance-expiry expiry-warning';
        
        warningEl.style.display = 'flex';
        warningEl.className = 'expiry-warning';
        warningTextEl.textContent = `注意!最早将在${diffDays}天后过期,请提前准备!`;
    } else {
        // 7天以上 - 安全
        countdownEl.textContent = `${diffDays}天`;
        hintEl.textContent = `${new Date(expiryTime).toLocaleDateString()} 过期`;
        cardEl.className = 'balance-stat-card balance-expiry expiry-safe';
        
        warningEl.style.display = 'none';
    }
}

// 启动倒计时定时器 (每分钟更新一次)
function startCountdownTimer() {
    // 清除旧定时器
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }

    // 启动新定时器
    countdownInterval = setInterval(() => {
        const { keys } = factoryBalanceData;
        if (!keys) return;

        // 重新计算最早过期时间
        let earliestExpiry = null;
        Object.values(keys).forEach(keyData => {
            if (keyData.success && keyData.trialEndDate) {
                const expiryTime = new Date(keyData.trialEndDate).getTime();
                if (!earliestExpiry || expiryTime < earliestExpiry.time) {
                    earliestExpiry = {
                        time: expiryTime,
                        date: keyData.trialEndDate
                    };
                }
            }
        });

        updateExpiryCountdown(earliestExpiry);
    }, 60000); // 每分钟更新一次
}

// 页面加载时自动刷新余额数据 (在refreshData中调用)
async function refreshData(includeTokenUsage = false) {
    try {
        await fetchStats();
        await fetchKeys();
        
        // 刷新Factory余额数据
        await refreshBalanceData(false);
        
        // Token使用量统计改为可选
        if (includeTokenUsage) {
            try {
                await fetchTokenUsage();
            } catch (err) {
                console.error('获取Token使用量失败:', err);
            }
        }
    } catch (err) {
        alert('刷新失败: ' + err.message);
    }
}

// 页面卸载时清理定时器
window.addEventListener('beforeunload', () => {
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }
});

console.log('Factory余额管理功能已加载 - BaSui');

// ===================== 7天使用趋势图表功能 (BaSui新增) =====================

/**
 * 获取并渲染7天使用趋势折线图
 */
async function render7DaysTrendChart() {
    try {
        const response = await fetch('/admin/stats/trend?days=7', {
            headers: {
                'x-admin-key': adminKey
            }
        });

        if (!response.ok) {
            throw new Error(`获取趋势数据失败: ${response.status}`);
        }

        const result = await response.json();
        if (!result.success || !result.data) {
            throw new Error('趋势数据格式错误');
        }

        const trendData = result.data;

        // 获取Canvas元素
        const canvas = document.getElementById('tokenTrendCanvas');
        if (!canvas) {
            console.warn('Canvas元素不存在');
            return;
        }

        const ctx = canvas.getContext('2d');

        // 清除之前的内容
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 设置画布大小和边距
        const width = canvas.width;
        const height = canvas.height;
        const padding = { top: 20, right: 30, bottom: 40, left: 60 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;

        // 提取数据
        const dates = trendData.map(d => d.date_formatted);
        const tokens = trendData.map(d => d.tokens);
        const requests = trendData.map(d => d.requests);

        // 计算最大值
        const maxTokens = Math.max(...tokens, 100);  // 至少100
        const maxRequests = Math.max(...requests, 10);  // 至少10

        // 绘制背景网格
        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 5; i++) {
            const y = padding.top + (chartHeight / 5) * i;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(padding.left + chartWidth, y);
            ctx.stroke();
        }

        // 绘制Y轴标签（Token数量）
        ctx.fillStyle = '#6b7280';
        ctx.font = '12px Arial';
        ctx.textAlign = 'right';
        for (let i = 0; i <= 5; i++) {
            const value = Math.round((maxTokens / 5) * (5 - i));
            const y = padding.top + (chartHeight / 5) * i;
            ctx.fillText(formatTokenNumber(value), padding.left - 10, y + 4);
        }

        // 绘制X轴标签（日期）
        ctx.textAlign = 'center';
        dates.forEach((date, index) => {
            const x = padding.left + (chartWidth / (dates.length - 1)) * index;
            ctx.fillText(date, x, height - padding.bottom + 20);
        });

        // 绘制Token趋势线（蓝色）
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.beginPath();
        tokens.forEach((token, index) => {
            const x = padding.left + (chartWidth / (tokens.length - 1)) * index;
            const y = padding.top + chartHeight - (token / maxTokens) * chartHeight;
            if (index === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });
        ctx.stroke();

        // 绘制Token数据点
        ctx.fillStyle = '#3b82f6';
        tokens.forEach((token, index) => {
            const x = padding.left + (chartWidth / (tokens.length - 1)) * index;
            const y = padding.top + chartHeight - (token / maxTokens) * chartHeight;
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, 2 * Math.PI);
            ctx.fill();
        });

        // 绘制图例
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(padding.left, 5, 15, 3);
        ctx.fillStyle = '#6b7280';
        ctx.font = '12px Arial';
        ctx.textAlign = 'left';
        ctx.fillText('Token使用量', padding.left + 20, 10);

        console.log('✅ 7天使用趋势图表渲染成功');
    } catch (error) {
        console.error('渲染7天使用趋势失败:', error);
        const canvas = document.getElementById('tokenTrendCanvas');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#ef4444';
            ctx.font = '14px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('加载失败', canvas.width / 2, canvas.height / 2);
        }
    }
}

// ===================== Tab标签页切换功能 (BaSui新增) =====================

/**
 * 切换Tab页面
 * @param {string} tabName - Tab名称 (dashboard/keys/config)
 */
function switchTab(tabName) {
    // 隐藏所有Tab内容
    const allTabs = document.querySelectorAll('.tab-content');
    allTabs.forEach(tab => tab.classList.remove('active'));

    // 移除所有Tab按钮的active状态
    const allButtons = document.querySelectorAll('.tab-button');
    allButtons.forEach(btn => btn.classList.remove('active'));

    // 显示目标Tab
    const targetTab = document.getElementById(`tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
    if (targetTab) {
        targetTab.classList.add('active');
    }

    // 激活对应的Tab按钮
    const targetButton = event?.target || document.querySelector(`.tab-button[onclick*="${tabName}"]`);
    if (targetButton) {
        targetButton.classList.add('active');
    }

    // 根据Tab类型加载数据
    if (tabName === 'dashboard') {
        // Dashboard加载所有数据
        refreshData(true);  // BaSui: 传递true以包含Token使用量数据
        // BaSui: 渲染7天使用趋势图
        render7DaysTrendChart();
    } else if (tabName === 'keys') {
        // 密钥管理页只加载密钥列表
        fetchKeys();
    } else if (tabName === 'config') {
        // 配置页面加载配置数据
        loadConfigData();
    }
}

// 保存原始配置用于检测变化
let originalPort = 3000;
let originalRedisEnabled = false;
let originalClusterEnabled = false;

/**
 * 加载配置数据到配置页面表单
 */
async function loadConfigData() {
    try {
        const response = await apiRequest('/config');
        const config = response.data;

        // 保存原始配置
        originalPort = config.port || 3000;
        originalRedisEnabled = config.redis?.enabled || false;
        originalClusterEnabled = config.cluster?.enabled || false;

        // 基础配置
        document.getElementById('configPort').value = config.port || 3000;
        document.getElementById('configUserAgent').value = config.user_agent || 'factory-cli/0.19.3';
        document.getElementById('configDevMode').checked = config.dev_mode || false;
        document.getElementById('configSystemPrompt').value = config.system_prompt || '';

        // 限制配置
        document.getElementById('configNotesMaxLength').value = config.limits?.notes_max_length || 1000;
        document.getElementById('configMaxJsonLogSize').value = config.limits?.max_json_log_size || 5000;

        // 推理Token配置
        document.getElementById('configReasoningLow').value = config.reasoning_tokens?.low || 4096;
        document.getElementById('configReasoningMedium').value = config.reasoning_tokens?.medium || 12288;
        document.getElementById('configReasoningHigh').value = config.reasoning_tokens?.high || 24576;

        // 余额同步配置
        document.getElementById('configSyncInterval').value = config.balance_sync?.sync_interval_minutes || 30;
        document.getElementById('configSaveInterval').value = config.balance_sync?.save_interval_minutes || 5;

        // 密钥池配置
        const keyPool = config.key_pool || {};
        document.getElementById('configAlgorithm').value = keyPool.algorithm || 'round-robin';

        document.getElementById('configRetryEnabled').checked = keyPool.retry?.enabled ?? true;
        document.getElementById('configRetryMaxRetries').value = keyPool.retry?.maxRetries || 3;
        document.getElementById('configRetryDelay').value = keyPool.retry?.retryDelay || 1000;

        document.getElementById('configAutoBanEnabled').checked = keyPool.autoBan?.enabled ?? true;
        document.getElementById('configAutoBanThreshold').value = keyPool.autoBan?.errorThreshold || 5;
        document.getElementById('configAutoBan402').checked = keyPool.autoBan?.ban402 ?? true;
        document.getElementById('configAutoBan401').checked = keyPool.autoBan?.ban401 ?? false;

        document.getElementById('configConcurrentLimit').value = keyPool.performance?.concurrentLimit || 100;
        document.getElementById('configRequestTimeout').value = keyPool.performance?.requestTimeout || 10000;

        document.getElementById('configMultiTierEnabled').checked = keyPool.multiTier?.enabled || false;
        document.getElementById('configMultiTierAutoFallback').checked = keyPool.multiTier?.autoFallback ?? true;

        // Redis 配置
        const redis = config.redis || {};
        document.getElementById('configRedisEnabled').checked = redis.enabled || false;
        document.getElementById('configRedisHost').value = redis.host || '127.0.0.1';
        document.getElementById('configRedisPort').value = redis.port || 6379;
        document.getElementById('configRedisPassword').value = redis.password || '';
        document.getElementById('configRedisDb').value = redis.db || 0;
        document.getElementById('configRedisKeyPrefix').value = redis.key_prefix || 'droid2api:';

        // 集群配置
        const cluster = config.cluster || {};
        document.getElementById('configClusterEnabled').checked = cluster.enabled || false;
        document.getElementById('configClusterWorkers').value = cluster.workers || 0;
    } catch (err) {
        console.error('加载配置失败:', err);
        alert('❌ 加载配置失败\n\n' + err.message);
    }
}

// BaSui: 修改authenticate函数，登录成功后显示退出登录按钮
const originalAuthenticate = authenticate;
authenticate = function() {
    const key = document.getElementById('adminKeyInput').value.trim();
    if (!key) {
        alert('请输入管理员密钥');
        return;
    }

    adminKey = key;

    fetchStats()
        .then(() => {
            localStorage.setItem(STORAGE_KEY_ADMIN, key);
            localStorage.setItem(STORAGE_KEY_LOGIN_TIME, Date.now().toString());

            document.getElementById('authSection').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            document.getElementById('logoutBtn').style.display = 'block';  // BaSui: 显示退出登录按钮
            
            // BaSui: 默认显示Dashboard，并加载Token使用量数据
            switchTab('dashboard');
        })
        .catch(err => {
            alert('认证失败: ' + err.message);
            adminKey = '';
        });
};

// BaSui: 修改logout函数，隐藏退出登录按钮
const originalLogout = logout;
logout = function() {
    if (!confirm('确认退出登录？')) return;

    localStorage.removeItem(STORAGE_KEY_ADMIN);
    localStorage.removeItem(STORAGE_KEY_LOGIN_TIME);
    adminKey = '';

    document.getElementById('authSection').style.display = 'flex';
    document.getElementById('mainContent').style.display = 'none';
    document.getElementById('logoutBtn').style.display = 'none';  // BaSui: 隐藏退出登录按钮

    document.getElementById('adminKeyInput').value = '';
};

// BaSui: 修改autoAuthenticate，成功后显示退出登录按钮
const originalAutoAuthenticate = autoAuthenticate;
autoAuthenticate = function() {
    const savedKey = localStorage.getItem(STORAGE_KEY_ADMIN);

    if (!savedKey) {
        return;
    }

    if (isLoginExpired()) {
        console.log('登录已过期，清除登录信息');
        clearExpiredLogin();
        alert(`登录已过期（超过${LOGIN_EXPIRE_HOURS}小时），请重新输入管理员密钥`);
        return;
    }

    adminKey = savedKey;

    fetchStats()
        .then(() => {
            document.getElementById('authSection').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            document.getElementById('logoutBtn').style.display = 'block';  // BaSui: 显示退出登录按钮
            
            // BaSui: 默认显示Dashboard，并加载Token使用量数据
            refreshData(true);  // BaSui: 传递true确保初始加载时显示Token和余额数据
        })
        .catch(err => {
            console.error('自动认证失败:', err);
            clearExpiredLogin();
            alert('登录已过期，请重新输入管理员密钥');
        });
};

console.log('Tab标签页切换功能已加载 - BaSui');

// ===================== 实时日志功能 (BaSui新增) =====================

// 全局日志变量
let logEventSource = null;  // SSE连接
let logEntries = [];         // 日志条目数组
let logStats = {             // 日志统计
    total: 0,
    info: 0,
    warn: 0,
    error: 0,
    debug: 0
};

/**
 * 启动/停止实时日志流
 */
function toggleLogStream() {
    if (logEventSource) {
        // 停止日志流
        logEventSource.close();
        logEventSource = null;
        updateLogStreamStatus(false);
    } else {
        // 启动日志流
        startLogStream();
    }
}

/**
 * 启动SSE日志流
 */
function startLogStream() {
    try {
        // 获取筛选参数
        const levels = getSelectedLogLevels();
        const keyword = document.getElementById('logSearchKeyword').value.trim();

        // 构造SSE URL
        let url = `/admin/logs/stream?`;
        if (levels.length > 0 && levels.length < 4) {
            url += `level=${levels.join(',')}&`;
        }
        if (keyword) {
            url += `keyword=${encodeURIComponent(keyword)}&`;
        }

        // 创建SSE连接
        logEventSource = new EventSource(url);

        // 监听消息事件
        logEventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                // 处理历史日志
                if (data.type === 'history') {
                    data.logs.forEach(log => addLogEntry(log, false));
                    scrollToBottomIfNeeded();
                } else {
                    // 实时日志
                    addLogEntry(data, true);
                }
            } catch (error) {
                console.error('解析SSE消息失败:', error);
            }
        };

        // 监听连接打开
        logEventSource.onopen = () => {
            console.log('SSE日志流已连接');
            updateLogStreamStatus(true);
        };

        // 监听错误
        logEventSource.onerror = (error) => {
            console.error('SSE日志流错误:', error);
            logEventSource.close();
            logEventSource = null;
            updateLogStreamStatus(false);
            alert('日志流连接失败，请检查网络连接或刷新页面重试');
        };

    } catch (error) {
        console.error('启动日志流失败:', error);
        alert('启动日志流失败: ' + error.message);
    }
}

/**
 * 更新日志流状态显示
 */
function updateLogStreamStatus(connected) {
    const statusBadge = document.getElementById('logStreamStatus');
    const toggleBtn = document.getElementById('logStreamToggle');

    if (connected) {
        statusBadge.textContent = '已连接';
        statusBadge.className = 'log-status-badge connected';
        toggleBtn.textContent = '⏸️ 停止日志';
        toggleBtn.className = 'btn btn-danger';
    } else {
        statusBadge.textContent = '已断开';
        statusBadge.className = 'log-status-badge disconnected';
        toggleBtn.textContent = '▶️ 启动实时日志';
        toggleBtn.className = 'btn btn-primary';
    }
}

/**
 * 添加日志条目
 */
function addLogEntry(logEntry, scroll = true) {
    logEntries.push(logEntry);

    // 更新统计
    logStats.total++;
    logStats[logEntry.level] = (logStats[logEntry.level] || 0) + 1;
    updateLogStatsDisplay();

    // 渲染日志
    renderLogEntry(logEntry);

    // 自动滚动
    if (scroll) {
        scrollToBottomIfNeeded();
    }
}

/**
 * 渲染单条日志
 */
function renderLogEntry(logEntry) {
    const logList = document.getElementById('logList');

    // 移除空提示
    const emptyMsg = logList.querySelector('.log-empty');
    if (emptyMsg) {
        emptyMsg.remove();
    }

    // 创建日志条目DOM
    const logDiv = document.createElement('div');
    logDiv.className = `log-entry log-level-${logEntry.level}`;
    logDiv.dataset.level = logEntry.level;
    logDiv.dataset.timestamp = logEntry.timestamp;

    // 日志头部
    const header = document.createElement('div');
    header.className = 'log-entry-header';

    // 时间戳
    const timestamp = document.createElement('span');
    timestamp.className = 'log-timestamp';
    timestamp.textContent = formatLogTimestamp(logEntry.timestamp);
    header.appendChild(timestamp);

    // 级别标签
    const levelBadge = document.createElement('span');
    levelBadge.className = `log-level-badge ${logEntry.level}`;
    levelBadge.textContent = getLevelText(logEntry.level).toUpperCase();
    header.appendChild(levelBadge);

    // 类型标签
    if (logEntry.type) {
        const typeBadge = document.createElement('span');
        typeBadge.className = 'log-type-badge';
        typeBadge.textContent = logEntry.type.toUpperCase();
        header.appendChild(typeBadge);
    }

    // HTTP方法标签
    if (logEntry.method) {
        const methodBadge = document.createElement('span');
        methodBadge.className = `log-method-badge ${logEntry.method}`;
        methodBadge.textContent = logEntry.method;
        header.appendChild(methodBadge);
    }

    // 状态码标签
    if (logEntry.statusCode) {
        const statusBadge = document.createElement('span');
        const statusClass = getStatusClass(logEntry.statusCode);
        statusBadge.className = `log-status-badge ${statusClass}`;
        statusBadge.textContent = logEntry.statusCode;
        header.appendChild(statusBadge);
    }

    // 响应时间标签
    if (logEntry.duration) {
        const durationSpan = document.createElement('span');
        durationSpan.className = 'log-timestamp';
        durationSpan.textContent = `[${logEntry.duration}]`;
        header.appendChild(durationSpan);
    }

    logDiv.appendChild(header);

    // 日志内容
    const content = document.createElement('div');
    content.className = 'log-entry-content';

    if (logEntry.url) {
        content.innerHTML += `<span class="log-url">${escapeHtml(logEntry.url)}</span><br>`;
    }

    if (logEntry.message) {
        content.innerHTML += `<span class="log-message">${escapeHtml(logEntry.message)}</span><br>`;
    }

    if (logEntry.body && logEntry.body !== 'null' && logEntry.body !== 'undefined') {
        const dataDiv = document.createElement('div');
        dataDiv.className = 'log-data';
        dataDiv.textContent = logEntry.body;
        content.appendChild(dataDiv);
    }

    if (logEntry.error) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'log-data';
        errorDiv.innerHTML = `<strong>Error:</strong> ${escapeHtml(logEntry.error.message)}<br>${escapeHtml(logEntry.error.stack || '')}`;
        content.appendChild(errorDiv);
    }

    logDiv.appendChild(content);

    // 添加到DOM
    logList.appendChild(logDiv);

    // 优化：减少最大日志条数，及时清理DOM和内存
    const maxLogs = 100;  // 从500减少到100
    if (logList.children.length > maxLogs) {
        // 批量删除旧日志，减少DOM操作
        const removeCount = logList.children.length - maxLogs + 10; // 多删除10条
        for (let i = 0; i < removeCount; i++) {
            const firstChild = logList.firstChild;
            if (firstChild) {
                logList.removeChild(firstChild);
            }
        }
    }
}

/**
 * 更新日志统计显示
 */
function updateLogStatsDisplay() {
    document.getElementById('logStatTotal').textContent = logStats.total;
    document.getElementById('logStatInfo').textContent = logStats.info || 0;
    document.getElementById('logStatWarn').textContent = logStats.warn || 0;
    document.getElementById('logStatError').textContent = logStats.error || 0;
}

/**
 * 清空日志显示
 */
function clearLogDisplay() {
    if (!confirm('确认清空所有日志显示？')) return;

    logEntries = [];
    logStats = { total: 0, info: 0, warn: 0, error: 0, debug: 0 };

    const logList = document.getElementById('logList');
    logList.innerHTML = '<div class="log-empty">日志已清空</div>';

    updateLogStatsDisplay();
}

/**
 * 导出日志为文件
 */
function exportLogs() {
    if (logEntries.length === 0) {
        alert('没有日志可导出');
        return;
    }

    try {
        // 生成日志文本
        let logText = `# droid2api 实时日志导出\n`;
        logText += `# 导出时间: ${new Date().toLocaleString('zh-CN')}\n`;
        logText += `# 总条数: ${logEntries.length}\n\n`;

        logEntries.forEach(log => {
            logText += `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.type || 'MESSAGE'}]`;
            if (log.method) logText += ` ${log.method}`;
            if (log.url) logText += ` ${log.url}`;
            if (log.statusCode) logText += ` ${log.statusCode}`;
            if (log.duration) logText += ` ${log.duration}`;
            logText += `\n`;

            if (log.message) logText += `  ${log.message}\n`;
            if (log.body) logText += `  ${log.body}\n`;
            if (log.error) logText += `  Error: ${log.error.message}\n`;
            logText += `\n`;
        });

        // 创建下载
        const blob = new Blob([logText], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `droid2api_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        a.click();
        URL.revokeObjectURL(url);

        alert(`✅ 已导出 ${logEntries.length} 条日志`);
    } catch (error) {
        console.error('导出日志失败:', error);
        alert('导出日志失败: ' + error.message);
    }
}

/**
 * 应用日志筛选
 */
function applyLogFilters() {
    const levels = getSelectedLogLevels();
    const keyword = document.getElementById('logSearchKeyword').value.trim().toLowerCase();

    const logList = document.getElementById('logList');
    const logDivs = logList.querySelectorAll('.log-entry');

    logDivs.forEach(logDiv => {
        const level = logDiv.dataset.level;
        const text = logDiv.textContent.toLowerCase();

        // 级别筛选
        const levelMatch = levels.length === 0 || levels.includes(level);

        // 关键词筛选
        const keywordMatch = !keyword || text.includes(keyword);

        // 显示/隐藏
        logDiv.style.display = (levelMatch && keywordMatch) ? 'block' : 'none';
    });
}

/**
 * 获取选中的日志级别
 */
function getSelectedLogLevels() {
    const levels = [];
    if (document.getElementById('filterInfo').checked) levels.push('info');
    if (document.getElementById('filterWarn').checked) levels.push('warn');
    if (document.getElementById('filterError').checked) levels.push('error');
    if (document.getElementById('filterDebug').checked) levels.push('debug');
    return levels;
}

/**
 * 自动滚动到底部（如果开启）
 */
function scrollToBottomIfNeeded() {
    if (document.getElementById('logAutoScroll').checked) {
        const logContainer = document.querySelector('.log-display-container');
        logContainer.scrollTop = logContainer.scrollHeight;
    }
}

/**
 * 格式化日志时间戳
 */
function formatLogTimestamp(timestamp) {
    const date = new Date(timestamp);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${ms}`;
}

/**
 * 获取级别文本
 */
function getLevelText(level) {
    const map = {
        'info': 'info',
        'warn': 'warn',
        'error': 'error',
        'debug': 'debug'
    };
    return map[level] || level;
}

/**
 * 获取状态码样式类
 */
function getStatusClass(statusCode) {
    if (statusCode >= 500) return 'status-5xx';
    if (statusCode >= 400) return 'status-4xx';
    if (statusCode >= 300) return 'status-3xx';
    if (statusCode >= 200) return 'status-2xx';
    return '';
}

// 页面卸载时关闭SSE连接
window.addEventListener('beforeunload', () => {
    if (logEventSource) {
        logEventSource.close();
    }
});

console.log('✅ 实时日志功能已加载 - BaSui');

// ============================================
// BaSui：修改密钥池功能（快速修改单个密钥的池）
// ============================================
// 🆕 注意：此功能已移至 pool-groups.js 实现，避免重复声明！
// - let currentChangePoolKeyId (已在 pool-groups.js:5 声明)
// - function showChangePoolModal (已在 pool-groups.js:273 实现)
// - async function changeKeyPool (已在 pool-groups.js:283 实现)

