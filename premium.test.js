const test = require('node:test');
const assert = require('node:assert/strict');
const { createPremiumApi, validate, toSupplierCard, toPublicCard } = require('./premium');
const { createHmac } = require('crypto');
const { isPlausibleChannelKey, extractPremiumSessionTarget, getRecordOrganizationId, getPremiumGptAccountHints } = require('./app');

const CARD = 'TIMG-PLUS-EXAMPLE123456';
const ACCOUNT = '123e4567-e89b-42d3-a456-426614174000';
test('高阶 Session 只提取 account.id 和核对邮箱，不保留令牌，不使用 user.id', () => {
  const extracted = extractPremiumSessionTarget(JSON.stringify({ account: { id: ACCOUNT }, user: { id: 'other', email: 'test@example.com' }, accessToken: 'TEST-SECRET-TOKEN', sessionToken: 'TEST-COOKIE' }));
  assert.deepEqual(extracted, { accountId: ACCOUNT, email: 'test@example.com' });
  for (const value of ['', '{', 'null', '[]', JSON.stringify({ user: { id: ACCOUNT } }), JSON.stringify({ account: { id: 'invalid' } })]) {
    assert.throws(() => extractPremiumSessionTarget(value));
  }
  assert.throws(() => extractPremiumSessionTarget('x'.repeat(256 * 1024 + 1)), /过大/);
});
const route = (routeName) => ({ routeName });
const envelope = (data, code = 0) => ({ ok: code === 0, status: code === 0 ? 200 : 404,
  text: async () => JSON.stringify({ code, message: code === 0 ? 'ok' : 'missing', data }) });

test('八类品牌卡覆盖验证、提交、单查和批查，拒绝全部旧格式', async () => {
  for (const [prefix, original] of [
    ['TIMC-PRO-', 'CLAUDEPRO-'], ['TIMC-MAX5-', 'CLAUDEMAX5-'], ['TIMC-MAX5SPECIAL-', 'CLAUDEMAX5SPECIAL-'], ['TIMC-MAX20-', 'CLAUDEMAX20-'],
    ['TIMG-PLUS-', 'PLUS-'], ['TIMG-PRO5-', 'PRO5-'], ['TIMG-PRO5SPECIAL-', 'PRO5SPECIAL-'], ['TIMG-PRO20-', 'PRO20-'],
  ]) {
    const card = prefix + 'TEST123456789ABC';
    const raw = original + 'TEST123456789ABC';
    const type = prefix.startsWith('TIMC') ? 'claude_org_id' : 'chatgpt_account_id';
    assert.equal(toSupplierCard(card), raw);
    assert.equal(toPublicCard(raw), card);
    assert.equal(isPlausibleChannelKey(card, 'premium'), true);
    assert.equal(isPlausibleChannelKey(raw, 'premium'), false);
    const calls = [];
    const api = createPremiumApi({ getKey: () => 'fake', fetchImpl: async (url, options) => {
      calls.push({ path: new URL(url).pathname, body: options.body && JSON.parse(options.body) });
      if (String(url).includes('/redeem/')) return envelope(null, 40400);
      if (String(url).endsWith('/cards/probe')) return envelope({ valid: true, status: 'unused', redeem_type: type, product_name: type === 'claude_org_id' ? 'Claude Max 5X' : 'ChatGPT Pro 5X' });
      if (String(url).endsWith('/cards/redeem')) return envelope({ status: 2, order_no: 'ORDER-TEST' });
      return envelope({ status: 'success', order_no: 'ORDER-TEST', product_code: 'pro5' });
    } });
    const verified = await api.handle(route('verify-cdk'), { cdk_code: card });
    assert.equal(verified.plan_type.includes('Special 卡'), prefix.includes('SPECIAL'));
    const submitted = await api.handle(route('create-task'), { cdk_code: card, account_id: ACCOUNT, account_confirm: ACCOUNT, redeem_type: type });
    assert.equal(submitted.cdk_code, card);
    const status = await api.handle(route('redeem-status'), { cdk_code: card });
    assert.equal(status.cdk_code, card);
    assert.equal(status.plan_type.includes('Special 卡'), prefix.includes('SPECIAL'));
    assert.equal((await api.handle(route('lookup/tasks'), { codes: [card, card.toLowerCase()] })).tasks.length, 1);
    for (const call of calls.filter(call => call.body)) assert.equal(call.body.code || call.body.card_code, raw);
    const count = calls.length;
    for (const name of ['verify-cdk', 'create-task', 'redeem-status', 'lookup/tasks']) {
      await assert.rejects(api.handle(route(name), { cdk_code: raw, codes: [raw], account_id: ACCOUNT, account_confirm: ACCOUNT, redeem_type: type }), /新格式/);
    }
    assert.equal(calls.length, count);
  }
  assert.equal(getRecordOrganizationId({ premium: true, task_status: 'completed', organization_id: ACCOUNT }, 'TIMC-MAX5SPECIAL-MOCK123'), ACCOUNT);
  assert.deepEqual(getPremiumGptAccountHints({ premium: true, task_status: 'completed', account_email_hint: 'a***@example.com', account_id_hint: '123e4567…4000' }, 'TIMG-PRO5SPECIAL-MOCK123'), { email: 'a***@example.com', id: '123e4567…4000' });
  for (const card of ['TIMC-OTHER-ABCDEF', 'TIMG-OTHER-ABCDEF', 'TIMC-PRO-', 'TIM-PRO-ABCDEF', 'TIMG-PLUS-X!', 'TIMC-PRO-' + 'X'.repeat(55)]) {
    assert.equal(toSupplierCard(card), '');
    assert.equal(isPlausibleChannelKey(card, 'premium'), false);
  }
});

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
  assert.deepEqual(JSON.parse(calls[0].options.body), { code: 'PLUS-EXAMPLE123456' });
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
  assert.equal(redemptions[0].idempotency_key, 'redeem-' + createHmac('sha256', 'test-secret').update('tim-premium-v1:PLUS-EXAMPLE123456').digest('hex'));
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
  assert.equal(result.account_email_hint, 'pr***e@example.com');
  assert.equal(result.account_id_hint, '123e4567…4000');
  assert.equal(paths.length, 3);
  assert.match(paths[0], /\/redeem\/redeem-/);
  assert.ok(paths.includes('/api/agent/v1/cards/redeem-status'));
  assert.ok(paths.includes('/api/agent/v1/cards/query'));
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
    await assert.rejects(api.handle(route('create-task'), { cdk_code: CARD, account_id: ACCOUNT, account_confirm: ACCOUNT }), error =>
      error.status === 409 && typeof error.publicMessage === 'string' && error.publicMessage.length > 0);
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

