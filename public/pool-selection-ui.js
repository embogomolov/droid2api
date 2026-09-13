/**
 * 🎯 Key pool selection UI module
 * BaSui: Manage all UI interactions related to key pool selection.
 * Let users choose the destination pool for keys and the pools to export or test.
 */

// ===== 🎯 Populate pool options in dropdown menus =====

/**
 * Load pool options into the specified select element
 * @param {string} selectId - ID of the select element
 * @param {boolean} includeDefault - Whether to include the "Default pool" option
 */
async function loadPoolGroupOptions(selectId, includeDefault = true) {
    try {
        const select = document.getElementById(selectId);
        if (!select) return;

        // Clear existing options, retaining the default pool option if requested
        if (includeDefault) {
            select.innerHTML = '<option value="">Default pool (default)</option>';
        } else {
            select.innerHTML = '';
        }

        // Fetch the list of key pools
        const response = await apiRequest('/pool-groups');
        const poolGroups = response.data || [];

        // Add pool options
        poolGroups.forEach(pool => {
            const option = document.createElement('option');
            option.value = pool.id;
            option.textContent = `${pool.name} (${pool.id})`;
            select.appendChild(option);
        });

        console.log(`✅ Loaded ${poolGroups.length} pool options into #${selectId}`);
    } catch (error) {
        console.error(`❌ Failed to load pool options (#${selectId}):`, error);
    }
}

/**
 * Initialize pool options in all dropdown menus
 * BaSui: Call on page load to populate all pool selectors.
 */
async function initializeAllPoolSelects() {
    // Load pool options for the Add key dialog
    await loadPoolGroupOptions('newKeyPoolGroup', true);

    // Load pool options for the Bulk import dialog
    await loadPoolGroupOptions('batchImportPoolGroup', true);

    // Load pool options for the Export keys dialog (multiple selection)
    await loadPoolGroupOptions('exportPoolGroup', true);

    // Load pool options for the Bulk test dialog
    await loadPoolGroupOptions('testPoolGroup', true);

    // Load pool options for the Change pool dialog
    await loadPoolGroupOptions('changePoolSelect', false);

    // Populate the key management pool filter, including an All pools option
    const poolFilterSelect = document.getElementById('poolGroupFilter');
    if (poolFilterSelect) {
        try {
            // Start with the default All pools option
            poolFilterSelect.innerHTML = '<option value="all">All pools</option>';

            // Fetch the list of key pools
            const response = await apiRequest('/pool-groups');
            const poolGroups = response.data || [];

            // Add an option for each pool
            poolGroups.forEach(pool => {
                const option = document.createElement('option');
                option.value = pool.id;
                option.textContent = `${pool.name} (${pool.id})`;
                poolFilterSelect.appendChild(option);
            });

            console.log(`✅ Loaded ${poolGroups.length} pool options into the key pool filter`);
        } catch (error) {
            console.error('❌ Failed to load the pool filter:', error);
        }
    }

    console.log('🎉 All pool selectors loaded.');
}

// ===== 📥 Key export =====

/**
 * Show the Export keys dialog
 * BaSui: Show an options dialog instead of exporting immediately.
 */
function showExportKeysModal() {
    // Refresh pool options
    loadPoolGroupOptions('exportPoolGroup', true);

    // Show the dialog
    showModal('exportKeysModal');
}

/**
 * Toggle the All pools option
 */
function toggleExportAllPools() {
    const allPoolsChecked = document.getElementById('exportAllPools').checked;
    const poolOptions = document.getElementById('exportPoolOptions');

    if (allPoolsChecked) {
        poolOptions.style.display = 'none';
    } else {
        poolOptions.style.display = 'block';
    }
}

/**
 * Confirm key export
 */
async function confirmExportKeys() {
    try {
        // Read the selected options
        const exportAll = document.getElementById('exportAllPools').checked;
        const format = document.querySelector('input[name="exportFormat"]:checked').value;
        const status = document.getElementById('exportStatusFilter').value;

        let poolGroups = [];
        if (!exportAll) {
            // Get the selected pools
            const select = document.getElementById('exportPoolGroup');
            poolGroups = Array.from(select.selectedOptions).map(opt => opt.value);

            if (poolGroups.length === 0) {
                alert('Select at least one pool.');
                return;
            }
        }

        // Build the export URL
        let url = `/admin/keys/export?status=${status}&format=${format}`;
        if (!exportAll && poolGroups.length > 0) {
            url += `&poolGroups=${poolGroups.join(',')}`;
        }

        // Send the request
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'x-admin-key': adminKey
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `HTTP ${response.status}`);
        }

        // Get the filename
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = 'keys_export.json';
        if (contentDisposition) {
            const match = contentDisposition.match(/filename="?(.+)"?/);
            if (match) filename = match[1];
        }

        // Download the file
        const blob = await response.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(downloadUrl);

        // Close the dialog
        closeModal('exportKeysModal');

        alert(`✅ Export complete. Filename: ${filename}`);
    } catch (error) {
        console.error('❌ Export failed:', error);
        alert(`Export failed: ${error.message}`);
    }
}

