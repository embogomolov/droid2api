// Global variables
let adminKey = '';
let currentPage = 1;
let currentStatus = 'all';
let currentPoolGroup = 'all';  // Currently selected key pool
let currentPageSize = 10;  // Rows per page
let currentEditKeyId = null;
// BaSui: State for the bulk action dialog
let batchModalKeyIds = new Set();
let batchModalAllKeys = [];
let batchModalFilterStatus = 'all';
let batchModalFilterPool = 'all';

// BaSui: localStorage key names
const STORAGE_KEY_ADMIN = 'droid2api_admin_key';
const STORAGE_KEY_LOGIN_TIME = 'droid2api_login_time';
const LOGIN_EXPIRE_HOURS = 1; // Session expires after one hour

// BaSui: Human-readable explanations of HTTP status codes
const HTTP_STATUS_MAP = {
    200: 'Request successful',
    201: 'Created successfully',
    400: 'Invalid request parameters',
    401: 'Authentication failed - invalid key',
    402: 'Insufficient balance - no quota remaining',
    403: 'Insufficient permissions - access forbidden',
    404: 'Resource not found',
    429: 'Too many requests - rate limit reached',
    500: 'Internal server error',
    502: 'Bad gateway',
    503: 'Service unavailable',
    504: 'Gateway timeout',
    0: 'Network error or request timeout'
};

// BaSui: Get the explanation for an HTTP status code
function getStatusMessage(statusCode) {
    return HTTP_STATUS_MAP[statusCode] || `Unknown error (${statusCode})`;
}

// Authentication
function authenticate() {
    const key = document.getElementById('adminKeyInput').value.trim();
    if (!key) {
        alert('Enter your admin access key');
        return;
    }

    adminKey = key;

    // Verify authentication
    fetchStats()
        .then(() => {
            // BaSui: Save the key and login time to localStorage after authentication
            localStorage.setItem(STORAGE_KEY_ADMIN, key);
            localStorage.setItem(STORAGE_KEY_LOGIN_TIME, Date.now().toString());

            document.getElementById('authSection').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            refreshData(true);  // BaSui: Pass true to load token usage and balances initially
        })
        .catch(err => {
            alert('Authentication failed: ' + err.message);
            adminKey = '';
        });
}

// BaSui: Sign out
function logout() {
    if (!confirm('Sign out?')) return;

    // Clear the key and login time from localStorage and memory
    localStorage.removeItem(STORAGE_KEY_ADMIN);
    localStorage.removeItem(STORAGE_KEY_LOGIN_TIME);
    adminKey = '';

    // Switch the visible section
    document.getElementById('authSection').style.display = 'flex';
    document.getElementById('mainContent').style.display = 'none';

    // Clear the password field
    document.getElementById('adminKeyInput').value = '';
}

// BaSui: Check whether the login has expired
function isLoginExpired() {
    const loginTime = localStorage.getItem(STORAGE_KEY_LOGIN_TIME);
    if (!loginTime) return true; // Treat a missing login time as an expired session

    const loginTimestamp = parseInt(loginTime);
    const now = Date.now();
    const expireTime = LOGIN_EXPIRE_HOURS * 60 * 60 * 1000; // Convert to milliseconds

    return (now - loginTimestamp) > expireTime;
}

// BaSui: Clear expired login credentials
function clearExpiredLogin() {
    localStorage.removeItem(STORAGE_KEY_ADMIN);
    localStorage.removeItem(STORAGE_KEY_LOGIN_TIME);
    adminKey = '';
}

// BaSui: Authenticate automatically on page load
function autoAuthenticate() {
    const savedKey = localStorage.getItem(STORAGE_KEY_ADMIN);

    if (!savedKey) {
        // No saved key; leave the login screen visible
        return;
    }

    // BaSui: Check whether the login has expired
    if (isLoginExpired()) {
        console.log('Session expired; clearing saved credentials');
        clearExpiredLogin();
        alert(`Your session expired after ${LOGIN_EXPIRE_HOURS} hour(s). Enter your admin access key again.`);
        return;
    }

    adminKey = savedKey;

    // Verify the saved key
    fetchStats()
        .then(() => {
            // Valid key; open the main interface
            document.getElementById('authSection').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            refreshData(true);  // BaSui: Pass true to load token usage and balances initially
        })
        .catch(err => {
            // Invalid key; clear the saved key and show the login screen
            console.error('Automatic authentication failed:', err);
            clearExpiredLogin();
            alert('Your session has expired. Enter your admin access key again.');
        });
}

// BaSui: Authenticate automatically when the page loads
window.addEventListener('DOMContentLoaded', autoAuthenticate);

// API request wrapper
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

// Fetch statistics
async function fetchStats() {
    const response = await apiRequest('/stats');
    const data = response.data;  // Unwrap the backend {success, data} response
    document.getElementById('statTotal').textContent = data.total;
    document.getElementById('statActive').textContent = data.active;
    document.getElementById('statDisabled').textContent = data.disabled;
    document.getElementById('statBanned').textContent = data.banned;

    // BaSui: Also fetch and display the current key selection algorithm
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
    
    // BaSui: Fetch and update token and request statistics
    await updateDashboardStats();
}

// Fetch the key list
async function fetchKeys() {
    const params = new URLSearchParams({
        page: currentPage,
        limit: currentPageSize,
        status: currentStatus,
        poolGroup: currentPoolGroup,  // BaSui: Key pool filter
        includeTokenUsage: 'true'  // BaSui: Include token usage information
    });

    const response = await apiRequest(`/keys?${params}`);
    const data = response.data;  // Unwrap the backend {success, data} response
    renderKeysTable(data.keys);
    renderPagination(data.pagination);
    // BaSui: Render charts
    renderCharts(data.keys);
    // Update the total count
    const totalCountEl = document.getElementById('totalKeysCount');
    if (totalCountEl) {
        totalCountEl.textContent = data.pagination.total || 0;
    }
}

