'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { PREFIXES, card, productFromPlan } = require('./card-catalog');
const { vault, passwordHash, checkPassword, totp, totpCounter, config } = require('./workbench-security');
const { createWorkbench, identityFor, stateOf, parseLines, csv } = require('./workbench');
const { createServer } = require('./server');

// PostgreSQL engine in WASM, not a mock SQL parser. The mutex emulates one pooled
// connection. Production multi-connection locking needs TEST_DATABASE_URL below.
async function database() {
  if (process.env.TEST_DATABASE_URL) {
    const { Pool } = require('pg');
    const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = 'wb_test_' + crypto.randomBytes(12).toString('hex');
    await owner.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: '-c search_path=' + schema });
    await pool.query(fs.readFileSync(require.resolve('./workbench-schema.sql'), 'utf8'));
    return { pool, close: async () => { await pool.end(); if (!/^wb_test_[a-f0-9]{24}$/.test(schema)) throw new Error('Invalid test schema'); await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); } };
  }
  const db = new PGlite(); await db.exec(fs.readFileSync(require.resolve('./workbench-schema.sql'), 'utf8'));
  let tail = Promise.resolve();
  async function lock() { const previous = tail; let release; tail = new Promise(r => { release = r; }); await previous; return release; }
  async function query(sql, values) { const r = await db.query(sql, values); return { ...r, rowCount: r.affectedRows || r.rows.length }; }
  const pool = { async query(sql, values) { const release = await lock(); try { return await query(sql, values); } finally { release(); } }, async connect() { const release = await lock(); return { query, release }; } };
  return { pool, close: () => db.close() };
}
test('all TIM conversions round-trip and reject wrong product, length, raw public input and LZ', () => {
  for (const [channel, product, original, alias, length] of PREFIXES) {
    const suffix = 'A'.repeat(length || 16);
    const raw = card(channel, original + suffix, { raw: true, product });
    assert.equal(raw.public, alias + suffix); assert.equal(raw.supplier, original + suffix);
    assert.deepEqual(card(channel, raw.public, { raw: true, product }), raw);
    assert.throws(() => card(channel, original + suffix));
    assert.throws(() => card(channel, alias + suffix, { product: 'nonexistent' }));
  }
  assert.throws(() => card('advanced', 'JZ-ABC', { raw: true }));
  assert.throws(() => card('advanced', 'LZ-ABCDEFGHIJK', { raw: true }));
  assert.throws(() => card('premium', 'TIMG-PLUS-lowercasesuffix'));
  assert.equal(card('advanced', 'G6EPDV4Y7CJQCUKP').product, 'plus_year');
  assert.equal(card('regular', 'MixedCase-12345', { product: 'plus' }).public, 'MixedCase-12345');
  assert.equal(productFromPlan('Claude Max 20X'), 'claude_max20');
  assert.equal(productFromPlan('Claude Max 5X Special'), 'claude_max5_special');
  assert.equal(productFromPlan('ChatGPT Pro 5X Special'), 'pro5_special');
  assert.equal(productFromPlan('unknown provider product'), '');
});
test('encryption, password verification, RFC TOTP vector, input safety and conservative statuses', async () => {
  const v = vault(crypto.randomBytes(32)), secret = v.seal({ card: 'sensitive-card' });
  assert(!secret.includes('sensitive-card')); assert.equal(v.open(secret).card, 'sensitive-card');
  assert.throws(() => vault(crypto.randomBytes(32)).open(secret));
  const hash = await passwordHash('test only password'); assert(await checkPassword('test only password', hash)); assert(!await checkPassword('wrong', hash));
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1), '287082');
  assert.equal(totpCounter('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '287082', 59000), 1);
  assert.throws(() => config({ ADMIN_DATA_KEY: 'bad' }));
  assert.deepEqual(parseLines('\ufeffcard\n"TIM-ABCDEFGHIJK"\n'), ['TIM-ABCDEFGHIJK']);
  assert(csv([['=HYPERLINK("evil")']]).includes("'=HYPERLINK"));
  assert.equal(stateOf({ task_status: 'not_found' }).state, 'unknown');
  assert.equal(stateOf({ task_status: 'used' }).state, 'unknown');
  const who = identityFor('regular', { session_json: JSON.stringify({ accessToken: 'do-not-store', sessionToken: 'do-not-store', account: { id: 'example-id' }, user: { email: 'test@example.invalid' } }) });
  assert.deepEqual(Object.keys(who), ['account_id','email']);
});
test('workbench HTTP, SQL inventory, issue atomicity, deduplication, recovery and no secret persistence', async t => {
  const db = await database(); t.after(db.close);
  const otpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const env = { ADMIN_ENABLED: '1', DATABASE_URL: 'test-only', ADMIN_DATA_KEY: crypto.randomBytes(32).toString('base64'), ADMIN_PASSWORD_HASH: await passwordHash('test administrator password'), ADMIN_TOTP_SECRET: otpSecret, ADMIN_ORIGIN: 'http://127.0.0.1' };
  let redeemed = 0, unknown = false;
  const tasks = new Map();
  const invoke = async (channel, name, payload) => {
    if (name === 'verify-cdk') { const c = card(channel, payload.cdk_code, { product: channel === 'regular' ? 'plus' : undefined }); return { valid: true, plan_type: c.product === 'plus_year' ? 'plus_year' : c.product, redeem_type: c.product.startsWith('claude_') ? 'claude_org_id' : 'chatgpt_account_id' }; }
    if (name === 'check-subscription') return { ok: true, summary: { is_team: false, can_redeem: true, plan_type: 'free' } };
    if (name === 'lookup/tasks') return { tasks: payload.codes.map(code => ({ cdk_code: code, task_status: tasks.get(code) || (channel === 'premium' ? 'not_found' : 'active'), task_id: tasks.has(code) ? 'mock-task' : '' })) };
    if (name === 'create-task') { redeemed++; tasks.set(payload.cdk_code, unknown ? 'pending' : 'completed'); if (unknown) throw new Error('TEST_TIMEOUT'); return { task_status: 'completed', task_id: 'mock-task' }; }
    throw new Error('Unexpected operation');
  };
  const server = createServer({ env, pool: db.pool, invoke });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '', csrf = '';
  async function req(route, p, options = {}) {
    const r = await fetch(base + '/admin-api/v1' + route, { method: p === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: env.ADMIN_ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...options }, body: p === undefined ? undefined : JSON.stringify(p) });
    return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie') };
  }
  assert.equal((await req('/inventory')).status, 401);
  let login = await req('/login', { password: 'test administrator password', otp: totp(otpSecret, Math.floor(Date.now() / 30000)) });
  assert.equal(login.status, 200); assert.match(login.cookie, /HttpOnly; SameSite=Strict/); cookie = login.cookie.split(';')[0]; csrf = login.data.csrf;
  assert.equal((await req('/login', { password: 'test administrator password', otp: totp(otpSecret, Math.floor(Date.now() / 30000)) })).status, 401);
  assert.equal((await req('/inventory/import', {}, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await req('/inventory/import', {}, { 'X-CSRF-Token': 'bad' })).status, 403);
  const batch = { channel: 'premium', product: 'plus', text: 'PLUS-AAAAAAAAAAAAAAAA\nTIMG-PLUS-AAAAAAAAAAAAAAAA\nPRO5-BBBBBBBBBBBBBBBB\nPLUS-CCCCCCCCCCCCCCCC\nPLUS-DDDDDDDDDDDDDDDD\nPLUS-EEEEEEEEEEEEEEEE' };
  const preview = await req('/inventory/preview', batch); assert.equal(preview.data.filter(r => r.valid).length, 4);
  const imported = await req('/inventory/import', batch); assert.equal(imported.data.filter(r => r.ok).length, 4);
  assert.equal((await req('/inventory/import', { ...batch, text: 'TIMG-PLUS-AAAAAAAAAAAAAAAA' })).data[0].ok, false);
  for (const r of (await req('/inventory')).data.rows) assert.equal((await req('/inventory/verify', { id: r.id })).status, 200);
  const issueKey = crypto.randomUUID();
  const [one, two] = await Promise.all([req('/issue', { channel: 'premium', product: 'plus', quantity: 1, request_id: issueKey }), req('/issue', { channel: 'premium', product: 'plus', quantity: 1, request_id: issueKey })]);
  assert.equal(one.status, 200); assert.equal(one.data.id, two.data.id);
  const issued = (await req('/batch/download', { id: one.data.id })).data.text; assert.match(issued, /^TIMG-PLUS-/);
  const target = '123e4567-e89b-12d3-a456-426614174000';
  const p = { channel: 'premium', product: 'plus', account_id: target, account_confirm: target, email: 'test@example.invalid', confirmed: true, request_id: crypto.randomUUID() };
  const [a, b] = await Promise.all([req('/recharge', p), req('/recharge', p)]);
  assert.equal(a.status, 200); assert.equal(a.data.id, b.data.id); assert.equal(redeemed, 1);
  assert.equal((await req('/recharge', { ...p, email: 'other@example.invalid' })).status, 409);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM wb_cards WHERE state='issued'")).rows[0].n, 1);
  const known = (await db.pool.query("SELECT secret FROM wb_cards WHERE state='available' LIMIT 1")).rows[0];
  const knownCode = vault(Buffer.from(env.ADMIN_DATA_KEY, 'base64')).open(known.secret).public;
  const proxy = await fetch(base + '/api-proxy/premium/create-task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cdk_code: knownCode, account_id: target, account_confirm: target }) });
  assert.equal(proxy.status, 409); assert.equal(redeemed, 1);
  unknown = true;
  const uncertain = await req('/recharge', { ...p, request_id: crypto.randomUUID() }); assert.equal(uncertain.data.state, 'unknown'); assert.equal(redeemed, 2);
  assert.equal((await req('/recharge', { ...p, request_id: crypto.randomUUID() })).status, 409); assert.equal(redeemed, 2);
  const restarted = createWorkbench({ env, pool: db.pool, invoke, send() {} }); t.after(() => restarted.close());
  const recovered = await restarted.queryOrder(uncertain.data.id); assert.equal(recovered.state, 'processing'); assert.equal(redeemed, 2);
  const held = (await db.pool.query('SELECT * FROM wb_cards WHERE id=$1', [recovered.card_id])).rows[0]; assert.equal(held.state, 'reserved');
  assert.equal((await req('/inventory/verify', { id: held.id, release_confirmed: true })).status, 409);
  const columns = (await db.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('wb_orders','wb_cards')")).rows.map(r => r.column_name); assert(!columns.includes('session_json'));
  const dump = JSON.stringify((await db.pool.query('SELECT * FROM wb_orders')).rows); assert(!dump.includes(target)); assert(!dump.includes('test@example.invalid'));
  const d = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const orders = await req('/orders', { from: d, to: d }); assert.equal(orders.status, 200); assert(!JSON.stringify(orders.data).includes(target));
  const detail = await req('/orders/detail', { id: a.data.id }); assert.equal(detail.data.account_id, target);
  const exported = await req('/orders/export', { from: d, to: d }); assert(exported.data.csv.includes(target));
  assert.equal((await req('/stats')).status, 200);
  // Every provider uses its existing payload, without persisting session tokens.
  unknown = false;
  for (const [channel, raw] of [['advanced', 'JZ-ABCDEFGHIJK'], ['regular', 'RegularTest-123456']]) {
    const imported = await req('/inventory/import', { channel, product: 'plus', text: raw });
    assert.equal(imported.status, 200); const cardId = imported.data[0].id;
    assert.equal((await req('/inventory/verify', { id: cardId })).status, 200);
    const recharge = await req('/recharge', { channel, product: 'plus', session_json: JSON.stringify({ account: { id: target }, user: { email: 'regular@example.invalid' }, accessToken: 'NEVER-PERSIST', sessionToken: 'NEVER-PERSIST' }), confirmed: true, request_id: crypto.randomUUID() });
    assert.equal(recharge.data.state, 'success');
  }
  assert(!JSON.stringify((await db.pool.query('SELECT * FROM wb_orders')).rows).includes('NEVER-PERSIST'));
  const claude = await req('/inventory/import', { channel: 'premium', product: 'claude_max20', text: 'CLAUDEMAX20-ABCDEFGHIJKLMNOP' });
  assert.equal((await req('/inventory/verify', { id: claude.data[0].id })).status, 200);
  const claudeOrder = await req('/recharge', { ...p, product: 'claude_max20', request_id: crypto.randomUUID() });
  assert.equal(claudeOrder.data.state, 'success');
  // Issued stock can be redeemed publicly, but never twice or by automatic allocation.
  const beforePublic = redeemed;
  const publicBody = { cdk_code: issued, account_id: target, account_confirm: target };
  const publicRequest = () => fetch(base + '/api-proxy/premium/create-task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(publicBody) });
  assert.equal((await publicRequest()).status, 200); assert.equal((await publicRequest()).status, 409); assert.equal(redeemed, beforePublic + 1);
  const beforeIssue = (await db.pool.query('SELECT count(*)::int n FROM wb_batches')).rows[0].n;
  assert.equal((await req('/issue', { channel: 'premium', product: 'plus', quantity: 100, request_id: crypto.randomUUID() })).status, 409);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM wb_batches')).rows[0].n, beforeIssue);
  await db.pool.query("UPDATE wb_sessions SET elevated_until=now()-interval '1 minute'");
  assert.equal((await req('/orders/detail', { id: a.data.id })).status, 403);
  assert.equal((await req('/batch/download', { id: one.data.id })).status, 403);
  assert.equal((await req('/orders/export', { from: d, to: d })).status, 403);
  const nextOtp = totp(otpSecret, Math.floor(Date.now() / 30000) + 1);
  assert.equal((await req('/reauth', { password: 'test administrator password', otp: nextOtp })).status, 200);
  assert.equal((await req('/orders/detail', { id: a.data.id })).status, 200);
  const badKeyWorkbench = createWorkbench({ env: { ...env, ADMIN_DATA_KEY: crypto.randomBytes(32).toString('base64') }, pool: db.pool, invoke, send() {} });
  t.after(() => badKeyWorkbench.close());
  await assert.rejects(badKeyWorkbench.publicInvoke('premium', 'create-task', publicBody));
  const guardOnly = createWorkbench({ env: { ...env, ADMIN_ENABLED: '0', ADMIN_INVENTORY_GUARD: '1' }, pool: db.pool, invoke, send() {} });
  t.after(() => guardOnly.close()); assert.equal(guardOnly.enabled, false); assert.equal(guardOnly.guard, true);
  await assert.rejects(guardOnly.publicInvoke('premium', 'create-task', publicBody));
  assert.equal((await fetch(base + '/workbench-schema.sql')).status, 404);
  assert.equal((await fetch(base + '/admin')).status, 200);
  await req('/logout', {}); assert.equal((await req('/inventory')).status, 401);
});
test('disabled workbench has no admin surface and database failure never invokes redemption', async t => {
  const disabled = createServer({ env: {} }); await new Promise(r => disabled.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => disabled.close(r)));
  assert.equal((await fetch(`http://127.0.0.1:${disabled.address().port}/admin`)).status, 404);
  const env = { ADMIN_ENABLED: '1', ADMIN_ORIGIN: 'http://127.0.0.1', DATABASE_URL: 'test', ADMIN_PASSWORD_HASH: await passwordHash('test only password'), ADMIN_DATA_KEY: crypto.randomBytes(32).toString('base64'), ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' };
  let called = false;
  const broken = createWorkbench({ env, pool: { query: async () => { throw new Error('simulated outage'); } }, invoke: async () => { called = true; }, send() {} }); t.after(() => broken.close());
  await assert.rejects(broken.publicInvoke('premium', 'create-task', {})); assert.equal(called, false);
});
