import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3000';
const API_KEY = process.env.API_ACCESS_KEY || 'your-access-key';

async function testGPT5() {
  console.log('测试 GPT-5 模型映射...\n');
  
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-5-2025-08-07',
      messages: [
        { role: 'user', content: '测试' }
      ],
      max_tokens: 10
    })
  });
  
  console.log('响应状态:', response.status);
  
  const data = await response.json();
  console.log('\n响应数据:');
  console.log(JSON.stringify(data, null, 2));
}

testGPT5().catch(console.error);
