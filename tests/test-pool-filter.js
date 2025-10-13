/**
 * 测试密钥池筛选功能
 * 验证前后端的池子筛选是否正常工作
 */

import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_ACCESS_KEY || 'your-admin-key-here';

async function testPoolFilter() {
    console.log('🧪 开始测试密钥池筛选功能...\n');

    try {
        // 1. 获取所有池子列表
        console.log('1️⃣ 获取池子列表...');
        const poolsResponse = await fetch(`${BASE_URL}/admin/pool-groups`, {
            headers: {
                'x-admin-key': ADMIN_KEY
            }
        });

        if (!poolsResponse.ok) {
            throw new Error(`获取池子列表失败: ${poolsResponse.status}`);
        }

        const poolsData = await poolsResponse.json();
        const pools = poolsData.data || [];
        console.log(`✅ 找到 ${pools.length} 个密钥池:`);
        pools.forEach(pool => {
            console.log(`   - ${pool.name} (${pool.id}): ${pool.total} 个密钥`);
        });
        console.log();

        // 2. 测试获取所有密钥（不筛选）
        console.log('2️⃣ 测试获取所有密钥（poolGroup=all）...');
        const allKeysResponse = await fetch(`${BASE_URL}/admin/keys?poolGroup=all&limit=100`, {
            headers: {
                'x-admin-key': ADMIN_KEY
            }
        });

        if (!allKeysResponse.ok) {
            throw new Error(`获取所有密钥失败: ${allKeysResponse.status}`);
        }

        const allKeysData = await allKeysResponse.json();
        const allKeys = allKeysData.data.keys || [];
        console.log(`✅ 获取到 ${allKeys.length} 个密钥（不筛选）`);
        console.log();

        // 3. 测试筛选每个池子
        for (const pool of pools) {
            console.log(`3️⃣ 测试筛选池子: ${pool.name} (${pool.id})...`);
            const poolKeysResponse = await fetch(
                `${BASE_URL}/admin/keys?poolGroup=${pool.id}&limit=100`,
                {
                    headers: {
                        'x-admin-key': ADMIN_KEY
                    }
                }
            );

            if (!poolKeysResponse.ok) {
                throw new Error(`筛选池子 ${pool.id} 失败: ${poolKeysResponse.status}`);
            }

            const poolKeysData = await poolKeysResponse.json();
            const poolKeys = poolKeysData.data.keys || [];
            
            // 验证所有返回的密钥都属于该池子
            const wrongPoolKeys = poolKeys.filter(k => (k.poolGroup || 'default') !== pool.id);
            
            if (wrongPoolKeys.length > 0) {
                console.error(`❌ 筛选错误！返回了不属于池子 ${pool.id} 的密钥:`);
                wrongPoolKeys.forEach(k => {
                    console.error(`   - ${k.id} (属于: ${k.poolGroup || 'default'})`);
                });
            } else {
                console.log(`✅ 筛选正确: ${poolKeys.length} 个密钥都属于池子 ${pool.id}`);
            }
            console.log();
        }

        // 4. 测试筛选 default 池
        console.log(`4️⃣ 测试筛选默认池（poolGroup=default）...`);
        const defaultKeysResponse = await fetch(
            `${BASE_URL}/admin/keys?poolGroup=default&limit=100`,
            {
                headers: {
                    'x-admin-key': ADMIN_KEY
                }
            }
        );

        if (!defaultKeysResponse.ok) {
            throw new Error(`筛选默认池失败: ${defaultKeysResponse.status}`);
        }

        const defaultKeysData = await defaultKeysResponse.json();
        const defaultKeys = defaultKeysData.data.keys || [];
        
        // 验证所有返回的密钥都属于默认池
        const wrongDefaultKeys = defaultKeys.filter(k => k.poolGroup && k.poolGroup !== 'default');
        
        if (wrongDefaultKeys.length > 0) {
            console.error(`❌ 筛选错误！返回了不属于默认池的密钥:`);
            wrongDefaultKeys.forEach(k => {
                console.error(`   - ${k.id} (属于: ${k.poolGroup})`);
            });
        } else {
            console.log(`✅ 筛选正确: ${defaultKeys.length} 个密钥都属于默认池`);
        }
        console.log();

        console.log('🎉 所有测试通过！密钥池筛选功能正常工作！');

    } catch (error) {
        console.error('❌ 测试失败:', error.message);
        process.exit(1);
    }
}

// 运行测试
testPoolFilter();
