import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3000';
const API_KEY = process.env.API_ACCESS_KEY || 'your-access-key';

async function testBasicChat() {
  console.log('发送请求...');
  
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      messages: [
        { role: 'user', content: '你好' }
      ],
      max_tokens: 50
    })
  });
  
  console.log('响应状态:', response.status);
  console.log('响应头:', Object.fromEntries(response.headers.entries()));
  
  const data = await response.json();
  console.log('\n响应数据:');
  console.log(JSON.stringify(data, null, 2));
}

testBasicChat().catch(console.error);
