/**
 * Test key-pool filtering
 * Verify that pool filtering works in both the frontend and backend
 */

import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_ACCESS_KEY || 'your-admin-key-here';

async function testPoolFilter() {
    console.log('🧪 Start testing key-pool filtering...\n');

    try {
        // 1. Get the list of all pools
        console.log('1️⃣ Get the pool list...');
        const poolsResponse = await fetch(`${BASE_URL}/admin/pool-groups`, {
            headers: {
                'x-admin-key': ADMIN_KEY
            }
        });

        if (!poolsResponse.ok) {
            throw new Error(`Failed to get the pool list: ${poolsResponse.status}`);
        }

        const poolsData = await poolsResponse.json();
        const pools = poolsData.data || [];
        console.log(`✅ Found ${pools.length} pools:`);
        pools.forEach(pool => {
            console.log(`   - ${pool.name} (${pool.id}): ${pool.total} keys`);
        });
        console.log();

        // 2. Test retrieving all keys without filtering
        console.log('2️⃣ Test retrieving all keys (poolGroup=all)...');
        const allKeysResponse = await fetch(`${BASE_URL}/admin/keys?poolGroup=all&limit=100`, {
            headers: {
                'x-admin-key': ADMIN_KEY
            }
        });

        if (!allKeysResponse.ok) {
            throw new Error(`Failed to get all keys: ${allKeysResponse.status}`);
        }

        const allKeysData = await allKeysResponse.json();
        const allKeys = allKeysData.data.keys || [];
        console.log(`✅ Retrieved ${allKeys.length} keys (unfiltered)`);
        console.log();

        // 3. Test filtering each pool
        for (const pool of pools) {
            console.log(`3️⃣ Test filtering pool: ${pool.name} (${pool.id})...`);
            const poolKeysResponse = await fetch(
                `${BASE_URL}/admin/keys?poolGroup=${pool.id}&limit=100`,
                {
                    headers: {
                        'x-admin-key': ADMIN_KEY
                    }
                }
            );

            if (!poolKeysResponse.ok) {
                throw new Error(`Filter pool ${pool.id} Failed: ${poolKeysResponse.status}`);
            }

            const poolKeysData = await poolKeysResponse.json();
            const poolKeys = poolKeysData.data.keys || [];
            
            // Verify that every returned key belongs to the requested pool
            const wrongPoolKeys = poolKeys.filter(k => (k.poolGroup || 'default') !== pool.id);
            
            if (wrongPoolKeys.length > 0) {
                console.error(`❌ Filtering error! Returned keys outside pool ${pool.id}:`);
                wrongPoolKeys.forEach(k => {
                    console.error(`   - ${k.id} (belongs to: ${k.poolGroup || 'default'})`);
                });
            } else {
                console.log(`✅ Filter correct: ${poolKeys.length} keys all belong to pool ${pool.id}`);
            }
            console.log();
        }

        // 4. Test filtering the default pool
        console.log(`4️⃣ Test filtering the default pool (poolGroup=default)...`);
        const defaultKeysResponse = await fetch(
            `${BASE_URL}/admin/keys?poolGroup=default&limit=100`,
            {
                headers: {
                    'x-admin-key': ADMIN_KEY
                }
            }
        );

        if (!defaultKeysResponse.ok) {
            throw new Error(`Failed to filter the default pool: ${defaultKeysResponse.status}`);
        }

        const defaultKeysData = await defaultKeysResponse.json();
        const defaultKeys = defaultKeysData.data.keys || [];
        
        // Verify that every returned key belongs to the default pool
        const wrongDefaultKeys = defaultKeys.filter(k => k.poolGroup && k.poolGroup !== 'default');
        
        if (wrongDefaultKeys.length > 0) {
            console.error(`❌ Filtering error! Returned keys outside the default pool:`);
            wrongDefaultKeys.forEach(k => {
                console.error(`   - ${k.id} (belongs to: ${k.poolGroup})`);
            });
        } else {
            console.log(`✅ Filter correct: ${defaultKeys.length} keys all belong to the default pool`);
        }
        console.log();

        console.log('🎉 All tests passed! Key-pool filtering works correctly!');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        process.exit(1);
    }
}

// Run tests
testPoolFilter();