// Render the key table using DocumentFragment to reduce layout recalculation
function renderKeysTable(keys) {
    const tbody = document.getElementById('keysTableBody');

    if (keys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="15" class="loading-modern"><div class="loading-spinner"></div><span>No data available</span></td></tr>';
        return;
    }

    // Insert rows in a batch with DocumentFragment to reduce DOM operations
    const fragment = document.createDocumentFragment();
    const tempContainer = document.createElement('tbody');
    
    tempContainer.innerHTML = keys.map(key => {
        // BaSui: Show detailed test results, including status codes and explanations
        let testResultHtml = '';
        if (key.last_test_result === 'success') {
            testResultHtml = '<span class="test-success">✅ Test passed</span>';
        } else if (key.last_test_result === 'failed') {
            // Extract the status code from last_error (format: 402: xxx)
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

        // Calculate success rate and score; BaSui fix: use the accurate success count
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

        // BaSui: Compact horizontal pool label without emoji
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
                <button onclick="showEditKeyModal('${key.id}', '${key.key}', '${escapeHtml(key.notes || '')}', '${poolGroupDisplay}')" class="btn btn-primary btn-sm">Edit</button>
                <button onclick="showEditNotesModal('${key.id}', '${escapeHtml(key.notes || '')}')" class="btn btn-secondary btn-sm">Notes</button>
                <button onclick="showChangePoolModal('${key.id}', '${poolGroupDisplay}')" class="btn btn-warning btn-sm">Move pool</button>
                <button onclick="deleteKey('${key.id}')" class="btn btn-danger btn-sm">Delete</button>
            </td>
        </tr>
        `;
    }).join('');
    
    // Move all children into the fragment in a batch
    while (tempContainer.firstChild) {
        fragment.appendChild(tempContainer.firstChild);
    }
    
    // Replace the tbody contents in one operation
    tbody.innerHTML = '';
    tbody.appendChild(fragment);
    if (document.getElementById('limitsRows')) updateBalanceDisplay();
}

// Render pagination
function renderPagination(pagination) {
    const container = document.getElementById('pagination');
    const { page, total_pages, total } = pagination;

    container.innerHTML = `
        <button ${page <= 1 ? 'disabled' : ''} onclick="changePage(${page - 1})">Previous</button>
        <span class="page-info">Page ${page} of ${total_pages} (${total} records)</span>
        <button ${page >= total_pages ? 'disabled' : ''} onclick="changePage(${page + 1})">Next</button>
    `;
}

// Utility functions
function maskKey(key) {
    if (key.length <= 10) return key;
    return key.substring(0, 6) + '...' + key.substring(key.length - 4);
}

function getStatusText(status) {
    const map = {
        'active': 'Active',
        'disabled': 'Disabled',
        'banned': 'Blocked by proxy'
    };
    return map[status] || status;
}

// BaSui: The old helper was replaced by the more complete HTTP status map

function getToggleButtonClass(status) {
    switch (status) {
        case 'active':
            return 'btn-warning';  // Disable button
        case 'disabled':
            return 'btn-success';  // Enable button
        case 'banned':
            return 'btn-info';     // Unblock button
        default:
            return 'btn-secondary';
    }
}

function getToggleButtonText(status) {
    switch (status) {
        case 'active':
            return 'Disable';
        case 'disabled':
            return 'Enable';
        case 'banned':
            return 'Unblock';
        default:
            return 'Action';
    }
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString('en-US');
}

function escapeHtml(text) {
    return text.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

// Debounce to reduce repeated calls
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

// Throttle to limit execution frequency
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

// Debounced fetchKeys
const debouncedFetchKeys = debounce(fetchKeys, 300);

// Page actions
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

// BaSui: Handle changes to the page size
function pageSizeChanged() {
    const pageSizeSelect = document.getElementById('pageSizeSelect');
    currentPageSize = parseInt(pageSizeSelect.value);
    currentPage = 1;  // Reset to the first page
    fetchKeys();
}

// ========== Bulk actions (BaSui) ==========

async function loadBatchModalPoolGroups() {
    try {
        const response = await apiRequest('/pool-groups');
        const poolGroups = response.data || [];
        
        // Update the destination pool selector
        const targetPoolSelect = document.getElementById('batchActionPoolSelect');
        if (targetPoolSelect) {
            targetPoolSelect.innerHTML = '<option value="">-- Select a destination pool --</option><option value="default">Default pool (default)</option>';
            poolGroups.forEach(group => {
                if (group.id !== 'default') {
                    const option = document.createElement('option');
                    option.value = group.id;
                    option.textContent = `${group.name || group.id} (${group.id})`;
                    targetPoolSelect.appendChild(option);
                }
            });
        }
        
        // Update pool options in the filter
        const filterPoolSelect = document.getElementById('batchModalPoolFilter');
        if (filterPoolSelect) {
            filterPoolSelect.innerHTML = '<option value="all">All pools</option><option value="default">Default pool</option>';
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
        console.error('Failed to load key pools:', err);
        // Keep the default options on failure
    }
}

/**
 * Open the bulk action dialog
 * @param {string} actionType - 'changePool' | 'enable' | 'disable' | 'delete'
 */
async function openBatchActionModal(actionType) {
    // Clear the previous selection
    batchModalKeyIds.clear();
    batchModalFilterStatus = 'all';
    batchModalFilterPool = 'all';
    
    // Set the dialog title and action type
    const modalTitle = {
        'changePool': '🔄 Move keys',
        'enable': '✅ Enable keys',
        'disable': '⏸️ Disable keys',
        'delete': '🗑️ Delete keys'
    }[actionType] || 'Bulk action';
    
    document.getElementById('batchActionModalTitle').textContent = modalTitle;
    document.getElementById('batchActionModalType').value = actionType;
    
    // Show the destination selector only when moving keys between pools
    const poolSelectorDiv = document.getElementById('batchActionPoolSelector');
    if (poolSelectorDiv) {
        poolSelectorDiv.style.display = actionType === 'changePool' ? 'block' : 'none';
    }
    
    // Load the pool list
    await loadBatchModalPoolGroups();
    
    // Load all keys
    await loadBatchModalKeys();
    
    // Show the dialog
    showModal('batchActionModal');
}

/**
 * Load the key list for the bulk action dialog
 */
async function loadBatchModalKeys() {
    try {
        // Limit each load to 100 records to reduce the data volume
        const params = new URLSearchParams({
            page: 1,
            limit: 100, // Limit to 100 records to avoid performance issues
            status: 'all',
            includeTokenUsage: 'false'  // Omit token information to reduce data transfer
        });
        
        const response = await apiRequest(`/keys?${params}`);
        batchModalAllKeys = response.data.keys || [];
        
        // Render the key list inside the dialog
        renderBatchModalKeys();
        updateBatchModalCount();
    } catch (err) {
        console.error('Failed to load keys:', err);
        alert('Failed to load keys: ' + err.message);
    }
}

/**
 * Render the key list in the bulk action dialog
 */
function renderBatchModalKeys() {
    // Apply filters
    let filteredKeys = batchModalAllKeys;
    
    // Filter by status
    if (batchModalFilterStatus !== 'all') {
        filteredKeys = filteredKeys.filter(k => k.status === batchModalFilterStatus);
    }
    
    // Filter by key pool
    if (batchModalFilterPool !== 'all') {
        filteredKeys = filteredKeys.filter(k => (k.poolGroup || 'default') === batchModalFilterPool);
    }
    
    const tbody = document.getElementById('batchModalKeysTableBody');
    
    if (filteredKeys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #999;">No keys match the selected filters</td></tr>';
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
 * Toggle a key selection in the bulk action dialog
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
 * Select or deselect all keys in the dialog
 */
function toggleBatchModalSelectAll(checked) {
    // Get keys matching the current filters
    let filteredKeys = batchModalAllKeys;
    
    if (batchModalFilterStatus !== 'all') {
        filteredKeys = filteredKeys.filter(k => k.status === batchModalFilterStatus);
    }
    
    if (batchModalFilterPool !== 'all') {
        filteredKeys = filteredKeys.filter(k => (k.poolGroup || 'default') === batchModalFilterPool);
    }
    
    // Update selection state
    filteredKeys.forEach(key => {
        if (checked) {
            batchModalKeyIds.add(key.id);
        } else {
            batchModalKeyIds.delete(key.id);
        }
    });
    
    // Render the list again
    renderBatchModalKeys();
    updateBatchModalCount();
}

/**
 * Handle filter changes in the bulk action dialog
 */
function batchModalFilterChanged() {
    batchModalFilterStatus = document.getElementById('batchModalStatusFilter').value;
    batchModalFilterPool = document.getElementById('batchModalPoolFilter').value;
    renderBatchModalKeys();
}

/**
 * Update the selected-key count in the bulk action dialog
 */
function updateBatchModalCount() {
    const count = batchModalKeyIds.size;
    document.getElementById('batchModalSelectedCount').textContent = count;
    
    // Update the Select all checkbox
    const selectAllCheckbox = document.getElementById('batchModalSelectAll');
    if (selectAllCheckbox) {
        // Get the number of keys matching the current filters
        let filteredKeys = batchModalAllKeys;
        if (batchModalFilterStatus !== 'all') {
            filteredKeys = filteredKeys.filter(k => k.status === batchModalFilterStatus);
        }
        if (batchModalFilterPool !== 'all') {
            filteredKeys = filteredKeys.filter(k => (k.poolGroup || 'default') === batchModalFilterPool);
        }
        
        // Check Select all when every key matching the filters is selected
        const allSelected = filteredKeys.length > 0 && filteredKeys.every(k => batchModalKeyIds.has(k.id));
        selectAllCheckbox.checked = allSelected;
    }
    
    // Enable or disable the confirmation button
    const confirmButton = document.getElementById('batchActionConfirmBtn');
    if (confirmButton) {
        confirmButton.disabled = count === 0;
    }
}

/**
 * Execute the bulk action
 */
async function confirmBatchAction() {
    const actionType = document.getElementById('batchActionModalType').value;
    const selectedCount = batchModalKeyIds.size;
    
    if (selectedCount === 0) {
        alert('Select at least one key');
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
                alert('Unknown action type');
                return;
        }
    } catch (err) {
        console.error('Bulk action failed:', err);
    }
}

/**
 * Move keys between pools in bulk
 */
async function executeBatchChangePool(keyIds) {
    const poolGroup = document.getElementById('batchActionPoolSelect').value;
    
    if (!poolGroup) {
        alert('Select a destination key pool');
        return;
    }
    
    if (!confirm(`Move ${keyIds.length} keys to pool "${poolGroup}"?`)) {
        return;
    }
    
    try {
        const result = await apiRequest('/keys/batch-change-pool', 'PATCH', {
            keyIds,
            poolGroup
        });
        
        alert(`✅ Keys moved successfully.\nMoved ${result.data.count} keys to "${poolGroup}".`);
        closeModal('batchActionModal');
        refreshData();
    } catch (err) {
        alert('❌ Failed to move keys: ' + err.message);
    }
}

/**
 * Enable or disable keys in bulk
 */
async function executeBatchToggleStatus(keyIds, status) {
    const action = status === 'active' ? 'Enable' : 'Disable';
    
    if (!confirm(`${action} ${keyIds.length} keys?`)) {
        return;
    }
    
    try {
        const result = await apiRequest('/keys/batch-toggle-status', 'PATCH', {
            keyIds,
            status
        });
        
        alert(`✅ ${action} completed for ${result.data.count} keys.`);
        closeModal('batchActionModal');
        refreshData();
    } catch (err) {
        alert(`❌ ${action} failed: ` + err.message);
    }
}

/**
 * Delete keys in bulk
 */
async function executeBatchDelete(keyIds) {
    if (!confirm(`⚠️ Delete ${keyIds.length} keys?\nThis cannot be undone.`)) {
        return;
    }
    
    try {
        const result = await apiRequest('/keys/batch-delete', 'DELETE', {
            keyIds
        });
        
        alert(`✅ Deleted ${result.data.count} keys.`);
        closeModal('batchActionModal');
        refreshData();
    } catch (err) {
        alert('❌ Failed to delete keys: ' + err.message);
    }
}

// End of bulk actions

// Dialog actions
function showModal(modalId) {
    document.getElementById(modalId).style.display = 'block';
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

async function showAddKeyModal() {
    // BaSui: Ensure pool data is loaded before opening the dialog
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
    // BaSui: Ensure pool data is loaded before opening the dialog
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

// BaSui: Show the key editor, including pool assignment
function showEditKeyModal(keyId, key, notes, poolGroup) {
    currentEditKeyId = keyId;
    document.getElementById('editKeyInput').value = key;
    document.getElementById('editKeyNotesInput').value = notes.replace(/&#39;/g, "'").replace(/&quot;/g, '"');

    // BaSui: Refresh the pool selector if pool-groups.js is loaded
    if (typeof updatePoolGroupSelects === 'function') {
        updatePoolGroupSelects();
    }

    // BaSui: Set the selected key pool
    const poolSelect = document.getElementById('editKeyPoolGroup');
    if (poolSelect) {
        poolSelect.value = poolGroup || 'default';
    }

    showModal('editKeyModal');
}

// Key actions
async function addKey() {
    const key = document.getElementById('newKeyInput').value.trim();
    const notes = document.getElementById('newKeyNotes').value.trim();
    const poolGroup = document.getElementById('newKeyPoolGroup')?.value || null;

    if (!key) {
        alert('Enter a key');
        return;
    }

    if (!key.startsWith('fk-')) {
        alert('Invalid key format. Keys must begin with fk-.');
        return;
    }

    try {
        await apiRequest('/keys', 'POST', { key, notes, poolGroup });
        alert('Key added successfully');
        closeModal('addKeyModal');
        refreshData();
    } catch (err) {
        alert('Failed to add key: ' + err.message);
    }
}

async function batchImport() {
    const keysText = document.getElementById('batchKeysInput').value.trim();
    const poolGroup = document.getElementById('batchImportPoolGroup').value || null;

    if (!keysText) {
        alert('Enter a key');
        return;
    }

    const keys = keysText.split('\n').map(k => k.trim()).filter(k => k);

    try {
        const response = await apiRequest('/keys/batch', 'POST', { keys, poolGroup });
        const result = response.data; // BaSui: The backend payload is in response.data

        const resultDiv = document.getElementById('importResult');

        // Choose an accurate status message based on the import results
        let statusClass = 'success';
        let statusEmoji = '✅';
        let summaryText = '';

        if (result.success > 0) {
            // Some keys were imported successfully
            statusClass = 'success';
            statusEmoji = '✅';
            summaryText = `Successfully imported ${result.success} keys.`;
        } else if (result.duplicate > 0 && result.invalid === 0) {
            // All keys are duplicates; none are invalid
            statusClass = 'warning';
            statusEmoji = '🔄';
            summaryText = `All keys already exist (${result.duplicate} duplicates).`;
        } else if (result.invalid > 0 && result.duplicate === 0) {
            // All keys are invalid
            statusClass = 'error';
            statusEmoji = '❌';
            summaryText = `All ${result.invalid} keys are invalid.`;
        } else {
            // Mixed results
            statusClass = 'warning';
            statusEmoji = '⚠️';
            summaryText = 'Import completed with issues for some keys.';
        }

        resultDiv.className = `import-result ${statusClass}`;
        resultDiv.innerHTML = `
            <h3>${statusEmoji} ${summaryText}</h3>
            <div class="result-details">
                <p>✅ Imported: ${result.success}</p>
                <p>🔄 Already present (skipped): ${result.duplicate}</p>
                <p>❌ Invalid format: ${result.invalid}</p>
            </div>
            ${result.errors && result.errors.length > 0 ? `<p class=\"error-info\">Error details: ${result.errors.join(', ')}</p>` : ''}
        `;

        refreshData();
    } catch (err) {
        const resultDiv = document.getElementById('importResult');
        resultDiv.className = 'import-result error';
        resultDiv.innerHTML = `<p>❌ Request failed: ${err.message}</p>`;
    }
}

// BaSui: Export keys as a text file, one key per line
async function exportKeys() {
    try {
        // Read the current status filter so the export matches the selection
        const status = document.getElementById('statusFilter').value;

        // Build the export URL
        const url = `/admin/keys/export?status=${status}`;

        // Send the request with the required x-admin-key authentication header
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'x-admin-key': adminKey
            }
        });

        // BaSui: Handle error responses
        if (!response.ok) {
            let errorMsg = `HTTP ${response.status}`;
            try {
                const error = await response.json();
                errorMsg = error.message || errorMsg;
            } catch (e) {
                // The response is not JSON; use the status code
            }
            throw new Error(errorMsg);
        }

        // BaSui: Read the file contents as a Blob
        const blob = await response.blob();

        // BaSui: Extract the filename from the backend Content-Disposition header
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = `keys_${status}_${new Date().toISOString().split('T')[0]}.txt`;

        if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
            if (filenameMatch && filenameMatch[1]) {
                filename = filenameMatch[1];
            }
        }

        // BaSui: Create a download link and trigger the download
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();

        // BaSui: Release temporary objects to prevent memory leaks
        setTimeout(() => {
            window.URL.revokeObjectURL(downloadUrl);
            document.body.removeChild(a);
        }, 100);

        // BaSui: Show the success message
        alert(`✅ Export complete.\nFilename: ${filename}\nStatus filter: ${status === 'all' ? 'All' : status}`);

    } catch (err) {
        alert('❌ Export failed: ' + err.message);
        console.error('Export keys error:', err);
    }
}

async function testKey(keyId) {
    if (!confirm('Test this key?')) return;

    try {
        const result = await apiRequest(`/keys/${keyId}/test`, 'POST');
        const data = result.data;

        // BaSui: Display the complete test result in readable form
        let message = '━━━━━━━━━━━━━━━━━━━━\n';
        message += '📊 Key test result\n';
        message += '━━━━━━━━━━━━━━━━━━━━\n\n';

        if (data.success) {
            message += '✅ Test passed\n\n';
            message += `Status code: ${data.status}\n`;
            message += `Description: ${getStatusMessage(data.status)}\n`;
            message += `Key status: ${getStatusText(data.key_status)}`;
        } else {
            message += '❌ Test failed\n\n';
            message += `Status code: ${data.status}\n`;
            message += `Error type: ${getStatusMessage(data.status)}\n`;
            message += `Error details: ${data.message}\n`;
            message += `Key status: ${getStatusText(data.key_status)}`;
        }

        alert(message);
        refreshData();
    } catch (err) {
        alert('❌ Test request failed\n\n' + err.message);
    }
}

async function testAllKeys() {
    if (!confirm('Test all keys? This may take a while.')) return;

    try {
        const result = await apiRequest('/keys/test-all', 'POST');
        const data = result.data;

        // BaSui: Present bulk test results in readable form
        let message = '━━━━━━━━━━━━━━━━━━━━\n';
        message += '🧪 Bulk test complete\n';
        message += '━━━━━━━━━━━━━━━━━━━━\n\n';
        message += `📊 Total keys: ${data.total}\n`;
        message += `🔍 Tested: ${data.tested}\n`;
        message += `✅ Passed: ${data.success}\n`;
        message += `❌ Failed: ${data.failed}\n`;
        message += `🚫 Automatically blocked by proxy: ${data.banned}\n\n`;

        if (data.banned > 0) {
            message += '💡 Keys with insufficient balance were automatically blocked by the proxy.\n';
            message += 'Use "Delete blocked keys" to remove them in bulk.';
        }

        alert(message);
        refreshData();
    } catch (err) {
        alert('❌ Bulk test failed\n\n' + err.message);
    }
}

async function deleteBannedKeys() {
    // BaSui: Fetch the count of keys blocked by the proxy
    try {
        const statsResponse = await apiRequest('/stats');
        const bannedCount = statsResponse.data.banned;

        if (bannedCount === 0) {
            alert('There are no blocked keys to delete.');
            return;
        }

        if (!confirm(`Delete all ${bannedCount} blocked keys?\nThis cannot be undone.`)) return;

        // BaSui: Call the API to delete blocked keys
        const result = await apiRequest('/keys/banned', 'DELETE');

        // BaSui: Check the response shape to avoid null-reference errors
        const deletedCount = result && result.data && result.data.count ? result.data.count : 0;
        alert(`Deleted ${deletedCount} blocked keys.`);
        refreshData();
    } catch (err) {
        console.error('Failed to delete blocked keys:', err);
        alert('Failed to delete blocked keys: ' + err.message);
    }
}

async function deleteDisabledKeys() {
    // BaSui: Fetch the count of disabled keys
    try {
        const statsResponse = await apiRequest('/stats');
        const disabledCount = statsResponse.data.disabled;

        if (disabledCount === 0) {
            alert('There are no disabled keys to delete.');
            return;
        }

        if (!confirm(`Delete all ${disabledCount} disabled keys?\nThis cannot be undone.`)) return;

        // BaSui: Call the API to delete disabled keys
        const result = await apiRequest('/keys/disabled', 'DELETE');

        // BaSui: Check the response shape to avoid null-reference errors
        const deletedCount = result && result.data && result.data.count ? result.data.count : 0;
        alert(`Deleted ${deletedCount} disabled keys.`);
        refreshData();
    } catch (err) {
        console.error('Failed to delete disabled keys:', err);
        alert('Failed to delete disabled keys: ' + err.message);
    }
}

async function toggleKeyStatus(keyId, currentStatus) {
    let newStatus, action, confirmMessage;

    // BaSui: Choose the action based on the current status
    switch (currentStatus) {
        case 'active':
            newStatus = 'disabled';
            action = 'Disable';
            confirmMessage = `Disable this key?\nIt will be excluded from key selection until you enable it again.`;
            break;
        case 'disabled':
            newStatus = 'active';
            action = 'Enable';
            confirmMessage = `Enable this key?`;
            break;
        case 'banned':
            newStatus = 'active';
            action = 'Unblock';
            confirmMessage = `Unblock this key?\nIt will become eligible for key selection again.`;
            break;
        default:
            // BaSui: Unknown status; default to disabling the key
            newStatus = 'disabled';
            action = 'Disable';
            confirmMessage = `Disable this key?`;
    }

    if (!confirm(confirmMessage)) return;

    try {
        // BaSui: The toggle API clears the backend block flag for blocked keys
        await apiRequest(`/keys/${keyId}/toggle`, 'PATCH', { status: newStatus });
        alert(`${action} completed successfully`);
        refreshData();
    } catch (err) {
        console.error(`${action} failed:`, err);
        alert(`${action} failed: ` + err.message);
    }
}

async function deleteKey(keyId) {
    if (!confirm('Delete this key? This cannot be undone.')) return;

    try {
        await apiRequest(`/keys/${keyId}`, 'DELETE');
        alert('Key deleted successfully');
        refreshData();
    } catch (err) {
        alert('Failed to delete key: ' + err.message);
    }
}

async function saveNotes() {
    const notes = document.getElementById('editNotesInput').value.trim();

    try {
        // BaSui: The backend expects PATCH rather than PUT
        await apiRequest(`/keys/${currentEditKeyId}/notes`, 'PATCH', { notes });
        alert('Saved successfully');
        closeModal('editNotesModal');
        refreshData();
    } catch (err) {
        alert('Failed to save: ' + err.message);
    }
}

// BaSui: Save key edits using PUT /admin/keys/:id and PATCH /admin/keys/:id/pool
async function saveEditedKey() {
    const key = document.getElementById('editKeyInput').value.trim();
    const notes = document.getElementById('editKeyNotesInput').value.trim();
    const poolGroup = document.getElementById('editKeyPoolGroup')?.value || 'default';

    if (!key) {
        alert('Enter a key');
        return;
    }

    if (!key.startsWith('fk-')) {
        alert('Invalid key format. Keys must begin with fk-.');
        return;
    }

    try {
        // BaSui: Update the key and notes first
        await apiRequest(`/keys/${currentEditKeyId}`, 'PUT', { key, notes });

        // BaSui: Then update the pool assignment if it changed
        try {
            await apiRequest(`/keys/${currentEditKeyId}/pool`, 'PATCH', { poolGroup });
        } catch (poolErr) {
            console.warn('Failed to update key pool (the assignment may be unchanged):', poolErr);
        }

        alert('✅ Key updated successfully.');
        closeModal('editKeyModal');
        refreshData();
    } catch (err) {
        alert('❌ Update failed: ' + err.message);
    }
}

// BaSui: Close dialogs on backdrop clicks; addEventListener preserves other handlers
window.addEventListener('click', function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
});

// ============================================
// BaSui: Configuration management (key selection, retries, etc.)
// ============================================

/**
 * Show the configuration dialog
 */
async function showConfigModal() {
    try {
        // Load the current configuration
        const response = await apiRequest('/config');
        const config = response.data;

        // Populate the form
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
        alert('❌ Failed to load configuration\n\n' + err.message);
    }
}

/**
 * Save configuration
 */
async function saveConfig() {
    try {
        const config = {
            // General settings
            port: parseInt(document.getElementById('configPort').value),
            user_agent: document.getElementById('configUserAgent').value,
            dev_mode: document.getElementById('configDevMode').checked,
            system_prompt: document.getElementById('configSystemPrompt').value,
            
            // Size limits
            limits: {
                notes_max_length: parseInt(document.getElementById('configNotesMaxLength').value),
                max_json_log_size: parseInt(document.getElementById('configMaxJsonLogSize').value)
            },
            
            // Reasoning token budgets
            reasoning_tokens: {
                low: parseInt(document.getElementById('configReasoningLow').value),
                medium: parseInt(document.getElementById('configReasoningMedium').value),
                high: parseInt(document.getElementById('configReasoningHigh').value)
            },
            
            // Balance synchronization settings
            balance_sync: {
                sync_interval_minutes: parseInt(document.getElementById('configSyncInterval').value),
                save_interval_minutes: parseInt(document.getElementById('configSaveInterval').value)
            },
            
            // Key pool settings
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
            
            // Redis settings
            redis: {
                enabled: document.getElementById('configRedisEnabled').checked,
                host: document.getElementById('configRedisHost').value,
                port: parseInt(document.getElementById('configRedisPort').value),
                password: document.getElementById('configRedisPassword').value,
                db: parseInt(document.getElementById('configRedisDb').value),
                key_prefix: document.getElementById('configRedisKeyPrefix').value
            },
            
            // Cluster settings
            cluster: {
                enabled: document.getElementById('configClusterEnabled').checked,
                workers: parseInt(document.getElementById('configClusterWorkers').value)
            }
        };

        // BaSui: Validate input
        if (config.port < 1 || config.port > 65535) {
            alert('❌ Port must be between 1 and 65535.');
            return;
        }
        if (config.limits.notes_max_length < 100 || config.limits.notes_max_length > 10000) {
            alert('❌ Maximum notes length must be between 100 and 10000.');
            return;
        }
        if (config.limits.max_json_log_size < 1000 || config.limits.max_json_log_size > 50000) {
            alert('❌ Maximum JSON log length must be between 1000 and 50000.');
            return;
        }
        if (config.reasoning_tokens.low < 1024 || config.reasoning_tokens.low > 32768) {
            alert('❌ Low reasoning budget must be between 1024 and 32768 tokens.');
            return;
        }
        if (config.reasoning_tokens.medium < 1024 || config.reasoning_tokens.medium > 32768) {
            alert('❌ Medium reasoning budget must be between 1024 and 32768 tokens.');
            return;
        }
        if (config.reasoning_tokens.high < 1024 || config.reasoning_tokens.high > 65536) {
            alert('❌ High reasoning budget must be between 1024 and 65536 tokens.');
            return;
        }
        if (config.balance_sync.sync_interval_minutes < 5 || config.balance_sync.sync_interval_minutes > 1440) {
            alert('❌ Synchronization interval must be between 5 and 1440 minutes.');
            return;
        }
        if (config.balance_sync.save_interval_minutes < 1 || config.balance_sync.save_interval_minutes > 60) {
            alert('❌ Save interval must be between 1 and 60 minutes.');
            return;
        }
        if (config.key_pool.retry.maxRetries < 0 || config.key_pool.retry.maxRetries > 10) {
            alert('❌ Maximum retries must be between 0 and 10.');
            return;
        }
        if (config.key_pool.retry.retryDelay < 0 || config.key_pool.retry.retryDelay > 10000) {
            alert('❌ Retry delay must be between 0 and 10000 ms.');
            return;
        }
        if (config.key_pool.autoBan.errorThreshold < 1 || config.key_pool.autoBan.errorThreshold > 100) {
            alert('❌ Error threshold must be between 1 and 100.');
            return;
        }
        if (config.key_pool.performance.concurrentLimit < 1 || config.key_pool.performance.concurrentLimit > 1000) {
            alert('❌ Concurrency limit must be between 1 and 1000.');
            return;
        }
        if (config.key_pool.performance.requestTimeout < 1000 || config.key_pool.performance.requestTimeout > 60000) {
            alert('❌ Request timeout must be between 1000 and 60000 ms.');
            return;
        }
        if (config.redis.port < 1 || config.redis.port > 65535) {
            alert('❌ Redis port must be between 1 and 65535.');
            return;
        }
        if (config.redis.db < 0 || config.redis.db > 15) {
            alert('❌ Redis database index must be between 0 and 15.');
            return;
        }
        if (config.cluster.workers < 0 || config.cluster.workers > 32) {
            alert('❌ Worker count must be between 0 and 32.');
            return;
        }

        await apiRequest('/config', 'PUT', config);
        
        // Check whether changed settings require a restart
        const needsRestart = config.port !== originalPort || 
                           config.redis.enabled !== originalRedisEnabled ||
                           config.cluster.enabled !== originalClusterEnabled;
        
        if (needsRestart) {
            alert('✅ Configuration saved.\n\n⚠️ Restart required for changes to:\n- Server port\n- Redis settings\n- Cluster mode settings');
        } else {
            alert('✅ Configuration saved.');
        }
        
        refreshData(); // Refresh statistics to show the new algorithm
    } catch (err) {
        alert('❌ Failed to save configuration\n\n' + err.message);
    }
}

/**
 * Restore default configuration
 */
async function resetConfigToDefault() {
    if (!confirm('Restore all configuration defaults?')) return;

    try {
        await apiRequest('/config/reset', 'POST');
        alert('✅ Configuration defaults restored.');
        closeModal('configModal');
        refreshData();
    } catch (err) {
        alert('❌ Failed to restore configuration defaults\n\n' + err.message);
    }
}

/**
 * Get the display name for a key selection algorithm
 */
function getAlgorithmText(algorithm) {
    const map = {
        // Traditional algorithms
        'round-robin': 'Round robin',
        'random': 'Random',
        'least-used': 'Least used',
        'weighted-score': 'Weighted score',

        // Algorithms based on token usage
        'least-token-used': 'Least tokens used',
        'max-remaining': 'Most quota remaining',

        // Advanced selection algorithms
        'weighted-usage': 'Factory window headroom',
        'quota-aware': 'Quota aware',
        'time-window': 'Time window'
    };
    return map[algorithm] || algorithm;
}

// BaSui: Optimized chart rendering
/**
 * Render all statistics charts using requestAnimationFrame
 */
function renderCharts(keys) {
    // Schedule chart rendering with requestAnimationFrame
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
 * Render the key status distribution pie chart
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
        document.getElementById('statusChart').innerHTML = '<p style="color: #999;">No data available</p>';
        return;
    }

    // Calculate angles
    const activeAngle = (statusCount.active / total) * 360;
    const disabledAngle = (statusCount.disabled / total) * 360;
    const bannedAngle = (statusCount.banned / total) * 360;

    // Build the pie chart background
    const pieBackground = `conic-gradient(
        #28a745 0deg ${activeAngle}deg,
        #ffc107 ${activeAngle}deg ${activeAngle + disabledAngle}deg,
        #dc3545 ${activeAngle + disabledAngle}deg ${activeAngle + disabledAngle + bannedAngle}deg,
        #6c757d ${activeAngle + disabledAngle + bannedAngle}deg
    )`;

    // Build the legend
    const legend = `
        <div class="pie-chart-legend">
            <div class="pie-legend-item">
                <div class="pie-legend-color" style="background: #28a745;"></div>
                <span>Active (${statusCount.active})</span>
            </div>
            <div class="pie-legend-item">
                <div class="pie-legend-color" style="background: #ffc107;"></div>
                <span>Disabled (${statusCount.disabled})</span>
            </div>
            <div class="pie-legend-item">
                <div class="pie-legend-color" style="background: #dc3545;"></div>
                <span>Blocked by proxy (${statusCount.banned})</span>
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
 * Render the success-rate ranking
 */
function renderSuccessRateChart(keys) {
    // Include only keys with usage history
    const keysWithStats = keys.filter(key => (key.total_requests || key.usage_count || 0) > 0);

    if (keysWithStats.length === 0) {
        document.getElementById('successRateList').innerHTML = '<p style="color: #999;">No usage data available</p>';
        return;
    }

    // Calculate success rates and sort
    const keysWithRate = keysWithStats.map(key => {
        const totalRequests = key.total_requests || key.usage_count || 0;
        const successRequests = key.success_requests || (totalRequests - (key.error_count || 0));
        const successRate = totalRequests > 0 ? (successRequests / totalRequests) : 0;

        return {
            ...key,
            successRate: successRate,
            successRateText: (successRate * 100).toFixed(1) + '%'
        };
    }).sort((a, b) => b.successRate - a.successRate).slice(0, 10); // Show only the top 10

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
 * Render the usage chart
 */
function renderUsageChart(keys) {
    // Count usage
    const keysWithUsage = keys.filter(key => (key.usage_count || 0) > 0);

    if (keysWithUsage.length === 0) {
        document.getElementById('usageStats').innerHTML = '<p style="color: #999;">No usage data available</p>';
        return;
    }

    // Calculate total usage
    const totalUsage = keysWithUsage.reduce((sum, key) => sum + (key.usage_count || 0), 0);

    // Sort by usage count
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
 * Render token usage trends with /admin/token/trend
 */
async function renderTokenTrendChart(keys) {
    try {
        // Call the trend API
        const response = await fetch('/admin/token/trend', {
            headers: {
                'x-admin-key': adminKey
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch token trends: ${response.status}`);
        }

        const result = await response.json();
        if (!result.success || !result.data) {
            throw new Error('Invalid token trend data format');
        }

        const { top_keys, summary } = result.data;

        if (!top_keys || top_keys.length === 0) {
            document.getElementById('tokenTrendStats').innerHTML = '<p style="color: #999;">No token usage data. Click Refresh to load it.</p>';
            return;
        }

        // Build the token trend HTML
        const trendHtml = top_keys.map((keyData, index) => {
            // Choose colors based on usage percentage
            const percentage = parseFloat(keyData.percentage);
            let barColor = '#10b981'; // Green (low usage)
            if (percentage > 80) {
                barColor = '#ef4444'; // Red (high usage)
            } else if (percentage > 60) {
                barColor = '#f59e0b'; // Orange (moderate usage)
            } else if (percentage > 40) {
                barColor = '#fbbf24'; // Yellow (approaching moderate usage)
            }

            // BaSui: Add pool labels and ranking badges
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
        console.error('Failed to render token trends:', error);
        document.getElementById('tokenTrendStats').innerHTML = `<p style="color: #ef4444;">Failed to load: ${error.message}</p>`;
    }
}

// ===================== Token usage management =====================
let tokenUsageData = {};  // Store token usage data

// BaSui: Manually refresh token usage statistics
async function refreshTokenUsage() {
    try {
        await fetchTokenUsage();
        alert('✅ Token usage statistics updated.');
    } catch (err) {
        console.error('Failed to refresh token statistics:', err);
        alert('❌ Failed to refresh token statistics: ' + err.message);
    }
}

// Fetch token usage statistics
async function fetchTokenUsage() {
    try {
        const response = await fetch('/admin/token/usage', {
            headers: {
                'x-admin-key': adminKey  // BaSui: Use lowercase consistently with the other API calls
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch token usage: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (data.success) {
            tokenUsageData = data.keys || {};
            updateTokenUsageDisplay();
        }
    } catch (err) {
        console.error('Failed to fetch token usage:', err);
        // Do not rethrow; keep other features working
    }
}

// Update the token usage display
async function updateTokenUsageDisplay() {
    // BaSui: Request statistics come from the key pool; token statistics from Factory
    let totalTokens = 0;
    let totalRequests = 0;
    let todayTokens = 0;  // Today-only statistics are not yet supported here
    let todayRequests = 0;

    try {
        // BaSui: Call the statistics summary API
        const response = await fetch('/admin/stats/summary', {
            headers: {
                'x-admin-key': adminKey
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch statistics: ${response.status}`);
        }

        const result = await response.json();
        if (result.success && result.data) {
            totalTokens = result.data.total_tokens || 0;
            totalRequests = result.data.total_requests || 0;
            todayTokens = result.data.today_tokens || 0;
            todayRequests = result.data.today_requests || 0;
        }
    } catch (err) {
        console.error('Failed to fetch statistics:', err);
        // Display zero on failure
    }

    // Update the token usage card
    const tokenCard = document.getElementById('tokenUsageCard');
    if (tokenCard) {
        tokenCard.innerHTML = `
            <div class="stat-value">${formatTokenNumber(totalTokens)}</div>
            <div class="stat-label">Total tokens used</div>
            <div class="token-details">
                <div>Total requests: ${formatNumber(totalRequests)}</div>
                <div>Used today: ${formatTokenNumber(todayTokens)} tokens</div>
                <div>Requests today: ${todayRequests}</div>
            </div>
        `;
    }

    // Update the top-level statistics
    updateMainStats(totalTokens, totalRequests, todayTokens, todayRequests);
}

// Format token counts for display
function formatTokenNumber(num) {
    if (num > 1000000) {
        return (num / 1000000).toFixed(2) + 'M';
    } else if (num > 1000) {
        return (num / 1000).toFixed(2) + 'K';
    }
    return num.toString();
}

// Update the main statistics
function updateMainStats(totalTokens, totalRequests, todayTokens, todayRequests) {
    // BaSui: Update existing dashboard elements directly
    const tokenUsedEl = document.getElementById('statTokenUsed');
    const tokenTodayEl = document.getElementById('statTokenToday');
    const totalRequestsEl = document.getElementById('statTotalRequests');
    const todayRequestsEl = document.getElementById('statTodayRequests');
    
    if (tokenUsedEl) tokenUsedEl.textContent = formatTokenNumber(totalTokens);
    if (tokenTodayEl) tokenTodayEl.textContent = formatTokenNumber(todayTokens);
    if (totalRequestsEl) totalRequestsEl.textContent = formatNumber(totalRequests);
    if (todayRequestsEl) todayRequestsEl.textContent = todayRequests;
}

// BaSui: Standalone dashboard statistics refresh
async function updateDashboardStats() {
    try {
        // Fetch token and request statistics together
        const response = await fetch('/admin/stats/summary', {
            headers: {
                'x-admin-key': adminKey
            }
        });

        if (!response.ok) {
            console.warn('Failed to fetch statistics:', response.status);
            return;
        }

        const result = await response.json();
        if (result.success && result.data) {
            const { total_tokens = 0, total_requests = 0, today_tokens = 0, today_requests = 0 } = result.data;
            updateMainStats(total_tokens, total_requests, today_tokens, today_requests);
        }
    } catch (err) {
        console.error('Failed to update dashboard statistics:', err);
        // Display zero on failure so the interface remains usable
        updateMainStats(0, 0, 0, 0);
    }
}

// Fetch balances for all keys through the cached Factory-specific API
async function fetchAllBalances(forceRefresh = false) {
    // TODO: The Factory balance API is not implemented yet
    console.warn('Balance queries are currently unavailable - the Factory balance API is not implemented.');
    balanceData = [];
    updateBalanceDisplay();
    return;

    /* Original implementation; enable when the backend is ready
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
            throw new Error(`Failed to fetch balance: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (data.success) {
            balanceData = data.results || [];
            updateBalanceDisplay();

            // Show cache status
            if (data.fromCache) {
                console.log('Using cached balance data; last synchronized:', data.summary?.lastSync);
            } else {
                console.log('Balance data refreshed');
            }

            // Show the next synchronization time
            if (data.summary?.lastSync) {
                const nextSync = new Date(new Date(data.summary.lastSync).getTime() + 30 * 60 * 1000);
                console.log('Next automatic synchronization:', nextSync.toLocaleString());
            }
        }
    } catch (err) {
        console.error('Failed to fetch balance:', err);
    }
    */
}

// Fetch the balance for one key
async function checkKeyBalance(keyId) {
    // TODO: The balance API is not implemented yet
    console.warn('Single-key balance queries are currently unavailable.');
    return null;

    /* Original implementation; enable when the backend is ready
    try {
        // Use the Factory-specific API with caching
        const response = await fetch(`/factory/balance/check/${keyId}`, {
            headers: {
                'X-Admin-Key': adminKey
            }
        });

        if (!response.ok) {
            // Try the general API if the Factory API fails
            const fallbackResponse = await fetch(`/admin/balance/check/${keyId}`, {
                headers: {
                    'X-Admin-Key': adminKey
                }
            });

            if (!fallbackResponse.ok) {
                throw new Error(`Failed to fetch balance: ${fallbackResponse.status} ${fallbackResponse.statusText}`);
            }

            const data = await fallbackResponse.json();
            if (data.success) {
                updateSingleKeyBalance(keyId, data);
                alert(`Balance retrieved successfully.\n${formatBalanceInfo(data)}`);
            }
            return data;
        }

        const data = await response.json();
        if (data.success) {
            updateSingleKeyBalance(keyId, data);
            const cacheInfo = data.fromCache ? ' (cached)' : ' (live query)';
            alert(`Balance retrieved successfully${cacheInfo}.\n${formatBalanceInfo(data)}`);
        }

        return data;
    } catch (err) {
        console.error(`Failed to fetch balance for key ${keyId}:`, err);
        alert('Failed to fetch balance: ' + err.message);
    }
    */
}

// Update balance information for one key
function updateSingleKeyBalance(keyId, data) {
    const index = balanceData.findIndex(b => b.id === keyId);
    if (index !== -1) {
        balanceData[index] = data;
    } else {
        balanceData.push(data);
    }
    updateBalanceDisplay();
}

// Format balance information
function formatBalanceInfo(data) {
    if (!data.balance || !data.balance.success) {
        return 'Query failed: ' + (data.balance?.error || 'Unknown error');
    }

    const balance = data.balance;
    let info = `Provider: ${balance.provider}\n`;

    if (balance.provider === 'openai') {
        info += `Available balance: $${balance.balance?.total_available || 0}\n`;
        info += `Used this month: $${balance.usage?.current_month_usd || 0}`;
    } else if (balance.provider === 'anthropic') {
        info += balance.message || 'Anthropic balance queries are not currently supported.';
    } else if (balance.provider === 'glm') {
        info += `Remaining balance: ¥${balance.balance?.remaining_balance || 0}`;
    } else if (balance.provider === 'factory') {
        if (balance.balance) {
            if (balance.balance.remaining_credits !== undefined) {
                info += `Remaining quota: ${balance.balance.remaining_credits} credits\n`;
                info += `Used: ${balance.balance.used_credits || 0} credits\n`;
                info += `Total quota: ${balance.balance.total_credits || 0} credits`;
            } else if (balance.balance.total_balance !== undefined) {
                info += `Total balance: $${balance.balance.total_balance}\n`;
                info += `Currency: ${balance.balance.currency || 'USD'}`;
            } else {
                info += balance.message || 'Sign in to the Factory console to view your balance.';
            }
        }
        if (balance.tokens) {
            info += `\n\nToken usage:\n`;
            info += `Used: ${balance.tokens.used || 0}\n`;
            info += `Limit: ${balance.tokens.limit || 0}\n`;
            info += `Remaining: ${balance.tokens.remaining || 0}`;
        }
    }

    return info;
}

// Query balances in bulk, optionally forcing a refresh
async function checkAllBalances(forceRefresh = false) {
    const message = forceRefresh
        ? 'A forced refresh queries the balance of every key again and may take a while. Continue?'
        : 'Load balance information from the cache? ';

    if (!confirm(message)) {
        return;
    }

    // Show loading feedback
    const btn = event.target;
    const originalText = btn.textContent;
    btn.textContent = forceRefresh ? '🔄 Refreshing...' : '📊 Loading...';
    btn.disabled = true;

    try {
        await fetchAllBalances(forceRefresh);

        // TODO: Background synchronization is not implemented yet
        // Trigger background synchronization on a forced refresh
        /*
        if (forceRefresh) {
            fetch('/factory/balance/sync', {
                method: 'POST',
                headers: {
                    'X-Admin-Key': adminKey
                }
            }).then(() => {
                console.log('Background synchronization triggered');
            });
        }
        */

        // alert('Balance query complete. Data updates automatically every 30 minutes.');
        alert('Balance queries are currently unavailable.');
    } catch (err) {
        alert('Bulk query failed: ' + err.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

// ===================== Factory token balance management (BaSui) =====================

// Initialize the full balance data shape to avoid incomplete-data warnings
let factoryBalanceData = {
    keys: {},     // Balances by key
    summary: {}   // Summary information
};
let countdownInterval = null;

// Format token counts (e.g. 20M/38M)
function formatTokens(tokens) {
    if (!tokens && tokens !== 0) return '-';
    if (tokens >= 1000000) {
        return `${(tokens / 1000000).toFixed(1)}M`;
    } else if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`;
    }
    return tokens.toString();
}

// Format numbers with thousands separators
function formatNumber(num) {
    if (!num && num !== 0) return '-';
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Refresh balance data through /admin/token/usage
async function refreshBalanceData(forceRefresh = false) {
    try {
        const url = forceRefresh 
            ? '/admin/token/limits?forceRefresh=true' 
            : '/admin/token/limits';
        
        const response = await fetch(url, {
            headers: {
                'x-admin-key': adminKey
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch balance data: ${response.status}`);
        }

        const result = await response.json();
        if (result.success) {
            // BaSui: Ensure the data shape is complete
            factoryBalanceData = {
                success: true,
                keys: result.keys || result.data?.keys || {},
                summary: result.summary || result.data?.summary || {}
            };
            updateBalanceDisplay();
            startCountdownTimer();

            // Show the balance overview section
            document.getElementById('balanceOverview').style.display = 'block';
        }
    } catch (err) {
        console.error('Failed to refresh balance data:', err);
        document.getElementById('limitsSummary').textContent = 'Limits refresh failed. Displayed data may be stale.';
        // Fail quietly without disrupting other features
    }
}

function limitWindowHtml(window, stale = false) {
    if (!window || !Number.isFinite(window.usedPercent) || window.usedPercent < 0) {
        return '<div class="limit-meter is-unknown"><strong>No data</strong><div class="limit-meter-empty" aria-hidden="true"></div><small>Awaiting Factory</small></div>';
    }
    const end = Date.parse(window.windowEnd);
    const resetDue = Number.isFinite(end) && end <= Date.now();
    const used = resetDue ? 0 : window.usedPercent;
    const value = Math.min(100, used);
    const uncertain = stale;
    const tone = uncertain ? 'is-unknown' : used >= 90 ? 'is-critical' : used >= 70 ? 'is-warning' : 'is-healthy';
    const reset = resetDue || window.awaitingStart || (!Number.isFinite(end) && used === 0)
        ? 'Starts with next use'
        : Number.isFinite(end) ? 'Resets ' + new Date(end).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Reset not reported';
    const label = `${used}% ${uncertain ? 'last reported' : 'used'}`;
    return `<div class="limit-meter ${tone}">
        <div class="limit-meter-heading"><strong>${used}%</strong><span>${uncertain ? 'last reported' : `${Math.max(0, 100 - used)}% left`}</span></div>
        <meter min="0" max="100" low="70" high="90" optimum="0" value="${value}" aria-label="${label}">${used}%</meter>
        <small>${escapeHtml(reset)}</small>
    </div>`;
}

function updateBalanceDisplay() {
    const entries = Object.entries(factoryBalanceData.keys || {});
    document.getElementById('limitsSummary').textContent = entries.length
        ? 'Updated automatically every minute. Unknown/stale data does not prove an account is exhausted.'
        : 'No keys configured.';
    document.getElementById('limitsRows').innerHTML = entries.flatMap(([id, key]) =>
        ['standard', 'core'].map(group => {
            const state = key[group];
            let status = key.status !== 'active' ? key.status : !key.tested ? 'Not tested'
                : !state.available ? 'Waiting until ' + new Date(state.retryAt).toLocaleString()
                : !state.known || state.stale ? 'Unknown; next request can check' : 'Available';
            if (state.extraUsage) status += ' — prepaid Extra Usage enabled';
            if (key.error) status += ' — limits refresh failed';
            return `<tr><td><code title="${escapeHtml(id)}">…${escapeHtml(id.slice(-9))}</code></td><td>${group === 'standard' ? 'Standard' : 'Droid Core'}</td>
                ${['fiveHour','weekly','monthly'].map(name => `<td>${limitWindowHtml(state.windows?.[name], state.stale)}</td>`).join('')}
                <td>${escapeHtml(status)}</td><td>${key.fetchedAt ? escapeHtml(new Date(key.fetchedAt).toLocaleString()) : 'Never'}</td></tr>`;
        })).join('');
    document.querySelectorAll('[data-key-limits]').forEach(cell => {
        const state = factoryBalanceData.keys?.[cell.dataset.keyLimits]?.standard;
        cell.innerHTML = state ? ['fiveHour','weekly','monthly'].map((name, i) =>
            `<div>${['5h','7d','30d'][i]}: ${limitWindowHtml(state.windows?.[name], state.stale)}</div>`).join('') : 'Unknown';
    });
}

function startCountdownTimer() {
    if (!countdownInterval) countdownInterval = setInterval(() => refreshBalanceData(false), 60000);
}

// Refresh balance data on page load via refreshData
async function refreshData(includeTokenUsage = false) {
    try {
        await fetchStats();
        await fetchKeys();
        
        // Refresh Factory balance data
        await refreshBalanceData(false);
        
        // Token usage statistics are optional
        if (includeTokenUsage) {
            try {
                await fetchTokenUsage();
            } catch (err) {
                console.error('Failed to fetch token usage:', err);
            }
        }
    } catch (err) {
        alert('Refresh failed: ' + err.message);
    }
}

// Clear timers when the page unloads
window.addEventListener('beforeunload', () => {
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }
});

console.log('Factory balance management loaded - BaSui');

// ===================== Seven-day usage trend chart (BaSui) =====================

/**
 * Fetch and render the seven-day usage line chart
 */
async function render7DaysTrendChart() {
    try {
        const response = await fetch('/admin/stats/trend?days=7', {
            headers: {
                'x-admin-key': adminKey
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch trend data: ${response.status}`);
        }

        const result = await response.json();
        if (!result.success || !result.data) {
            throw new Error('Invalid trend data format');
        }

        const trendData = result.data;

        // Get the canvas element
        const canvas = document.getElementById('tokenTrendCanvas');
        if (!canvas) {
            console.warn('Canvas element not found');
            return;
        }

        const ctx = canvas.getContext('2d');

        // Clear the previous chart
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Set canvas dimensions and padding
        const width = canvas.width;
        const height = canvas.height;
        const padding = { top: 20, right: 30, bottom: 40, left: 60 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;

        // Extract the data
        const dates = trendData.map(d => d.date_formatted);
        const tokens = trendData.map(d => d.tokens);
        const requests = trendData.map(d => d.requests);

        // Calculate maximum values
        const maxTokens = Math.max(...tokens, 100);  // At least 100
        const maxRequests = Math.max(...requests, 10);  // At least 10

        // Draw the background grid
        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 5; i++) {
            const y = padding.top + (chartHeight / 5) * i;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(padding.left + chartWidth, y);
            ctx.stroke();
        }

        // Draw Y-axis labels (token counts)
        ctx.fillStyle = '#6b7280';
        ctx.font = '12px Arial';
        ctx.textAlign = 'right';
        for (let i = 0; i <= 5; i++) {
            const value = Math.round((maxTokens / 5) * (5 - i));
            const y = padding.top + (chartHeight / 5) * i;
            ctx.fillText(formatTokenNumber(value), padding.left - 10, y + 4);
        }

        // Draw X-axis labels (dates)
        ctx.textAlign = 'center';
        dates.forEach((date, index) => {
            const x = padding.left + (chartWidth / (dates.length - 1)) * index;
            ctx.fillText(date, x, height - padding.bottom + 20);
        });

        // Draw the token trend line in blue
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

        // Draw token data points
        ctx.fillStyle = '#3b82f6';
        tokens.forEach((token, index) => {
            const x = padding.left + (chartWidth / (tokens.length - 1)) * index;
            const y = padding.top + chartHeight - (token / maxTokens) * chartHeight;
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, 2 * Math.PI);
            ctx.fill();
        });

        // Draw the legend
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(padding.left, 5, 15, 3);
        ctx.fillStyle = '#6b7280';
        ctx.font = '12px Arial';
        ctx.textAlign = 'left';
        ctx.fillText('Token usage', padding.left + 20, 10);

        console.log('✅ Seven-day usage trend chart rendered');
    } catch (error) {
        console.error('Failed to render the seven-day usage trend:', error);
        const canvas = document.getElementById('tokenTrendCanvas');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#ef4444';
            ctx.font = '14px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('Failed to load', canvas.width / 2, canvas.height / 2);
        }
    }
}

// ===================== Tab navigation (BaSui) =====================

/**
 * Switch tabs
 * @param {string} tabName - Tab name (dashboard/keys/config)
 */
function switchTab(tabName) {
    // Hide all tab content
    const allTabs = document.querySelectorAll('.tab-content');
    allTabs.forEach(tab => tab.classList.remove('active'));

    // Remove the active state from all tab buttons
    const allButtons = document.querySelectorAll('.tab-button');
    allButtons.forEach(btn => btn.classList.remove('active'));

    // Show the destination tab
    const targetTab = document.getElementById(`tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
    if (targetTab) {
        targetTab.classList.add('active');
    }

    // Activate the corresponding tab button
    const targetButton = event?.target || document.querySelector(`.tab-button[onclick*="${tabName}"]`);
    if (targetButton) {
        targetButton.classList.add('active');
    }

    // Load data for the selected tab
    if (tabName === 'dashboard') {
        // The dashboard loads all data
        refreshData(true);  // BaSui: Pass true to include token usage
        // BaSui: Render the seven-day usage trend
        render7DaysTrendChart();
    } else if (tabName === 'keys') {
        // The key management tab loads only the key list
        fetchKeys();
    } else if (tabName === 'config') {
        // The settings tab loads configuration data
        loadConfigData();
    }
}

// Store original settings to detect changes
let originalPort = 3000;
let originalRedisEnabled = false;
let originalClusterEnabled = false;

/**
 * Load configuration data into the settings form
 */
async function loadConfigData() {
    try {
        const response = await apiRequest('/config');
        const config = response.data;

        // Store the original configuration
        originalPort = config.port || 3000;
        originalRedisEnabled = config.redis?.enabled || false;
        originalClusterEnabled = config.cluster?.enabled || false;

        // General settings
        document.getElementById('configPort').value = config.port || 3000;
        document.getElementById('configUserAgent').value = config.user_agent || 'factory-cli/0.19.3';
        document.getElementById('configDevMode').checked = config.dev_mode || false;
        document.getElementById('configSystemPrompt').value = config.system_prompt || '';

        // Size limits
        document.getElementById('configNotesMaxLength').value = config.limits?.notes_max_length || 1000;
        document.getElementById('configMaxJsonLogSize').value = config.limits?.max_json_log_size || 5000;

        // Reasoning token budgets
        document.getElementById('configReasoningLow').value = config.reasoning_tokens?.low || 4096;
        document.getElementById('configReasoningMedium').value = config.reasoning_tokens?.medium || 12288;
        document.getElementById('configReasoningHigh').value = config.reasoning_tokens?.high || 24576;

        // Balance synchronization settings
        document.getElementById('configSyncInterval').value = config.balance_sync?.sync_interval_minutes || 30;
        document.getElementById('configSaveInterval').value = config.balance_sync?.save_interval_minutes || 5;

        // Key pool settings
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

        // Redis settings
        const redis = config.redis || {};
        document.getElementById('configRedisEnabled').checked = redis.enabled || false;
        document.getElementById('configRedisHost').value = redis.host || '127.0.0.1';
        document.getElementById('configRedisPort').value = redis.port || 6379;
        document.getElementById('configRedisPassword').value = redis.password || '';
        document.getElementById('configRedisDb').value = redis.db || 0;
        document.getElementById('configRedisKeyPrefix').value = redis.key_prefix || 'droid2api:';

        // Cluster settings
        const cluster = config.cluster || {};
        document.getElementById('configClusterEnabled').checked = cluster.enabled || false;
        document.getElementById('configClusterWorkers').value = cluster.workers || 0;
    } catch (err) {
        console.error('Failed to load configuration:', err);
        alert('❌ Failed to load configuration\n\n' + err.message);
    }
}

// BaSui: Extend authenticate to show the sign-out button after login
const originalAuthenticate = authenticate;
authenticate = function() {
    const key = document.getElementById('adminKeyInput').value.trim();
    if (!key) {
        alert('Enter your admin access key');
        return;
    }

    adminKey = key;

    fetchStats()
        .then(() => {
            localStorage.setItem(STORAGE_KEY_ADMIN, key);
            localStorage.setItem(STORAGE_KEY_LOGIN_TIME, Date.now().toString());

            document.getElementById('authSection').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            document.getElementById('logoutBtn').style.display = 'block';  // BaSui: Show the sign-out button
            
            // BaSui: Open the dashboard by default and load token usage
            switchTab('dashboard');
        })
        .catch(err => {
            alert('Authentication failed: ' + err.message);
            adminKey = '';
        });
};

// BaSui: Extend logout to hide the sign-out button
const originalLogout = logout;
logout = function() {
    if (!confirm('Sign out?')) return;

    localStorage.removeItem(STORAGE_KEY_ADMIN);
    localStorage.removeItem(STORAGE_KEY_LOGIN_TIME);
    adminKey = '';

    document.getElementById('authSection').style.display = 'flex';
    document.getElementById('mainContent').style.display = 'none';
    document.getElementById('logoutBtn').style.display = 'none';  // BaSui: Hide the sign-out button

    document.getElementById('adminKeyInput').value = '';
};

// BaSui: Extend autoAuthenticate to show the sign-out button on success
const originalAutoAuthenticate = autoAuthenticate;
autoAuthenticate = function() {
    const savedKey = localStorage.getItem(STORAGE_KEY_ADMIN);

    if (!savedKey) {
        return;
    }

    if (isLoginExpired()) {
        console.log('Session expired; clearing saved credentials');
        clearExpiredLogin();
        alert(`Your session expired after ${LOGIN_EXPIRE_HOURS} hour(s). Enter your admin access key again.`);
        return;
    }

    adminKey = savedKey;

    fetchStats()
        .then(() => {
            document.getElementById('authSection').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            document.getElementById('logoutBtn').style.display = 'block';  // BaSui: Show the sign-out button
            
            // BaSui: Open the dashboard by default and load token usage
            refreshData(true);  // BaSui: Pass true to load token usage and balances initially
        })
        .catch(err => {
            console.error('Automatic authentication failed:', err);
            clearExpiredLogin();
            alert('Your session has expired. Enter your admin access key again.');
        });
};

console.log('Tab navigation loaded - BaSui');

// ===================== Live logs (BaSui) =====================

// Global log state
let logEventSource = null;  // SSE connection
let logEntries = [];         // Log entry array
let logStats = {             // Log statistics
    total: 0,
    info: 0,
    warn: 0,
    error: 0,
    debug: 0
};

/**
 * Start or stop the live log stream
 */
function toggleLogStream() {
    if (logEventSource) {
        // Stop the log stream
        logEventSource.close();
        logEventSource = null;
        updateLogStreamStatus(false);
    } else {
        // Start the log stream
        startLogStream();
    }
}

/**
 * Start the SSE log stream
 */
function startLogStream() {
    try {
        // Get filter parameters
        const levels = getSelectedLogLevels();
        const keyword = document.getElementById('logSearchKeyword').value.trim();

        // Build the SSE URL
        let url = `/admin/logs/stream?`;
        if (levels.length > 0 && levels.length < 4) {
            url += `level=${levels.join(',')}&`;
        }
        if (keyword) {
            url += `keyword=${encodeURIComponent(keyword)}&`;
        }

        // Create the SSE connection
        logEventSource = new EventSource(url);

        // Listen for message events
        logEventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                // Handle historical log entries
                if (data.type === 'history') {
                    data.logs.forEach(log => addLogEntry(log, false));
                    scrollToBottomIfNeeded();
                } else {
                    // Live log entries
                    addLogEntry(data, true);
                }
            } catch (error) {
                console.error('Failed to parse SSE message:', error);
            }
        };

        // Listen for the connection opening
        logEventSource.onopen = () => {
            console.log('SSE log stream connected');
            updateLogStreamStatus(true);
        };

        // Listen for errors
        logEventSource.onerror = (error) => {
            console.error('SSE log stream error:', error);
            logEventSource.close();
            logEventSource = null;
            updateLogStreamStatus(false);
            alert('Could not connect to the log stream. Check your network connection or refresh the page and try again.');
        };

    } catch (error) {
        console.error('Failed to start log stream:', error);
        alert('Failed to start log stream: ' + error.message);
    }
}

/**
 * Update the log stream status display
 */
function updateLogStreamStatus(connected) {
    const statusBadge = document.getElementById('logStreamStatus');
    const toggleBtn = document.getElementById('logStreamToggle');

    if (connected) {
        statusBadge.textContent = 'Connected';
        statusBadge.className = 'log-status-badge connected';
        toggleBtn.textContent = '⏸️ Stop logs';
        toggleBtn.className = 'btn btn-danger';
    } else {
        statusBadge.textContent = 'Disconnected';
        statusBadge.className = 'log-status-badge disconnected';
        toggleBtn.textContent = '▶️ Start live logs';
        toggleBtn.className = 'btn btn-primary';
    }
}

/**
 * Add a log entry
 */
function addLogEntry(logEntry, scroll = true) {
    logEntries.push(logEntry);

    // Update statistics
    logStats.total++;
    logStats[logEntry.level] = (logStats[logEntry.level] || 0) + 1;
    updateLogStatsDisplay();

    // Render the log entry
    renderLogEntry(logEntry);

    // Scroll automatically
    if (scroll) {
        scrollToBottomIfNeeded();
    }
}

/**
 * Render a single log entry
 */
function renderLogEntry(logEntry) {
    const logList = document.getElementById('logList');

    // Remove the empty-state message
    const emptyMsg = logList.querySelector('.log-empty');
    if (emptyMsg) {
        emptyMsg.remove();
    }

    // Create the log entry DOM element
    const logDiv = document.createElement('div');
    logDiv.className = `log-entry log-level-${logEntry.level}`;
    logDiv.dataset.level = logEntry.level;
    logDiv.dataset.timestamp = logEntry.timestamp;

    // Log entry header
    const header = document.createElement('div');
    header.className = 'log-entry-header';

    // Timestamp
    const timestamp = document.createElement('span');
    timestamp.className = 'log-timestamp';
    timestamp.textContent = formatLogTimestamp(logEntry.timestamp);
    header.appendChild(timestamp);

    // Level badge
    const levelBadge = document.createElement('span');
    levelBadge.className = `log-level-badge ${logEntry.level}`;
    levelBadge.textContent = getLevelText(logEntry.level).toUpperCase();
    header.appendChild(levelBadge);

    // Type badge
    if (logEntry.type) {
        const typeBadge = document.createElement('span');
        typeBadge.className = 'log-type-badge';
        typeBadge.textContent = logEntry.type.toUpperCase();
        header.appendChild(typeBadge);
    }

    // HTTP method badge
    if (logEntry.method) {
        const methodBadge = document.createElement('span');
        methodBadge.className = `log-method-badge ${logEntry.method}`;
        methodBadge.textContent = logEntry.method;
        header.appendChild(methodBadge);
    }

    // Status code badge
    if (logEntry.statusCode) {
        const statusBadge = document.createElement('span');
        const statusClass = getStatusClass(logEntry.statusCode);
        statusBadge.className = `log-status-badge ${statusClass}`;
        statusBadge.textContent = logEntry.statusCode;
        header.appendChild(statusBadge);
    }

    // Response time label
    if (logEntry.duration) {
        const durationSpan = document.createElement('span');
        durationSpan.className = 'log-timestamp';
        durationSpan.textContent = `[${logEntry.duration}]`;
        header.appendChild(durationSpan);
    }

    logDiv.appendChild(header);

    // Log contents
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

    // Append to the DOM
    logList.appendChild(logDiv);

    // Limit displayed logs and promptly release DOM nodes and memory
    const maxLogs = 100;  // Reduced from 500 to 100
    if (logList.children.length > maxLogs) {
        // Delete old log entries in batches to reduce DOM operations
        const removeCount = logList.children.length - maxLogs + 10; // Delete 10 extra entries
        for (let i = 0; i < removeCount; i++) {
            const firstChild = logList.firstChild;
            if (firstChild) {
                logList.removeChild(firstChild);
            }
        }
    }
}

/**
 * Update displayed log statistics
 */
function updateLogStatsDisplay() {
    document.getElementById('logStatTotal').textContent = logStats.total;
    document.getElementById('logStatInfo').textContent = logStats.info || 0;
    document.getElementById('logStatWarn').textContent = logStats.warn || 0;
    document.getElementById('logStatError').textContent = logStats.error || 0;
}

/**
 * Clear the log display
 */
function clearLogDisplay() {
    if (!confirm('Clear all displayed logs?')) return;

    logEntries = [];
    logStats = { total: 0, info: 0, warn: 0, error: 0, debug: 0 };

    const logList = document.getElementById('logList');
    logList.innerHTML = '<div class="log-empty">Log display cleared</div>';

    updateLogStatsDisplay();
}

/**
 * Export logs to a file
 */
function exportLogs() {
    if (logEntries.length === 0) {
        alert('No logs to export');
        return;
    }

    try {
        // Build the log text
        let logText = `# droid2api Live log export\n`;
        logText += `# Exported at: ${new Date().toLocaleString('en-US')}\n`;
        logText += `# Total entries: ${logEntries.length}\n\n`;

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

        // Create the download
        const blob = new Blob([logText], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `droid2api_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        a.click();
        URL.revokeObjectURL(url);

        alert(`✅ Exported ${logEntries.length} log entries`);
    } catch (error) {
        console.error('Failed to export logs:', error);
        alert('Failed to export logs: ' + error.message);
    }
}

/**
 * Apply log filters
 */
function applyLogFilters() {
    const levels = getSelectedLogLevels();
    const keyword = document.getElementById('logSearchKeyword').value.trim().toLowerCase();

    const logList = document.getElementById('logList');
    const logDivs = logList.querySelectorAll('.log-entry');

    logDivs.forEach(logDiv => {
        const level = logDiv.dataset.level;
        const text = logDiv.textContent.toLowerCase();

        // Filter by level
        const levelMatch = levels.length === 0 || levels.includes(level);

        // Filter by keyword
        const keywordMatch = !keyword || text.includes(keyword);

        // Show or hide
        logDiv.style.display = (levelMatch && keywordMatch) ? 'block' : 'none';
    });
}

/**
 * Get the selected log levels
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
 * Scroll to the bottom when enabled
 */
function scrollToBottomIfNeeded() {
    if (document.getElementById('logAutoScroll').checked) {
        const logContainer = document.querySelector('.log-display-container');
        logContainer.scrollTop = logContainer.scrollHeight;
    }
}

/**
 * Format a log timestamp
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
 * Get the log level label
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
 * Get the CSS class for a status code
 */
function getStatusClass(statusCode) {
    if (statusCode >= 500) return 'status-5xx';
    if (statusCode >= 400) return 'status-4xx';
    if (statusCode >= 300) return 'status-3xx';
    if (statusCode >= 200) return 'status-2xx';
    return '';
}

// Close the SSE connection when the page unloads
window.addEventListener('beforeunload', () => {
    if (logEventSource) {
        logEventSource.close();
    }
});

console.log('✅ Live logs loaded - BaSui');

// ============================================
// BaSui: Quickly move a single key to another pool
// ============================================
// This feature now lives in pool-groups.js to avoid duplicate declarations
// - let currentChangePoolKeyId (declared in pool-groups.js:5)
// - function showChangePoolModal (implemented in pool-groups.js:273)
// - async function changeKeyPool (implemented in pool-groups.js:283)

