const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createPartnerApi, tokenHash } = require('./partner-api');

test('partner API enforces partner access and persists idempotency across handlers', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-partner-test-'));
  const configFile = path.join(dir, 'config.json');
  const secret = 'test-only-secret-abcdefghijklmnopqrstuvwxyz';
  const key = 'test_key_abcdefghijklmnopqrstuvwxyz123456789';
  const secondKey = 'second_key_abcdefghijklmnopqrstuvwxyz123456';
  const card = 'TIM-ABCDEFGHIJK';
  const card2 = 'TIM5X-ABCDEFGHIJK';
  const env = { PARTNER_API_ENABLED: '1', PARTNER_DATA_DIR: dir, PARTNER_CONFIG_FILE: configFile, PARTNER_HASH_SECRET: secret };
  const config = { partners: [
    { id: 'alice', enabled: true, channels: ['advanced'], key_hashes: [tokenHash(key)] },
    { id: 'bob', enabled: true, channels: ['advanced'], key_hashes: [tokenHash(secondKey)] },
  ] };
  fs.writeFileSync(configFile, JSON.stringify(config));
  let redemptions = 0;
  let calls = 0;
  let eligible = true;
  const invoke = async (channel, name) => {
    calls++;
    if (name === 'check-subscription') return { ok: true, summary: { can_redeem: eligible, is_team: false } };
    if (name === 'create-task') { redemptions++; throw new Error('Timeout containing sensitive data'); }
    if (name === 'verify-cdk') return { valid: true, plan_type: 'plus' };
    if (name === 'lookup/tasks') return { tasks: [{ cdk_code: card, task_status: 'completed', account_email: 'private@example.invalid' }] };
    if (name === 'queue-status') return { stock: { plus: 99, plus_year: 0, pro5x: 3, pro20x: 10 } };
  };
  const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  let handler = createPartnerApi({ invoke, send, env });
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
  assert.equal((await request('/cards/verify', { channel: 'regular', card: 'REGULAR-CARD' })).status, 403);
  assert.equal((await request('/cards/verify', { channel: 'advanced', card: 'TIM20X-ABCDEFGHIJK' })).status, 200);
  assert.equal(calls, 1);
  const pair = await Promise.all([request('/recharges', payload), request('/recharges', payload)]);
  assert.equal(redemptions, 1);
  assert.ok(pair.every(r => r.data.status === 'unconfirmed'));
  handler = createPartnerApi({ invoke, send, env });
  assert.equal((await request('/recharges', payload)).data.replayed, true);
  assert.equal(redemptions, 1);
  assert.equal((await request('/recharges', { ...payload, session: '{"test":"different"}' })).status, 409);
  assert.equal((await request('/recharges', { ...payload, request_id: 'other_order' })).data.code, 'card_submission_exists');
  assert.equal((await request('/recharges', { ...payload, request_id: 'other_order' })).data.code, 'card_submission_exists');
  assert.equal((await request('/recharges', { ...payload, request_id: 'bob_order_01' }, secondKey)).data.code, 'card_submission_exists');
  assert.equal(redemptions, 1);
  const result = await request('/recharges/query', { channel: 'advanced', card });
  assert.equal(result.data.results[0].status, 'success');
  assert.equal(JSON.stringify(result).includes('private@'), false);
  assert.deepEqual((await request('/stock')).data.stock, { plus: 'high', plus_year: 'none', pro5x: 'low', pro20x: 'medium' });
  eligible = false;
  assert.equal((await request('/recharges', { ...payload, card: card2, request_id: 'rejected_123' })).data.status, 'rejected');
  assert.equal(redemptions, 1);
  for (const name of fs.readdirSync(dir).filter(n => n !== 'config.json')) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.equal(text.includes('SESSION_SECRET'), false);
    assert.equal(text.includes(card), false);
    assert.equal(text.includes(key), false);
  }
  assert.ok(fs.readdirSync(dir).filter(n => n.startsWith('request-') || n.startsWith('card-')).some(name => fs.readFileSync(path.join(dir, name), 'utf8').includes('"partner_id":"alice"')));
  config.partners[0].enabled = false;
  fs.writeFileSync(configFile, JSON.stringify(config));
  assert.equal((await request('/cards/verify', { channel: 'advanced', card })).status, 401);
  config.partners[0].enabled = true;
  config.partners[0].requests_per_minute = 1;
  fs.writeFileSync(configFile, JSON.stringify(config));
  handler = createPartnerApi({ invoke, send, env });
  assert.equal((await request('/cards/verify', { channel: 'advanced', card })).status, 200);
  assert.equal((await request('/cards/verify', { channel: 'advanced', card })).status, 429);
  handler = createPartnerApi({ invoke, send, env });
  assert.equal((await request('/cards/verify?card=secret', { channel: 'advanced', card })).status, 400);
  assert.equal((await request('/recharges')).status, 405);
  env.PARTNER_API_ENABLED = '0';
  assert.equal((await request('/stock')).status, 404);
});
