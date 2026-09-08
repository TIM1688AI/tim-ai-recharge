const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validCode, supplierCode, taskResult, handle, createSubmissionGuard } = require('./advanced');

test('stock grades cover boundaries and never treat unavailable data as empty', () => {
  const { getStockLevel, getStockLabel } = require('./app');
  for (const [count, label] of [[0, '无'], [1, '低'], [5, '低'], [6, '中'], [15, '中'], [16, '高']]) assert.equal(getStockLevel(count), label);
  for (const invalid of [undefined, null, -1, NaN, '5', true, 1.5]) assert.equal(getStockLevel(invalid), '暂不可用');
  assert.equal(getStockLabel({ plus: 49, plus_year: 0, pro5x: 17, pro20x: 0 }), '月Plus：高 / 年Plus：无 / 月5X Pro：高 / 月20X Pro：无');
});

test('advanced formats and conservative status mapping', () => {
  for (const tier of ['', '5X', '20X']) assert.equal(supplierCode(`TIM${tier}-ABCDEFGHIJK`), `JZ${tier}-ABCDEFGHIJK`);
  assert.equal(supplierCode('ABCD1234EFGH5678'), 'ABCD1234EFGH5678');
  assert.equal(validCode('JZ-ABCDEFGHIJK'), false);
  assert.equal(validCode('ABCD1234EFGH56789'), false);
  for (const status of ['used', 'unknown', 'error', 'receipt_used']) assert.equal(taskResult({ success: true, status }, 'JZ-ABCDEFGHIJK').task_status, 'unconfirmed');
  assert.equal(taskResult({ status: 'used', result_status: 'pending' }, 'x').task_status, 'pending');
  assert.equal(taskResult({ status: 'success' }, 'x').task_status, 'completed');
  assert.equal(taskResult({ status: 'error' }, 'x').task_status, 'unconfirmed');
  assert.equal(taskResult({ found: false, status: 'error' }, 'x').task_status, 'not_found');
});

test('advanced API payloads, memory concurrent guard and refusal', async t => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const calls = [];
  let allowed = true;
  global.fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: url.pathname, body });
    if (url.pathname === '/api/check-session') return Response.json({ success: true, valid: true, can_redeem: allowed, is_team: false });
    if (url.pathname === '/api/redeem') throw new Error('Simulated timeout');
    if (url.pathname === '/api/verify-key') return Response.json({ success: true, product_name: '测试年度产品' });
    if (url.pathname === '/api/query-key') return Response.json({ success: true, status: 'used' });
    throw new Error('Unexpected endpoint');
  };
  await handle({ routeName: 'verify-cdk' }, { cdk_code: 'TIM5X-ABCDEFGHIJK' });
  assert.equal(calls[0].body.key, 'JZ5X-ABCDEFGHIJK');
  const payload = { cdk_code: 'ABCD1234EFGH5678', session_json: '{"test":true}' };
  await Promise.all([handle({ routeName: 'create-task' }, payload), handle({ routeName: 'create-task' }, payload)]);
  assert.equal(calls.filter(c => c.path === '/api/redeem').length, 1);
  await handle({ routeName: 'create-task' }, payload);
  assert.equal(calls.filter(c => c.path === '/api/redeem').length, 1);
  assert.deepEqual(calls.find(c => c.path === '/api/redeem').body, { key: payload.cdk_code, session: payload.session_json });
  allowed = false;
  await assert.rejects(handle({ routeName: 'create-task' }, { ...payload, cdk_code: 'TIM-ABCDEFGHIJK' }));
  const result = await handle({ routeName: 'lookup/tasks' }, { codes: ['TIM-ABCDEFGHIJK'] });
  assert.equal(result.tasks[0].task_status, 'unconfirmed');
  assert.equal(result.tasks[0].cdk_code, 'TIM-ABCDEFGHIJK');
  const { createServer } = require('./server');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await originalFetch(`http://127.0.0.1:${server.address().port}/api-proxy/advanced/verify-cdk`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cdk_code: 'TIM20X-ABCDEFGHIJK' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).valid, true);
    assert.equal(calls.at(-1).path, '/api/verify-key');
    assert.equal(calls.at(-1).body.key, 'JZ20X-ABCDEFGHIJK');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('memory guard holds in-flight requests and expires cooldowns without configuration', () => {
  let time = 0;
  const guard = createSubmissionGuard(() => time);
  const key = 'TIM-ABCDEFGHIJK';
  const finish = guard(key);
  time = 999999;
  assert.equal(guard(key), null);
  finish(true);
  time += 59999;
  assert.equal(guard(key), null);
  time += 1;
  const uncertain = guard(key);
  assert.equal(typeof uncertain, 'function');
  uncertain(false);
  time += 299999;
  assert.equal(guard(key), null);
  time += 1;
  assert.equal(typeof guard(key), 'function');
});