test('Claude 单查并行补取组织 ID，只输出有效组织字段', { timeout: 1000 }, async () => {
  for (const prefix of ['TIMC-PRO-', 'TIMC-MAX5-', 'TIMC-MAX5SPECIAL-', 'TIMC-MAX20-']) {
    const card = prefix + 'MOCKIDENTITY123';
    const calls = [];
    let identityStarted;
    const identityReady = new Promise(resolve => { identityStarted = resolve; });
    const api = createPremiumApi({ getKey: () => 'mock-only', fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: options.method, body: options.body && JSON.parse(options.body) });
      if (path.endsWith('/cards/query')) {
        identityStarted();
        return envelope({ status: 'success', account_id: ` ${ACCOUNT.toUpperCase()} `, email: 'private@example.com' });
      }
      assert.match(path, /\/redeem\/redeem-/);
      await identityReady;
      return envelope({ status: 'success', order_no: 'MOCK-ORDER', account_id: 'do-not-forward', email: 'private@example.com' });
    } });
    const result = await api.handle(route('redeem-status'), { cdk_code: card });
    assert.equal(result.organization_id, ACCOUNT);
    assert.equal(result.task_status, 'completed');
    assert.equal(result.task_id, 'MOCK-ORDER');
    assert.equal(result.cdk_code, card);
    assert.equal(Object.hasOwn(result, 'account_id'), false);
    assert.equal(Object.hasOwn(result, 'email'), false);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.find(call => call.path.endsWith('/cards/query')), {
      path: '/api/agent/v1/cards/query', method: 'POST', body: { code: toSupplierCard(card) },
    });
  }
});

test('Claude 原请求不存在时保留卡密状态回退并补取组织 ID', async () => {
  const card = 'TIMC-PRO-MOCKFALLBACK123';
  const paths = [];
  const api = createPremiumApi({ getKey: () => 'mock-only', fetchImpl: async (url, options) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path.includes('/redeem/')) return envelope(null, 40400);
    if (path.endsWith('/cards/redeem-status')) {
      assert.deepEqual(JSON.parse(options.body), { card_code: toSupplierCard(card) });
      return envelope({ status: 'success', order_no: 'MOCK-FALLBACK' });
    }
    assert.equal(path, '/api/agent/v1/cards/query');
    return envelope({ status: 'success', account_id: ACCOUNT });
  } });
  const result = await api.handle(route('redeem-status'), { cdk_code: card });
  assert.equal(result.organization_id, ACCOUNT);
  assert.equal(result.task_status, 'completed');
  assert.equal(result.task_id, 'MOCK-FALLBACK');
  assert.equal(paths.length, 3);
  assert.equal(paths.filter(path => path.endsWith('/cards/redeem-status')).length, 1);
});

