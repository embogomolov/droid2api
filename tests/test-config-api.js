/**
 * Test the configuration API
 * Usage: node tests/test-config-api.js
 */

const ADMIN_KEY = process.env.ADMIN_ACCESS_KEY || 'your-admin-key-here';
const API_BASE = 'http://localhost:3000/admin';

async function apiRequest(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'x-admin-key': ADMIN_KEY,
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${endpoint}`, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`API Error: ${data.error || data.message || 'Unknown error'}`);
  }

  return data;
}

async function testGetConfig() {
  console.log('\n📖 Test: GET /admin/config');
  try {
    const result = await apiRequest('/config');
    console.log('✅ Configuration retrieved successfully');
    console.log('Configuration content:', JSON.stringify(result.data, null, 2).slice(0, 500) + '...');
    return result.data;
  } catch (err) {
    console.error('❌ Failed:', err.message);
    throw err;
  }
}

async function testUpdateConfig(config) {
  console.log('\n📝 Test: PUT /admin/config (Update part of the configuration)');
  try {
    // Update only port and dev_mode
    const updates = {
      port: config.port, // Keep the original value
      dev_mode: !config.dev_mode // Toggle the value
    };

    console.log('Updated values:', updates);
    const result = await apiRequest('/config', 'PUT', updates);
    console.log('✅ Configuration updated successfully');
    console.log('Returned result:', JSON.stringify(result, null, 2).slice(0, 300) + '...');
    return result.data;
  } catch (err) {
    console.error('❌ Failed:', err.message);
    throw err;
  }
}

async function testUpdateFullConfig(originalConfig) {
  console.log('\n📝 Test: PUT /admin/config (Update the entire configuration)');
  try {
    // Restore the original configuration
    const result = await apiRequest('/config', 'PUT', originalConfig);
    console.log('✅ Original configuration restored successfully');
    return result.data;
  } catch (err) {
    console.error('❌ Failed:', err.message);
    throw err;
  }
}

async function testGetKeyPoolConfig() {
  console.log('\n📖 Test: GET /admin/config/key-pool');
  try {
    const result = await apiRequest('/config/key-pool');
    console.log('✅ Key-pool configuration retrieved successfully');
    console.log('Key-pool configuration:', JSON.stringify(result.data, null, 2));
    return result.data;
  } catch (err) {
    console.error('❌ Failed:', err.message);
    throw err;
  }
}

async function main() {
  console.log('🚀 Start configuration API tests');
  console.log('=' . repeat(60));

  try {
    // 1. Read the current configuration
    const originalConfig = await testGetConfig();

    // 2. Test partial configuration updates
    await testUpdateConfig(originalConfig);

    // 3. Restore the original configuration
    await testUpdateFullConfig(originalConfig);

    // 4. Test retrieving the key-pool configuration
    await testGetKeyPoolConfig();

    console.log('\n' + '='.repeat(60));
    console.log('✅ All tests passed!');
  } catch (err) {
    console.log('\n' + '='.repeat(60));
    console.error('❌ Test failed:', err.message);
    process.exit(1);
  }
}

main();
