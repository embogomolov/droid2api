import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3000';
const API_KEY = process.env.API_ACCESS_KEY || 'your-access-key';

async function testBasicChat() {
  console.log('Send request...');
  
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      messages: [
        { role: 'user', content: 'Hello' }
      ],
      max_tokens: 50
    })
  });
  
  console.log('Response status:', response.status);
  console.log('Response headers:', Object.fromEntries(response.headers.entries()));
  
  const data = await response.json();
  console.log('\nResponse data:');
  console.log(JSON.stringify(data, null, 2));
}

testBasicChat().catch(console.error);