test('Claude 与 GPT 批查逐卡绑定对应身份，仅返回 GPT 脱敏账号线索', async () => {
  const claudeCards = ['TIMC-PRO-MOCKBATCHONE123', 'TIMC-MAX5-MOCKBATCHTWO123', 'TIMC-MAX20-MOCKBATCHTHREE123'];
  const gptCards = ['TIMG-PLUS-MOCKBATCHGPT123', 'TIMG-PRO5-MOCKBATCHGPT456', 'TIMG-PRO20-MOCKBATCHGPT789'];
  const secondAccount = '987e6543-e21b-43d3-a456-426614174999';
  const thirdAccount = '456e7890-e21b-43d3-a456-426614174999';
  const identities = new Map(claudeCards.map((card, index) => [toSupplierCard(card), [ACCOUNT, secondAccount, thirdAccount][index]]));
  for (const card of gptCards) identities.set(toSupplierCard(card), ACCOUNT);
  const queried = [];
  const api = createPremiumApi({ getKey: () => 'mock-only', fetchImpl: async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/cards/query')) {
      const { code } = JSON.parse(options.body);
      queried.push(code);
      assert.equal(identities.has(code), true);
      return envelope({ status: 'success', account_id: identities.get(code), email: 'customer@example.com' });
    }
    assert.match(path, /\/redeem\/redeem-/);
    return envelope({ status: 'success', order_no: 'MOCK-ORDER', organization_id: ACCOUNT, account_id: ACCOUNT });
  } });
  const result = await api.handle(route('lookup/tasks'), { codes: [...claudeCards, ...gptCards, claudeCards[0].toLowerCase()] });
  assert.equal(result.tasks.length, 6);
  assert.deepEqual(result.tasks.slice(0, 3).map(task => task.organization_id), [ACCOUNT, secondAccount, thirdAccount]);
  for (const task of result.tasks) {
    assert.equal(task.task_status, 'completed');
    assert.equal(Object.hasOwn(task, 'account_id'), false);
    assert.equal(Object.hasOwn(task, 'email'), false);
  }
  for (const task of result.tasks.slice(0, 3)) {
    assert.equal(Object.hasOwn(task, 'account_email_hint'), false);
    assert.equal(Object.hasOwn(task, 'account_id_hint'), false);
  }
  for (const task of result.tasks.slice(3)) {
    assert.equal(Object.hasOwn(task, 'organization_id'), false);
    assert.equal(task.account_email_hint, 'cu***r@example.com');
    assert.equal(task.account_id_hint, '123e4567…4000');
    assert.doesNotMatch(JSON.stringify(task), /customer@example\.com|123e4567-e89b-42d3-a456-426614174000/);
  }
  assert.deepEqual(queried.sort(), [...identities.keys()].sort());
  for (const card of gptCards) {
    const task = await api.handle(route('redeem-status'), { cdk_code: card });
    assert.equal(Object.hasOwn(task, 'organization_id'), false);
    assert.equal(task.account_email_hint, 'cu***r@example.com');
  }
  assert.equal(queried.length, 9);
});

test('GPT 身份查询仅在订单状态一致时展示，错误或缺失字段不猜测账号', async () => {
  for (const [status, identityStatus, orderNo, allowed] of [
    ['success', 'success', 'MOCK-ORDER', true],
    ['pending', 'processing', 'MOCK-ORDER', true],
    ['success', 'processing', 'MOCK-ORDER', false],
    ['processing', 'success', 'MOCK-ORDER', false],
    ['success', 'success', undefined, false],
    ['failed', 'success', 'MOCK-ORDER', false],
    ['review', 'processing', 'MOCK-ORDER', false],
    ['unused', 'success', undefined, false],
  ]) {
    const api = createPremiumApi({ getKey: () => 'mock-only', fetchImpl: async url => envelope(
      String(url).endsWith('/cards/query')
        ? { status: identityStatus, account_id: ACCOUNT, email: 'customer@example.com' }
        : { status, order_no: orderNo },
    ) });
    const result = await api.handle(route('redeem-status'), { cdk_code: 'TIMG-PRO20-MOCKSTATE123' });
    assert.equal(Object.hasOwn(result, 'account_email_hint'), allowed, `${status}/${identityStatus}/${orderNo}`);
    assert.equal(Object.hasOwn(result, 'account_id_hint'), allowed);
  }
  const invalid = createPremiumApi({ getKey: () => 'mock-only', fetchImpl: async url => envelope(
    String(url).endsWith('/cards/query')
      ? { status: 'success', account_id: 'not-a-uuid', email: 'not-an-email' }
      : { status: 'success', order_no: 'MOCK-ORDER' },
  ) });
  const result = await invalid.handle(route('redeem-status'), { cdk_code: 'TIMG-PLUS-MOCKINVALID123' });
  assert.equal(Object.hasOwn(result, 'account_email_hint'), false);
  assert.equal(Object.hasOwn(result, 'account_id_hint'), false);
  const unavailable = createPremiumApi({ getKey: () => 'mock-only', fetchImpl: async url => {
    if (String(url).endsWith('/cards/query')) throw new Error('unavailable');
    return envelope({ status: 'success', order_no: 'MOCK-ORDER' });
  } });
  assert.equal((await unavailable.handle(route('redeem-status'), { cdk_code: 'TIMG-PRO5-MOCKERROR123' })).task_status, 'completed');
});