// ===== 🧪 Bulk key testing =====

/**
 * Show the Bulk test dialog
 * BaSui: Show an options dialog instead of testing immediately.
 */
function showBatchTestModal() {
    // Refresh pool options
    loadPoolGroupOptions('testPoolGroup', true);

    // Clear previous test results
    document.getElementById('testResult').innerHTML = '';

    // Show the dialog
    showModal('batchTestModal');
}

/**
 * Toggle pool selection for testing
 */
function toggleTestPoolOptions() {
    const testSpecific = document.querySelector('input[name="testPool"][value="specific"]').checked;
    const poolOptions = document.getElementById('testPoolOptions');

    if (testSpecific) {
        poolOptions.style.display = 'block';
    } else {
        poolOptions.style.display = 'none';
    }
}

// Listen for radio button changes
document.addEventListener('DOMContentLoaded', () => {
    const testPoolRadios = document.querySelectorAll('input[name="testPool"]');
    testPoolRadios.forEach(radio => {
        radio.addEventListener('change', toggleTestPoolOptions);
    });
});

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

        // Show a loading indicator
        const resultDiv = document.getElementById('testResult');
        resultDiv.innerHTML = '<div class="loading">🧪 Testing keys, please wait...</div>';

        // Send the test request
        let url = `/admin/keys/test-all?concurrency=${concurrency}`;
        if (poolGroup) {
            url += `&poolGroup=${poolGroup}`;
        }

        const response = await apiRequest(url, 'POST');
        const data = response.data;

        // Show test results
        let message = '<div class="result-summary success">';
        message += '<h3>🎉 Bulk test complete</h3>';
        message += `<p>📊 Total keys: ${data.total}</p>`;
        message += `<p>🔍 Tested: ${data.tested}</p>`;
        message += `<p>✅ Passed: ${data.success}</p>`;
        message += `<p>❌ Failed: ${data.failed}</p>`;
        message += `<p>🚫 Automatically blocked in proxy: ${data.banned}</p>`;

        if (data.banned > 0) {
            message += '<p class="hint">💡 Keys with no remaining credit have been automatically blocked in this proxy.</p>';
        }

        message += '</div>';

        resultDiv.innerHTML = message;

        // BaSui: Refresh the list automatically to show the latest test results
        if (autoRefresh) {
            setTimeout(() => {
                if (typeof refreshData === 'function') {
                    refreshData();
                } else if (typeof fetchKeys === 'function') {
                    fetchKeys();
                    fetchStats();  // Also refresh statistics
                }
                closeModal('batchTestModal');
            }, 2000);
        }
    } catch (error) {
        console.error('❌ Bulk test failed:', error);
        const resultDiv = document.getElementById('testResult');
        resultDiv.innerHTML = `<div class="result-summary error">❌ Test failed: ${error.message}</div>`;
    }
}

// ===== 📤 Extended bulk import functionality =====

/**
 * Show the Bulk import dialog
 * BaSui: Extended version with pool selection.
 */
function showBatchImportModal() {
    // Refresh pool options
    loadPoolGroupOptions('batchImportPoolGroup', true);

    // Clear the input and previous results
    document.getElementById('batchKeysInput').value = '';
    document.getElementById('importResult').innerHTML = '';

    // Show the dialog
    showModal('batchImportModal');
}

/**
 * Bulk key import with pool selection and optional testing
 * BaSui: Optionally test imported keys and block them in the proxy on HTTP 402.
 */
