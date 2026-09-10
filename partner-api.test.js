const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createPartnerApi, createRedisStore, tokenHash } = require('./partner-api');

function createMemoryStore() {
  const values = new Map();
  const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
  return {
    values,
    async create(key, value) { if (values.has(key)) return false; values.set(key, copy(value)); return true; },
    async get(key) { return copy(values.get(key)); },
    async set(key, value) { values.set(key, copy(value)); },
    async delete(key) { values.delete(key); },
  };
}

test('partner API enforces partner access and persists idempotency across handlers', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-partner-test-'));
  const configFile = path.join(dir, 'config.json');
  const secret = 'test-only-secret-abcdefghijklmnopqrstuvwxyz';
  const key = 'test_key_abcdefghijklmnopqrstuvwxyz123456789';
  const secondKey = 'second_key_abcdefghijklmnopqrstuvwxyz123456';
  const card = 'TIM-ABCDEFGHIJK';
  const card2 = 'TIM5X-ABCDEFGHIJK';
  const regularCard = 'REGULAR-ABCDEFGHIJ';
  const env = { PARTNER_API_ENABLED: '1', PARTNER_CONFIG_FILE: configFile, PARTNER_HASH_SECRET: secret };
  const store = createMemoryStore();
  const config = { partners: [
    { id: 'alice', enabled: true, channels: ['regular', 'advanced'], key_hashes: [tokenHash(key)] },
    { id: 'bob', enabled: true, channels: ['advanced'], key_hashes: [tokenHash(secondKey)] },
  ] };
  fs.writeFileSync(configFile, JSON.stringify(config));
  let redemptions = 0;
  let calls = 0;
  let eligible = true;
  const invoke = async (channel, name) => {
    calls++;
    if (name === 'status') return { ok: true };
    if (name === 'announcement') return { enabled: true, title: 'Notice', message: 'Service available', ignored: 'private' };
    if (name === 'check-subscription') return { ok: true, summary: { account_email: 'account@example.invalid', plan_type: channel === 'regular' ? 'free' : 'plus', has_active_subscription: channel !== 'regular', can_redeem: eligible, is_team: false, expires_at: '2026-12-31T00:00:00Z' } };
    if (name === 'create-task') { redemptions++; throw new Error('Timeout containing sensitive data'); }
    if (name === 'verify-cdk') return { valid: true, plan_type: 'plus' };
    if (name === 'refresh-cdk') return { new_code: 'REGULAR-NEW-CARD', message: 'Changed' };
    if (name === 'cancel-task') return { ok: true, message: 'Cancelled' };
    if (name === 'lookup/tasks') return { tasks: [{ cdk_code: card, task_status: 'completed', account_email: 'private@example.invalid' }] };
    if (name === 'queue-status') return channel === 'regular' ? { pending_count: 2, at: '2026-09-10T00:00:00Z' } : { stock: { plus: 99, plus_year: 0, pro5x: 3, pro20x: 10 } };
  };
  const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  let handler = createPartnerApi({ invoke, send, env, store });
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, 'http://local').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  });
  const base = `http://127.0.0.1:${server.address().port}/partner-api/v1`;
  async function request(endpoint, payload, token = key) {
    const res = await fetch(base + endpoint, { method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
    return { status: res.status, data: await res.json() };
  }
  const payload = { channel: 'advanced', card, session: '{"test":"SESSION_SECRET"}', confirmed: true, request_id: 'order_123456' };
  assert.equal((await request('/cards/verify', { channel: 'advanced', card }, 'wrong')).status, 401);
  assert.equal((await request('/cards/verify', { channel: 'regular', card: 'REGULAR-CARD' }, secondKey)).status, 403);
  assert.equal((await request('/cards/verify', { channel: 'advanced', card: 'TIM20X-ABCDEFGHIJK' })).status, 200);
  assert.equal(calls, 1);
  assert.deepEqual((await request('/service/status', { channel: 'advanced' })).data, { ok: true, available: true, channel: 'advanced' });
  assert.deepEqual((await request('/announcements/current', { channel: 'advanced' })).data, { ok: true, enabled: true, title: 'Notice', message: 'Service available' });
  const subscription = await request('/subscriptions/check', { channel: 'advanced', session: '{"test":"SESSION_SECRET"}' });
  assert.equal(subscription.data.email, 'account@example.invalid');
  assert.equal(subscription.data.expires_at, '2026-12-31T00:00:00Z');
  assert.equal(subscription.data.can_redeem, true);
  const queue = await request('/queue/status', { channel: 'advanced' });
  assert.equal(queue.data.kind, 'stock');
  assert.deepEqual(queue.data.stock, { plus: 'high', plus_year: 'none', pro5x: 'low', pro20x: 'medium' });
  assert.deepEqual((await request('/queue/status', { channel: 'regular' })).data, { ok: true, kind: 'queue', pending_count: 2, updated_at: '2026-09-10T00:00:00Z' });
  const refreshed = await request('/cards/refresh', { channel: 'regular', card: regularCard, request_id: 'refresh_0001', confirmed: true });
  assert.equal(refreshed.data.new_card, 'REGULAR-NEW-CARD');
  assert.equal((await request('/cards/refresh', { channel: 'regular', card: regularCard, request_id: 'refresh_0001', confirmed: true })).data.new_card, 'REGULAR-NEW-CARD');
  assert.equal((await request('/cards/refresh', { channel: 'advanced', card, request_id: 'refresh_0002', confirmed: true })).data.code, 'operation_not_supported');
  assert.equal((await request('/tasks/cancel', { channel: 'regular', card: 'REGULAR-CANCEL-CARD', request_id: 'cancel_0001', confirmed: true })).data.cancelled, true);
  const pair = await Promise.all([request('/recharges', payload), request('/recharges', payload)]);
  assert.equal(redemptions, 1);
  assert.ok(pair.every(r => r.data.status === 'unconfirmed'));
  handler = createPartnerApi({ invoke, send, env, store });
  assert.equal((await request('/recharges', payload)).data.replayed, true);
  assert.equal(redemptions, 1);
  assert.equal((await request('/recharges', { ...payload, session: '{"test":"different"}' })).status, 409);
  assert.equal((await request('/recharges', { ...payload, request_id: 'other_order' })).data.code, 'card_submission_exists');
  assert.equal((await request('/recharges', { ...payload, request_id: 'other_order' })).data.code, 'card_submission_exists');
  assert.equal((await request('/recharges', { ...payload, request_id: 'bob_order_01' }, secondKey)).data.code, 'card_submission_exists');
  assert.equal(redemptions, 1);
  const result = await request('/recharges/query', { channel: 'advanced', card });
  assert.equal(result.data.results[0].status, 'success');
  assert.equal((await request('/tasks/query', { channel: 'advanced', card })).data.results[0].status, 'success');
  const regularBatch = Array.from({ length: 100 }, (_, index) => `REGULAR-${String(index).padStart(11, '0')}`);
  assert.equal((await request('/tasks/batch-query', { channel: 'regular', cards: regularBatch })).status, 200);
  const advancedBatch = Array.from({ length: 51 }, (_, index) => `TIM-${String(index).padStart(11, '0')}`);
  assert.equal((await request('/tasks/batch-query', { channel: 'advanced', cards: advancedBatch })).data.code, 'invalid_card_count');
  assert.equal(JSON.stringify(result).includes('private@'), false);
  assert.deepEqual((await request('/stock')).data.stock, { plus: 'high', plus_year: 'none', pro5x: 'low', pro20x: 'medium' });
  eligible = false;
  assert.equal((await request('/recharges', { ...payload, card: card2, request_id: 'rejected_123' })).data.status, 'rejected');
  assert.equal(redemptions, 1);
  const stored = JSON.stringify([...store.values.entries()]);
  assert.equal(stored.includes('SESSION_SECRET'), false);
  assert.equal(stored.includes(card), false);
  assert.equal(stored.includes(key), false);
  assert.equal(stored.includes('REGULAR-NEW-CARD'), false);
  assert.equal(stored.includes('"partner_id":"alice"'), true);
  config.partners[0].enabled = false;
  fs.writeFileSync(configFile, JSON.stringify(config));
  assert.equal((await request('/cards/verify', { channel: 'advanced', card })).status, 401);
  config.partners[0].enabled = true;
  config.partners[0].requests_per_minute = 1;
  fs.writeFileSync(configFile, JSON.stringify(config));
  handler = createPartnerApi({ invoke, send, env, store });
  assert.equal((await request('/cards/verify', { channel: 'advanced', card })).status, 200);
  assert.equal((await request('/cards/verify', { channel: 'advanced', card })).status, 429);
  handler = createPartnerApi({ invoke, send, env, store });
  assert.equal((await request('/cards/verify?card=secret', { channel: 'advanced', card })).status, 400);
  assert.equal((await request('/recharges')).status, 405);
  env.PARTNER_API_ENABLED = '0';
  assert.equal((await request('/stock')).status, 404);
});