test('Claude 无效、无关联或状态不一致时不显示组织 ID，补查异常保留订单结果', async () => {
  for (const accountId of [undefined, null, '', 'not-a-uuid', ACCOUNT + 'x', 123, {}, [ACCOUNT]]) {
    const api = createPremiumApi({ getKey: () => 'mock-only', fetchImpl: async url => {
      if (String(url).endsWith('/cards/query')) return envelope({ status: 'success', account_id: accountId, email: 'private@example.com' });
      return envelope({ status: 'success', order_no: 'MOCK-ORDER' });
    } });
    const result = await api.handle(route('redeem-status'), { cdk_code: 'TIMC-PRO-MOCKMISSING123' });
    assert.equal(result.task_status, 'completed');
    assert.equal(Object.hasOwn(result, 'organization_id'), false);
    assert.equal(Object.hasOwn(result, 'account_id'), false);
    assert.equal(Object.hasOwn(result, 'email'), false);
  }
  for (const [status, identityStatus, orderNo, allowed] of [
    ['pending', 'processing', 'MOCK-ORDER', true],
    ['processing', 'processing', 'MOCK-ORDER', true],
    ['success', 'success', 'MOCK-ORDER', true],
    ['success', 'unused', 'MOCK-ORDER', false],
    ['success', 'invalid', 'MOCK-ORDER', false],
    ['success', 'unknown', 'MOCK-ORDER', false],
    ['success', 'processing', 'MOCK-ORDER', false],
    ['processing', 'success', 'MOCK-ORDER', false],
    ['success', 'success', undefined, false],
    ['success', 'success', '   ', false],
    ['unused', 'success', undefined, false],
    ['invalid', 'success', undefined, false],
    ['failed', 'success', 'MOCK-ORDER', false],
    ['review', 'processing', 'MOCK-ORDER', false],
    ['unknown', 'processing', 'MOCK-ORDER', false],
  ]) {
    const api = createPremiumApi({ getKey: () => 'mock-only', fetchImpl: async url => envelope(
      String(url).endsWith('/cards/query')
        ? { status: identityStatus, account_id: ACCOUNT }
        : { status, order_no: orderNo },
    ) });
    const result = await api.handle(route('redeem-status'), { cdk_code: 'TIMC-PRO-MOCKSTATE123' });
    assert.equal(Object.hasOwn(result, 'organization_id'), allowed, `${status}/${identityStatus}/${orderNo}`);
    if (allowed) assert.equal(result.organization_id, ACCOUNT);
    if (status === 'failed') assert.equal(result.task_status, 'failed');
    if (['invalid', 'unused'].includes(status)) assert.equal(result.task_status, 'not_found');
  }
  const failures = [
    async () => { throw Object.assign(new Error('mock timeout'), { name: 'AbortError' }); },
    async () => ({ ok: false, status: 503, text: async () => JSON.stringify({ code: 50000 }) }),
    async () => ({ ok: true, status: 200, text: async () => '{' }),
  ];
  for (const [status, expectedStatus] of [['success', 'completed'], ['failed', 'failed'], ['review', 'manual_review']]) {
    for (const fail of failures) {
      const api = createPremiumApi({ getKey: () => 'mock-only', fetchImpl: async url => {
        if (String(url).endsWith('/cards/query')) return fail();
        return envelope({ status, order_no: 'MOCK-ORDER', stop_polling: status === 'review' });
      } });
      const result = await api.handle(route('redeem-status'), { cdk_code: 'TIMC-PRO-MOCKERROR123' });
      assert.equal(result.task_status, expectedStatus);
      assert.equal(result.task_id, 'MOCK-ORDER');
      assert.equal(result.stop_polling, status === 'review');
      assert.equal(Object.hasOwn(result, 'organization_id'), false);
    }
  }
});
