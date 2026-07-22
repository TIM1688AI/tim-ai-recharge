const assert = require('node:assert/strict');
const http = require('http');
const test = require('node:test');

const {
  createServer,
  resetRateLimits,
  validateProxyPayload,
} = require('./server');

function request(server, { path = '/', method = 'GET', headers = {}, body = '' } = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers: {
        ...headers,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

test('proxy payload validation preserves documented requests', () => {
  assert.equal(validateProxyPayload('/api/v1/verify-cardkey', {
    cardKey: 'AAAAAAAAAAAAAAAA',
  }), null);
  assert.equal(validateProxyPayload('/api/v1/cardkey/batch-status', {
    cardKeys: ['AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB'],
  }), null);
  assert.equal(validateProxyPayload('/api/v1/redeem', {
    cardKey: 'AAAAAAAAAAAAAAAA',
    accountSession: JSON.stringify({ account: { id: 'user-abc' } }),
    confirmOverride: false,
  }), null);
});

test('proxy rejects malformed and unsupported input before upstream forwarding', () => {
  assert.match(validateProxyPayload('/api/v1/verify-cardkey', { cardKey: 'bad' }), /cardKey/);
  assert.match(validateProxyPayload('/api/v1/cardkey/batch-status', { cardKeys: [] }), /1–100/);
  assert.match(validateProxyPayload('/api/v1/redeem', {
    cardKey: 'AAAAAAAAAAAAAAAA',
    accountSession: JSON.stringify({ account: {} }),
    confirmOverride: false,
  }), /account\.id/);
});

test('HTTP boundary enforces methods, JSON content type, validation, and rate limits', async (t) => {
  resetRateLimits();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const wrongMethod = await request(server, { path: '/api-proxy/verify-cardkey' });
  assert.equal(wrongMethod.status, 405);

  const wrongType = await request(server, {
    path: '/api-proxy/verify-cardkey',
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(wrongType.status, 415);

  const invalidPayload = await request(server, {
    path: '/api-proxy/verify-cardkey',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cardKey: 'bad' }),
  });
  assert.equal(invalidPayload.status, 400);

  resetRateLimits();
  for (let index = 0; index < 5; index += 1) {
    const malformed = await request(server, {
      path: '/api-proxy/redeem',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
  }
  const limited = await request(server, {
    path: '/api-proxy/redeem',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(limited.status, 429);
  assert.equal(JSON.parse(limited.body).code, 42900);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
});
