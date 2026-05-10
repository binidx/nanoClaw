import fs from 'fs';

const envContent = fs.readFileSync('.env', 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) env[m[1]] = m[2].trim();
}

const BASE_URL = env.ANTHROPIC_BASE_URL;
const TOKEN = env.ANTHROPIC_AUTH_TOKEN;
const MODEL = env.ANTHROPIC_MODEL;

console.log(`BASE_URL: ${BASE_URL}`);
console.log(`MODEL: ${MODEL}`);
console.log(`TOKEN: ***${TOKEN?.slice(-4)}`);

// Test with full error details
async function test(name, url, body, headers = {}) {
  console.log(`\n--- ${name} ---`);
  console.log(`URL: ${url}`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
    console.log(`Status: ${res.status}`);
    const text = await res.text();
    console.log(`Body: ${text.slice(0, 800)}`);
  } catch (err) {
    console.log(`Error: ${err.message}`);
    if (err.cause) console.log(`Cause: ${err.cause.message || JSON.stringify(err.cause)}`);
  }
}

await test(
  'Anthropic /v1/messages',
  `${BASE_URL}/v1/messages`,
  {
    model: MODEL,
    max_tokens: 50,
    messages: [{ role: 'user', content: 'hi' }],
  },
  { 'anthropic-version': '2023-06-01', 'x-api-key': TOKEN }
);

await test(
  'OpenAI /v1/chat/completions',
  `${BASE_URL}/v1/chat/completions`,
  {
    model: MODEL,
    max_tokens: 50,
    messages: [{ role: 'user', content: 'hi' }],
  }
);
