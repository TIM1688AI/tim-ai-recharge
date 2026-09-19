const test = require('node:test');
const assert = require('node:assert/strict');
const { createPremiumApi, validate } = require('./premium');

const CARD = 'EXAMPLE123456';
const ACCOUNT = '123e4567-e89b-42d3-a456-426614174000';
const route = (routeName) => ({ routeName });
const envelope = (data, code = 0) => ({ ok: code === 0, status: code === 0 ? 200 : 404,
  text: async () => JSON.stringify({ code, message: code === 0 ? 'ok' : 'missing', data }) });

test('高阶请求校验拒绝错误账号和超量查询', () => {
  assert.match(validate('create-task', { cdk_code: CARD, account_id: 'bad', account_confirm: 'bad' }), /Account ID/);
  assert.match(validate('lookup/tasks', { codes: Array(21).fill(CARD) }), /1–20/);
  assert.equal(validate('create-task', { cdk_code: CARD, account_id: ACCOUNT, account_confirm: ACCOUNT }), null);
});

test('验证只接受未使用的 ChatGPT Account ID 卡，密钥只在请求头', async () => {
  const calls = [];
  const api = createPremiumApi({ getKey: () => 'test-secret', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return envelope({ valid: true, status: 'unused', redeem_type: 'chatgpt_account_id', product_code: 'plus' });
  } });
  assert.equal((await api.handle(route('verify-cdk'), { cdk_code: CARD })).valid, true);
  assert.equal(calls[0].options.headers['X-Agent-API-Key'], 'test-secret');
  assert.doesNotMatch(calls[0].url, /test-secret|EXAMPLE/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { code: CARD });
});

test('兑换使用同一卡密稳定幂等号，且不回传 Account ID', async () => {
  const redemptions = [];
  const api = createPremiumApi({ getKey: () => 'test-secret', fetchImpl: async (url, options) => {
    if (String(url).endsWith('/cards/probe')) return envelope({ valid: true, status: 'unused', redeem_type: 'chatgpt_account_id' });
    const body = JSON.parse(options.body);
    redemptions.push(body);
    return envelope({ order_no: 'R123', status: 2, product_code: 'plus', message: '订单处理中' });
  } });
  const result = await api.handle(route('create-task'), { cdk_code: CARD, account_id: ACCOUNT, account_confirm: ACCOUNT });
  await api.handle(route('create-task'), { cdk_code: CARD, account_id: ACCOUNT, account_confirm: ACCOUNT });
  assert.equal(result.task_status, 'submitted');
  assert.equal(result.account_id, undefined);
  assert.equal(redemptions[0].idempotency_key, redemptions[1].idempotency_key);
  assert.match(redemptions[0].idempotency_key, /^redeem-[a-f0-9]{64}$/);
});

test('订单查询优先使用幂等号；不存在时回退卡密状态', async () => {
  const paths = [];
  const api = createPremiumApi({ getKey: () => 'test-secret', fetchImpl: async (url) => {
    const pathname = new URL(url).pathname;
    paths.push(pathname);
    if (pathname.includes('/redeem/')) return envelope(null, 40400);
    return envelope({ status: 'success', order_no: 'R123', email: 'private@example.com', account_id: ACCOUNT });
  } });
  const result = await api.handle(route('redeem-status'), { cdk_code: CARD });
  assert.equal(result.task_status, 'completed');
  assert.equal(result.account_id, undefined);
  assert.equal(result.email, undefined);
  assert.equal(paths.length, 2);
  assert.match(paths[0], /\/redeem\/redeem-/);
  assert.equal(paths[1], '/api/agent/v1/cards/redeem-status');
});

test('缺失 Key 时禁止外发请求，HTTP 200 业务失败不能视为成功', async () => {
  const missing = createPremiumApi({ getKey: () => '', fetchImpl: async () => { throw new Error('unexpected call'); } });
  await assert.rejects(missing.handle(route('verify-cdk'), { cdk_code: CARD }), /尚未配置/);
  const rejected = createPremiumApi({ getKey: () => 'fake', fetchImpl: async () => ({
    ok: true, status: 200, text: async () => JSON.stringify({ code: 100401, message: 'private upstream data' }),
  }) });
  await assert.rejects(rejected.handle(route('verify-cdk'), { cdk_code: CARD }), (error) =>
    error.code === 100401 && error.publicMessage.includes('覆盖确认') && !error.message.includes('private'));
});

test('人工复核信号必须停止轮询，未知状态不能误判成功', async () => {
  const api = createPremiumApi({ getKey: () => 'fake', fetchImpl: async () => ({
    ok: false, status: 409, text: async () => JSON.stringify({ code: 40900,
      data: { status: 'review', requires_manual_review: true, stop_polling: true, retryable: false } }),
  }) });
  const result = await api.handle(route('redeem-status'), { cdk_code: CARD });
  assert.equal(result.stop_polling, true);
  assert.equal(result.task_status, 'manual_review');
  const unknown = createPremiumApi({ getKey: () => 'fake', fetchImpl: async () => envelope({ status: 'new-undocumented-state' }) });
  assert.equal((await unknown.handle(route('redeem-status'), { cdk_code: CARD })).task_status, 'manual_review');
});

test('不支持的兑换类型和非 unused 卡密不能发送兑换', async () => {
  for (const data of [
    { valid: true, status: 'unused', redeem_type: 'chatgpt_session_json' },
    { valid: true, status: 'processing', redeem_type: 'chatgpt_account_id' },
  ]) {
    const calls = [];
    const api = createPremiumApi({ getKey: () => 'fake', fetchImpl: async (url) => { calls.push(String(url)); return envelope(data); } });
    await assert.rejects(api.handle(route('create-task'), { cdk_code: CARD, account_id: ACCOUNT, account_confirm: ACCOUNT }));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].endsWith('/cards/probe'));
  }
});

test('ChatGPT 和 Claude 及文档别名按供应商类型兑换，拒绝目标错配', async () => {
  for (const [supplierType, canonical] of [
    ['chatgpt_account_id', 'chatgpt_account_id'], ['account_id', 'chatgpt_account_id'],
    ['claude_org_id', 'claude_org_id'], ['claude_org', 'claude_org_id'], ['organization_id', 'claude_org_id'],
  ]) {
    const posts = [];
    const api = createPremiumApi({ getKey: () => 'fake', fetchImpl: async (url, options) => {
      if (String(url).endsWith('/cards/probe')) return envelope({ valid: true, status: 'unused', redeem_type: supplierType });
      posts.push(JSON.parse(options.body));
      return envelope({ status: 2, order_no: 'MOCK' });
    } });
    const verified = await api.handle(route('verify-cdk'), { cdk_code: CARD });
    assert.equal(verified.valid, true);
    assert.equal(verified.redeem_type, canonical);
    const input = { cdk_code: CARD, account_id: ACCOUNT, account_confirm: ACCOUNT, redeem_type: canonical };
    await api.handle(route('create-task'), input);
    assert.equal(posts[0].redeem_type, canonical);
    assert.equal(posts[0].target_value, ACCOUNT);
    assert.equal(posts[0].target_confirm, ACCOUNT);
    await assert.rejects(api.handle(route('create-task'), { ...input,
      redeem_type: canonical === 'claude_org_id' ? 'chatgpt_account_id' : 'claude_org_id' }), /类型已变化/);
    assert.equal(posts.length, 1);
  }
});