test('Upstash REST store uses authenticated atomic writes and durable reads', async () => {
  const values = new Map();
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const [command, key, value, condition] = JSON.parse(options.body);
    let result = null;
    if (command === 'SET' && condition === 'NX') {
      if (!values.has(key)) { values.set(key, value); result = 'OK'; }
    } else if (command === 'SET') {
      values.set(key, value); result = 'OK';
    } else if (command === 'GET') result = values.get(key) ?? null;
    else if (command === 'DEL') { result = values.delete(key) ? 1 : 0; }
    return { ok: true, json: async () => ({ result }) };
  };
  const store = createRedisStore({
    UPSTASH_REDIS_REST_URL: 'https://example.upstash.io/',
    UPSTASH_REDIS_REST_TOKEN: 'test_token_abcdefghijklmnopqrstuvwxyz',
  }, fetchImpl);
  assert.equal(await store.create('request:one', { status: 'new' }), true);
  assert.equal(await store.create('request:one', { status: 'duplicate' }), false);
  assert.deepEqual(await store.get('request:one'), { status: 'new' });
  await store.set('result:one', { status: 'success' });
  assert.deepEqual(await store.get('result:one'), { status: 'success' });
  await store.delete('result:one');
  assert.equal(await store.get('result:one'), null);
  assert.ok(requests.every(item => item.url === 'https://example.upstash.io' && item.options.headers.Authorization.startsWith('Bearer ')));
  assert.ok([...values.keys()].every(key => key.startsWith('tim-partner:v1:')));
});

test('Upstash REST store rejects unsafe configuration and fails closed', async () => {
  assert.throws(() => createRedisStore({}), error => error.code === 'configuration_required');
  assert.throws(() => createRedisStore({
    UPSTASH_REDIS_REST_URL: 'http://example.invalid',
    UPSTASH_REDIS_REST_TOKEN: 'test_token_abcdefghijklmnopqrstuvwxyz',
  }), error => error.code === 'configuration_required');
  const store = createRedisStore({
    UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'test_token_abcdefghijklmnopqrstuvwxyz',
  }, async () => ({ ok: false, json: async () => ({}) }));
  await assert.rejects(store.create('request:one', {}), error => error.code === 'storage_unavailable');
});
