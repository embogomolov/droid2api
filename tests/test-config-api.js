/**
 * 测试配置管理 API
 * 用法: node tests/test-config-api.js
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
  console.log('\n📖 测试: GET /admin/config');
  try {
    const result = await apiRequest('/config');
    console.log('✅ 成功获取配置');
    console.log('配置内容:', JSON.stringify(result.data, null, 2).slice(0, 500) + '...');
    return result.data;
  } catch (err) {
    console.error('❌ 失败:', err.message);
    throw err;
  }
}

async function testUpdateConfig(config) {
  console.log('\n📝 测试: PUT /admin/config (更新部分配置)');
  try {
    // 只更新 port 和 dev_mode
    const updates = {
      port: config.port, // 保持原值
      dev_mode: !config.dev_mode // 切换值
    };

    console.log('更新内容:', updates);
    const result = await apiRequest('/config', 'PUT', updates);
    console.log('✅ 成功更新配置');
    console.log('返回结果:', JSON.stringify(result, null, 2).slice(0, 300) + '...');
    return result.data;
  } catch (err) {
    console.error('❌ 失败:', err.message);
    throw err;
  }
}

async function testUpdateFullConfig(originalConfig) {
  console.log('\n📝 测试: PUT /admin/config (更新完整配置)');
  try {
    // 恢复原始配置
    const result = await apiRequest('/config', 'PUT', originalConfig);
    console.log('✅ 成功恢复原始配置');
    return result.data;
  } catch (err) {
    console.error('❌ 失败:', err.message);
    throw err;
  }
}

async function testGetKeyPoolConfig() {
  console.log('\n📖 测试: GET /admin/config/key-pool');
  try {
    const result = await apiRequest('/config/key-pool');
    console.log('✅ 成功获取密钥池配置');
    console.log('密钥池配置:', JSON.stringify(result.data, null, 2));
    return result.data;
  } catch (err) {
    console.error('❌ 失败:', err.message);
    throw err;
  }
}

async function main() {
  console.log('🚀 开始测试配置管理 API');
  console.log('=' . repeat(60));

  try {
    // 1. 读取当前配置
    const originalConfig = await testGetConfig();

    // 2. 测试更新部分配置
    await testUpdateConfig(originalConfig);

    // 3. 恢复原始配置
    await testUpdateFullConfig(originalConfig);

    // 4. 测试获取密钥池配置
    await testGetKeyPoolConfig();

    console.log('\n' + '='.repeat(60));
    console.log('✅ 所有测试通过！');
  } catch (err) {
    console.log('\n' + '='.repeat(60));
    console.error('❌ 测试失败:', err.message);
    process.exit(1);
  }
}

main();
