const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const http = require('http');
const test = require('node:test');

const {
  createServer,
  enforceRateLimit,
  resetRateLimits,
  validateProxyPayload,
} = require('./server');
const {
  buildRedeemPayload,
  canRedeemCard,
  getCardKeyFromUrl,
  getCardStatus,
  isPlausibleKey,
  maskKey,
  normalizeKey,
  parseSessionJsonValue,
} = require('./app');

const TEST_CARD_KEY = 'Plus-AAAAAAAAAAAAAAAA';
const SECOND_TEST_CARD_KEY = 'Pro5x-BBBBBBBBBBBBBBBB';

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
    cardKey: TEST_CARD_KEY,
  }), null);
  assert.equal(validateProxyPayload('/api/v1/cardkey/batch-status', {
    cardKeys: [TEST_CARD_KEY, SECOND_TEST_CARD_KEY],
  }), null);
  assert.equal(validateProxyPayload('/api/v1/redeem', {
    cardKey: TEST_CARD_KEY,
    accountSession: JSON.stringify({ account: { id: 'user-abc' } }),
    confirmOverride: false,
  }), null);
});

test('product-prefixed card keys are normalized and old card keys are rejected', () => {
  assert.equal(normalizeKey(' Plus-aaaaaaaaaaaaaaaa '), TEST_CARD_KEY);
  assert.equal(normalizeKey('Pro5x-bbbbbbbbbbbbbbbb'), SECOND_TEST_CARD_KEY);
  assert.equal(isPlausibleKey(TEST_CARD_KEY), true);
  assert.equal(isPlausibleKey(SECOND_TEST_CARD_KEY), true);
  assert.equal(isPlausibleKey('AAAAAAAAAAAAAAAA'), false);
  assert.equal(isPlausibleKey('PlusAAAAAAAAAAAAAAAA'), false);
  assert.equal(maskKey(TEST_CARD_KEY), 'Plus-•••• •••• •••• AAAA');
  assert.equal(maskKey(SECOND_TEST_CARD_KEY), 'Pro5x-•••• •••• •••• BBBB');
  assert.match(validateProxyPayload('/api/v1/verify-cardkey', {
    cardKey: 'AAAAAAAAAAAAAAAA',
  }), /cardKey/);
});

test('card links prefill only valid product-prefixed card keys', () => {
  assert.equal(getCardKeyFromUrl('?card=Plus-aaaaaaaaaaaaaaaa'), TEST_CARD_KEY);
  assert.equal(getCardKeyFromUrl('?source=customer&card=Pro5x-bbbbbbbbbbbbbbbb'), SECOND_TEST_CARD_KEY);
  assert.equal(getCardKeyFromUrl('?card=AAAAAAAAAAAAAAAA'), '');
  assert.equal(getCardKeyFromUrl('?card=invalid'), '');
  assert.equal(getCardKeyFromUrl(''), '');
});

test('Session JSON parser identifies the recharge account before submission', () => {
  const parsed = parseSessionJsonValue(JSON.stringify({
    user: { email: 'member@example.com' },
    account: { id: 'user-abc' },
  }));
  assert.equal(parsed.accountLabel, 'member@example.com');
  assert.equal(JSON.parse(parsed.accountSession).account.id, 'user-abc');
  const withoutEmail = parseSessionJsonValue(JSON.stringify({ account: { id: 'user-abc' } }));
  assert.equal(withoutEmail.accountLabel, 'user-abc');

  const changedInput = parseSessionJsonValue(JSON.stringify({
    user: { email: 'other@example.com' },
    account: { id: 'user-other' },
  }));
  const payload = buildRedeemPayload(TEST_CARD_KEY, parsed, false);
  assert.equal(JSON.parse(payload.accountSession).user.email, 'member@example.com');
  assert.notEqual(payload.accountSession, changedInput.accountSession);
});

test('jzai16888 status extensions preserve redeem and batch behavior', () => {
  assert.equal(canRedeemCard({ valid: true, status: 0 }), true);
  assert.equal(canRedeemCard({ valid: false, status: 1 }), false);
  assert.equal(canRedeemCard({ valid: false, status: 3 }), false);
  assert.equal(canRedeemCard({ valid: false, status: 4 }), true);
  assert.equal(getCardStatus({ status: -1, statusDesc: '不存在' }).kind, 'missing');
  assert.equal(getCardStatus({ status: 1, statusDesc: '已锁定' }).kind, 'used');
  assert.equal(getCardStatus({ status: 2, statusDesc: '已消费' }).kind, 'used');
  assert.deepEqual(getCardStatus({ status: 3, statusDesc: '排队中' }), {
    kind: 'queued',
    label: '排队中',
  });
  assert.deepEqual(getCardStatus({ status: 4, statusDesc: '充值失败，可重新提交' }), {
    kind: 'retry',
    label: '充值失败，可重新提交',
  });
});

test('proxy rejects malformed and unsupported input before upstream forwarding', () => {
  assert.match(validateProxyPayload('/api/v1/verify-cardkey', { cardKey: 'bad' }), /cardKey/);
  assert.match(validateProxyPayload('/api/v1/cardkey/batch-status', { cardKeys: [] }), /1–100/);
  assert.match(validateProxyPayload('/api/v1/redeem', {
    cardKey: TEST_CARD_KEY,
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
  assert.match(wrongMethod.headers['content-security-policy'], /https:\/\/jzai16888\.com/);
  assert.doesNotMatch(wrongMethod.headers['content-security-policy'], /jzgopay/);

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
  const additionalMalformed = await request(server, {
    path: '/api-proxy/redeem',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(additionalMalformed.status, 400);
  assert.equal(enforceRateLimit({ socket: { remoteAddress: '127.0.0.1' } }, {}, '/api-proxy/redeem'), true);

  for (let index = 6; index < 30; index += 1) {
    const malformed = await request(server, {
      path: '/api-proxy/redeem',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
  }
  const rawLimited = await request(server, {
    path: '/api-proxy/redeem',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(rawLimited.status, 429);
});

test('startup reports an occupied port as an error', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: __dirname,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(server.address().port),
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /端口 \d+ 已被占用/);
});