async function batchImport() {
    const keysText = document.getElementById('batchKeysInput').value.trim();
    const poolGroup = document.getElementById('batchImportPoolGroup').value;
    const autoTest = document.getElementById('autoTestKeys').checked; // BaSui: Read the automatic testing option

    if (!keysText) {
        alert('Enter a key or list of keys.');
        return;
    }

    const keys = keysText.split('\n').map(k => k.trim()).filter(k => k);

    try {
        const response = await apiRequest('/keys/batch', 'POST', {
            keys,
            poolGroup: poolGroup || undefined,  // Pass undefined when the selection is an empty string
            autoTest: autoTest  // BaSui: Pass the automatic testing option
        });
        const result = response.data;

        // BaSui: Support both response formats; the newer format contains import and test fields
        const importResult = result.import || result;
        const testResult = result.test;

        const resultDiv = document.getElementById('importResult');

        // Determine the display status from the import results
        let statusClass = 'success';
        let statusEmoji = '✅';
        let summaryText = '';

        if (importResult.success > 0) {
            statusClass = 'success';
            statusEmoji = '✅';
            summaryText = `Successfully imported ${importResult.success} keys.`;
        } else if (importResult.duplicate > 0 && importResult.invalid === 0) {
            statusClass = 'warning';
            statusEmoji = '🔄';
            summaryText = `All keys already exist (${importResult.duplicate} duplicates).`;
        } else if (importResult.invalid > 0) {
            statusClass = 'error';
            statusEmoji = '❌';
            summaryText = `Import failed: ${importResult.invalid} invalid keys.`;
        } else {
            statusClass = 'error';
            statusEmoji = '❌';
            summaryText = 'Import failed';
        }

        // BaSui: Build the import results HTML
        let resultHTML = `
            <div class="result-summary ${statusClass}">
                <h3>${statusEmoji} ${summaryText}</h3>
                <p>📊 Total: ${keys.length}</p>
                <p>✅ Successful: ${importResult.success}</p>
                <p>🔄 Duplicates: ${importResult.duplicate}</p>
                <p>❌ Invalid: ${importResult.invalid}</p>
                ${poolGroup ? `<p>🎯 Destination pool: ${poolGroup}</p>` : ''}
        `;

        // BaSui: Show test statistics if testing was performed
        if (testResult && testResult.tested > 0) {
            const testStatusClass = testResult.success === testResult.tested ? 'success' : 
                                   testResult.banned > 0 ? 'warning' : 'error';
            resultHTML += `
                <hr style="margin: 10px 0; border: 1px solid #ddd;">
                <h4>🧪 Automatic test results</h4>
                <p>🔍 Tested: ${testResult.tested}</p>
                <p>✅ Successful: ${testResult.success}</p>
                <p>❌ Failed: ${testResult.failed}</p>
                ${testResult.banned > 0 ? `<p>🚫 Blocked in proxy: ${testResult.banned} (HTTP 402)</p>` : ''}
            `;
        }

        resultHTML += `</div>`;
        resultDiv.innerHTML = resultHTML;

        // BaSui: Refresh the list after two seconds if any keys were imported or tested
        if (importResult.success > 0 || (testResult && testResult.tested > 0)) {
            setTimeout(() => {
                // BaSui: Check whether refreshData is available (defined in app.js)
                if (typeof refreshData === 'function') {
                    refreshData();
                } else if (typeof fetchKeys === 'function') {
                    // If refreshData is unavailable, refresh at least the key list
                    fetchKeys();
                } else {
                    // Final fallback: reload the page
                    location.reload();
                }
            }, 2000);
        }
    } catch (err) {
        const resultDiv = document.getElementById('importResult');
        resultDiv.innerHTML = `
            <div class="result-summary error">
                <h3>❌ Import failed</h3>
                <p>${err.message}</p>
            </div>
        `;
    }
}

/**
 * Show the Add key dialog
 * BaSui: Extended version with pool selection.
 */
function showAddKeyModal() {
    // Refresh pool options
    loadPoolGroupOptions('newKeyPoolGroup', true);

    // Clear the input fields
    document.getElementById('newKeyInput').value = '';
    document.getElementById('newKeyNotes').value = '';

    // Show the dialog
    showModal('addKeyModal');
}

/**
 * Add a key with pool selection
 */
async function addKey() {
    const key = document.getElementById('newKeyInput').value.trim();
    const notes = document.getElementById('newKeyNotes').value.trim();
    const poolGroup = document.getElementById('newKeyPoolGroup').value;

    if (!key) {
        alert('Enter a key or list of keys.');
        return;
    }

    if (!key.startsWith('fk-')) {
        alert('Invalid key format: keys must start with fk-.');
        return;
    }

    try {
        await apiRequest('/keys', 'POST', {
            key,
            notes,
            poolGroup: poolGroup || undefined
        });
        alert('✅ Key added successfully.');
        closeModal('addKeyModal');
        // BaSui: Refresh the list to show the newly added key
        if (typeof refreshData === 'function') {
            refreshData();
        } else if (typeof fetchKeys === 'function') {
            fetchKeys();
        }
    } catch (err) {
        alert('❌ Failed to add key: ' + err.message);
    }
}

// ===== 🚀 Initialize on page load =====
window.addEventListener('load', () => {
    // Wait one second to allow authentication to complete before loading
    setTimeout(() => {
        initializeAllPoolSelects();
    }, 1000);
});

console.log('🎯 Key pool selection UI module loaded.');
