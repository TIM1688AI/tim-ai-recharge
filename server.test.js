const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const http = require('http');
const test = require('node:test');

const {
  buildApiRoutes,
  buildUpstreamHeaders,
  buildUpstreamPayload,
  buildUpstreamUrl,
  createUpstreamBaseUrl,
  createServer,
  enforceRateLimit,
  isAdvancedCdkCode,
  isCdkCode,
  normalizeAdvancedCdk,
  toSupplierCdk,
  toPublicAdvancedPayload,
  resetRateLimits,
  validateProductionConfig,
  validateProxyPayload,
} = require('./server');
const {
  buildCreateTaskPayload,
  formatDateTime,
  formatRechargeType,
  getCardKeyFromUrl,
  getRechargeLink,
  parseBatchKeyText,
  getQueueCount,
  getQueueDisplay,
  getQueueErrorDisplay,
  getTaskPollDelay,
  getTaskStatus,
  isPlausibleChannelKey,
  isPlausibleKey,
  maskKey,
  mergeTaskResults,
  normalizeChannelKey,
  normalizeKey,
  parseSessionJsonValue,
} = require('./app');

const TEST_CDK = 'TIM-Ai_2026-X7p9';
const SECOND_CDK = 'SHORT-123456';
const ADVANCED_CDK = 'TIM-ABCDEFGHIJK';
const SESSION = JSON.stringify({
  accessToken: 'eyJ-test-token',
  sessionToken: 'session-cookie-token',
  user: { email: 'member@example.com' },
  planType: 'free',
});

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

test('new provider payload validation accepts documented requests', () => {
  assert.equal(validateProxyPayload('recharge/verify-cdk', { cdk_code: TEST_CDK }), null);
  assert.equal(validateProxyPayload('recharge/create-task', {
    cdk_code: TEST_CDK,
    session_json: SESSION,
  }), null);
  assert.equal(validateProxyPayload('recharge/check-subscription', { token_input: SESSION }), null);
  assert.equal(validateProxyPayload('recharge/refresh-cdk', { cdk_code: TEST_CDK }), null);
  assert.equal(validateProxyPayload('recharge/cancel-task', { cdk_code: TEST_CDK }), null);
  assert.equal(validateProxyPayload('lookup/tasks', { codes: [TEST_CDK, SECOND_CDK] }), null);
  assert.equal(validateProxyPayload({ channel: 'advanced', upstreamPath: 'recharge/check-subscription' }, { token_input: SESSION }), null);
});

test('advanced channel keeps its own public routes, omits API key, and maps subscription payloads', () => {
  const routes = buildApiRoutes();
  assert.equal(routes.get('/api-proxy/regular/verify-cdk').channel, 'regular');
  assert.equal(routes.get('/api-proxy/advanced/verify-cdk').channel, 'advanced');
  assert.equal(routes.has('/api-proxy/advanced/refresh-cdk'), false);
  assert.equal(routes.has('/api-proxy/advanced/queue-events'), false);
  assert.equal(routes.get('/api-proxy/regular/queue-events').sse, true);
  assert.deepEqual(buildUpstreamPayload({ channel: 'advanced', upstreamPath: 'recharge/check-subscription' }, { token_input: SESSION }), { session: SESSION });
  assert.deepEqual(buildUpstreamPayload({ channel: 'advanced', upstreamPath: 'recharge/verify-cdk' }, { cdk_code: ' tim-abcde fghijk ' }), { cdk_code: 'JZ-ABCDEFGHIJK' });
  assert.deepEqual(buildUpstreamPayload({ channel: 'advanced', upstreamPath: 'lookup/tasks' }, { codes: [' tim-abcde fghijk '] }), { codes: ['JZ-ABCDEFGHIJK'] });
  const advancedHeaders = buildUpstreamHeaders({ channel: 'advanced', method: 'POST' }, Buffer.from('{}'));
  assert.equal(advancedHeaders['X-API-Key'], undefined);
  assert.equal(advancedHeaders['Content-Type'], 'application/json');
});

test('card keys preserve supplier formatting and only receive boundary validation', () => {
  assert.equal(normalizeKey(`  ${TEST_CDK}  `), TEST_CDK);
  assert.equal(isPlausibleKey(TEST_CDK), true);
  assert.equal(isPlausibleKey(SECOND_CDK), true);
  assert.equal(isPlausibleKey('abc'), false);
  assert.equal(isPlausibleKey('A'.repeat(129)), false);
  assert.equal(isCdkCode(TEST_CDK), true);
  assert.equal(maskKey(TEST_CDK), 'TIM-••••••X7p9');
  assert.equal(normalizeAdvancedCdk(' tim-abcde fghijk '), ADVANCED_CDK);
  assert.equal(normalizeChannelKey(' tim-abcde fghijk ', 'advanced'), ADVANCED_CDK);
  assert.equal(isAdvancedCdkCode(' tim-abcde fghijk '), true);
  assert.equal(isAdvancedCdkCode('JZ-WRONG'), false);
  assert.equal(isPlausibleChannelKey(ADVANCED_CDK, 'advanced'), true);
  assert.equal(isPlausibleChannelKey(TEST_CDK, 'advanced'), false);
});

test('branded advanced cards round-trip all tiers without changing sessions or regular cards', () => {
  for (const tier of ['', '5X', '20X']) {
    const branded = `TIM${tier}-ABTIMJZ1234`;
    const supplier = `JZ${tier}-ABTIMJZ1234`;
    assert.equal(isPlausibleChannelKey(branded, 'advanced'), true);
    assert.equal(toSupplierCdk(branded.toLowerCase()), supplier);
    const payload = { cdk_code: branded, session_json: SESSION };
    const upstream = buildUpstreamPayload({ channel: 'advanced', upstreamPath: 'recharge/create-task' }, payload);
    assert.deepEqual(upstream, { cdk_code: supplier, session_json: SESSION });
    assert.equal(payload.cdk_code, branded);
    const result = toPublicAdvancedPayload({ tasks: [{ cdk_code: supplier, task_id: 'opaque-123', plan_type: 'plus' }], error: `卡密 ${supplier} 已使用` });
    assert.equal(result.tasks[0].cdk_code, branded);
    assert.equal(result.tasks[0].task_id, 'opaque-123');
    assert.equal(result.error, `卡密 ${branded} 已使用`);
    assert.equal(mergeTaskResults([branded], result.tasks, 'advanced')[0].task_id, 'opaque-123');
    assert.deepEqual(buildUpstreamPayload({ channel: 'regular', upstreamPath: 'recharge/create-task' }, payload), payload);
  }
  assert.equal(isAdvancedCdkCode('JZ-ABCDEFGHIJK'), false);
  assert.equal(isAdvancedCdkCode(['TIM-ABCDEFGHIJK']), false);
  assert.throws(() => toSupplierCdk('NOT-TIM-ABCDEFGHIJK'));
  assert.equal(toPublicAdvancedPayload('XJZ-ABCDEFGHIJKL'), 'XJZ-ABCDEFGHIJKL');
  assert.equal(toPublicAdvancedPayload('LZ-ABCDEFGHIJK'), 'LZ-ABCDEFGHIJK');
  assert.equal(toPublicAdvancedPayload(null), null);
  const fs = require('node:fs');
  assert.doesNotMatch(fs.readFileSync(require('node:path').join(__dirname, 'app.js'), 'utf8'), /(?:LZ|JZ)(?:5X|20X)?-/);
});

test('card links prefill flexible valid keys without changing case', () => {
  assert.equal(getCardKeyFromUrl(`?card=${encodeURIComponent(TEST_CDK)}`), TEST_CDK);
  assert.equal(getCardKeyFromUrl('', `#card=${encodeURIComponent(TEST_CDK)}`), TEST_CDK);
  assert.equal(getCardKeyFromUrl('?source=customer', `#card=${encodeURIComponent(SECOND_CDK)}`), SECOND_CDK);
  assert.equal(getCardKeyFromUrl('?source=customer&card=abc'), '');
  assert.equal(getCardKeyFromUrl(''), '');
});

test('advanced link, batch input and queue edge cases', () => {
  assert.deepEqual(getRechargeLink('', '#channel=advanced&card=tim-ABCDEFGHIJK'), { channel: 'advanced', cardKey: 'TIM-ABCDEFGHIJK' });
  assert.equal(getRechargeLink('?card=TIM-ABCDEFGHIJK', '#channel=advanced').channel, 'regular');
  assert.equal(getRechargeLink('', '#channel=unknown&card=TIM-ABCDEFGHIJK').channel, 'regular');
  assert.deepEqual(parseBatchKeyText('tim-abcde fghijk TIM5X-ABCDEFGHIJK\nTIM20X-ABCDEFGHIJK，TIM-ABCDEFGHIJK', 'advanced'), ['TIM-ABCDEFGHIJK', 'TIM5X-ABCDEFGHIJK', 'TIM20X-ABCDEFGHIJK']);
  assert.deepEqual(parseBatchKeyText('Abcd Efgh', 'regular'), ['Abcd', 'Efgh']);
  for (const pending_count of [null, undefined, '', ' ', true, false, -1, 1.5, [], {}, Infinity]) {
    assert.throws(() => getQueueCount({ pending_count }));
  }
  assert.equal(getQueueCount({ pending_count: '0' }), 0);
});

test('response mapping preserves identity fields and adapts display messages', () => {
  const input = { task: { cdk_code: 'JZ-ABCDEFGHIJK', account_email: 'JZ-ABCDEFGHIJK@example.com', task_id: 'JZ-ABCDEFGHIJK-extra' }, error: '仅支持 JZ5X- 卡密', message: 'JZ20X-ABCDEFGHIJK 已提交', failure_reason: '请检查 JZ- 卡密', unknown: 'JZ-ABCDEFGHIJK' };
  const result = toPublicAdvancedPayload(input);
  assert.equal(result.task.cdk_code, 'TIM-ABCDEFGHIJK');
  assert.equal(result.task.account_email, input.task.account_email);
  assert.equal(result.task.task_id, input.task.task_id);
  assert.equal(result.unknown, input.unknown);
  assert.equal(result.error, '仅支持 TIM5X- 卡密');
  assert.equal(result.message, 'TIM20X-ABCDEFGHIJK 已提交');
  assert.equal(result.failure_reason, '请检查 TIM- 卡密');
  assert.equal(input.task.cdk_code, 'JZ-ABCDEFGHIJK');
});

test('Session parser identifies account and creates the new task payload', () => {
  const parsed = parseSessionJsonValue(SESSION);
  assert.equal(parsed.accountLabel, 'member@example.com');
  assert.equal(parsed.planType, 'free');
  assert.equal(JSON.parse(parsed.sessionJson).accessToken, 'eyJ-test-token');
  assert.deepEqual(buildCreateTaskPayload(TEST_CDK, parsed), {
    cdk_code: TEST_CDK,
    session_json: parsed.sessionJson,
  });
  assert.throws(() => parseSessionJsonValue(JSON.stringify({ user: { email: 'x@example.com' } })), /accessToken/);
  assert.throws(() => parseSessionJsonValue(JSON.stringify({
    accessToken: 'token',
    user: { email: 'x@example.com' },
  })), /sessionToken/);
  assert.throws(() => parseSessionJsonValue(JSON.stringify({
    accessToken: 'token',
    sessionToken: 'session-token',
  })), /邮箱/);
});

test('task statuses distinguish progress, completion, failure, and no record', () => {
  assert.deepEqual(getTaskStatus({ task_status: 'submitted' }), {
    kind: 'processing', label: '后台正在处理', terminal: false,
  });
  assert.equal(getTaskStatus({ task_status: 'manual_review' }).label, '人工处理中');
  assert.deepEqual(getTaskStatus({ task_status: 'completed' }), {
    kind: 'completed', label: '充值已完成', terminal: true,
  });
  assert.equal(getTaskStatus({ task_status: 'failed' }).kind, 'failed');
  assert.equal(getTaskStatus({ task_status: 'paying' }).kind, 'processing');
  assert.equal(getTaskStatus({ task_status: 'not_found' }).kind, 'missing');
  assert.equal(formatRechargeType('plus'), 'ChatGPT Plus');
  assert.equal(formatRechargeType('5x'), 'ChatGPT Pro 5×');
  assert.equal(formatRechargeType('20x'), 'ChatGPT Pro 20×');
  assert.equal(getTaskPollDelay('regular', 4), 5000);
  assert.equal(getTaskPollDelay('advanced', 0), 10000);
  assert.equal(getTaskPollDelay('advanced', 1), 15000);
  assert.equal(getTaskPollDelay('advanced', 9), 30000);
});

test('batch results keep input order and mark omitted tasks as no record', () => {
  const results = mergeTaskResults([TEST_CDK, SECOND_CDK], [{
    cdk_code: TEST_CDK,
    task_id: 'TASK-001',
    task_status: 'completed',
  }]);
  assert.equal(results[0].task_id, 'TASK-001');
  assert.equal(results[1].cdk_code, SECOND_CDK);
  assert.equal(results[1].task_status, 'not_found');
  const advancedResults = mergeTaskResults([' tim-abcde fghijk '], [{
    cdk_code: ADVANCED_CDK,
    task_id: 'JZ-TASK-001',
    task_status: 'completed',
  }], 'advanced');
  assert.equal(advancedResults[0].task_id, 'JZ-TASK-001');
});

test('global queue display and China time formatting match the new API', () => {
  assert.equal(getQueueCount({ pending_count: 0, stock: { total: 0 } }), 0);
  assert.equal(getQueueCount({ pending_count: '3' }), 3);
  assert.throws(() => getQueueCount({ status: 'ok' }), /队列状态不可用/);
  assert.deepEqual(getQueueDisplay(3), { count: 3, message: '队列 3 个任务' });
  assert.deepEqual(getQueueDisplay(0), { count: 0, message: '队列空闲' });
  assert.deepEqual(getQueueErrorDisplay(), {
    message: '暂时无法获取，点击重试',
  });
  assert.match(formatDateTime('2026-06-30 14:20:00'), /2026-06-30 14:20:00/);
});

test('upstream URL construction keeps the API base path and safe query', () => {
  assert.equal(createUpstreamBaseUrl('https://apiai.jzplus.org').href, 'https://apiai.jzplus.org/api/v1/');
  assert.equal(createUpstreamBaseUrl('https://apiai.jzplus.org/api/v1').href, 'https://apiai.jzplus.org/api/v1/');
  assert.equal(buildUpstreamUrl('', '/api-proxy/status').pathname, '/api/v1');
  assert.match(buildUpstreamUrl('recharge/verify-cdk', '/api-proxy/verify-cdk').pathname, /\/api\/v1\/recharge\/verify-cdk$/);
  const lookup = buildUpstreamUrl('lookup/tasks', '/api-proxy/lookup/tasks');
  assert.match(lookup.pathname, /\/api\/v1\/lookup\/tasks$/);
  assert.equal(lookup.search, '');
});

test('production startup requires upstream URL and server-side API key', () => {
  assert.doesNotThrow(() => validateProductionConfig({ NODE_ENV: 'development' }));
  assert.throws(() => validateProductionConfig({ NODE_ENV: 'production' }), /REGULAR_API_BASE_URL.*STATION_API_KEY/);
  assert.doesNotThrow(() => validateProductionConfig({
    NODE_ENV: 'production',
    CDK_API_BASE_URL: 'https://apiai.jzplus.org',
    STATION_API_KEY: 'test-key',
  }));
  assert.doesNotThrow(() => validateProductionConfig({
    RENDER: 'true',
    CDK_API_BASE_URL: 'https://apiai.jzplus.org',
    ALLOW_EMPTY_STATION_API_KEY: '1',
  }));
  assert.throws(() => validateProductionConfig({
    NODE_ENV: 'production',
    CDK_API_BASE_URL: 'http://apiai.jzplus.org',
    STATION_API_KEY: 'test-key',
  }), /常规充值.*HTTPS/);
  assert.throws(() => validateProductionConfig({
    NODE_ENV: 'production',
    CDK_API_BASE_URL: 'https://apiai.jzplus.org',
    STATION_API_KEY: 'test-key',
    ADVANCED_API_BASE_URL: 'http://jzplus.org',
  }), /进阶充值.*HTTPS/);
});

test('production process exits before listening when required secrets are missing', () => {
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: __dirname,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RENDER: '',
      CDK_API_BASE_URL: '',
      STATION_API_KEY: '',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /生产环境缺少必要配置/);
});

test('proxy rejects malformed input before upstream forwarding', () => {
  assert.match(validateProxyPayload('recharge/verify-cdk', { cdk_code: 'abc' }), /cdk_code/);
  assert.match(validateProxyPayload('recharge/create-task', {
    cdk_code: TEST_CDK,
    session_json: JSON.stringify({ sessionToken: 'session-token', user: { email: 'x@example.com' } }),
  }), /accessToken/);
  assert.match(validateProxyPayload('recharge/create-task', {
    cdk_code: TEST_CDK,
    session_json: JSON.stringify({ accessToken: 'token', user: { email: 'x@example.com' } }),
  }), /sessionToken/);
  assert.match(validateProxyPayload('recharge/refresh-cdk', { cdk_code: 'abc' }), /cdk_code/);
  assert.match(validateProxyPayload('recharge/cancel-task', { cdk_code: 'abc' }), /cdk_code/);
  assert.match(validateProxyPayload('recharge/check-subscription', { token_input: '' }), /token_input/);
  assert.match(validateProxyPayload('lookup/tasks', { codes: [] }), /1–100/);
  assert.match(validateProxyPayload('lookup/tasks', { codes: ['A'.repeat(129)] }), /格式或长度/);
  assert.match(validateProxyPayload('lookup/tasks', { codes: ['ABCD\nEFGH'] }), /格式或长度/);
  assert.equal(validateProxyPayload({ channel: 'advanced', upstreamPath: 'recharge/verify-cdk' }, { cdk_code: ' tim-abcde fghijk ' }), null);
  assert.match(validateProxyPayload({ channel: 'advanced', upstreamPath: 'recharge/verify-cdk' }, { cdk_code: TEST_CDK }), /cdk_code/);
});

test('HTTP boundary enforces methods, content type, static allowlist, and rate limits', async (t) => {
  resetRateLimits();
  const server = createServer();
  assert.equal(server.headersTimeout, 15000);
  assert.equal(server.requestTimeout, 30000);
  assert.equal(server.maxHeadersCount, 100);
  assert.equal(server.maxRequestsPerSocket, 100);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const wrongMethod = await request(server, { path: '/api-proxy/verify-cdk' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');
  assert.match(wrongMethod.headers['content-security-policy'], /connect-src 'self'/);
  assert.match(wrongMethod.headers['content-security-policy'], /object-src 'none'/);
  assert.match(wrongMethod.headers['content-security-policy'], /frame-src 'none'/);
  assert.doesNotMatch(wrongMethod.headers['content-security-policy'], /jzai16888/);

  const announcementWrongMethod = await request(server, {
    path: '/api-proxy/announcement',
    method: 'POST',
  });
  assert.equal(announcementWrongMethod.status, 405);
  assert.equal(announcementWrongMethod.headers.allow, 'GET');

  const queueEventsWrongMethod = await request(server, {
    path: '/api-proxy/queue-events',
    method: 'POST',
  });
  assert.equal(queueEventsWrongMethod.status, 405);
  assert.equal(queueEventsWrongMethod.headers.allow, 'GET');

  const wrongType = await request(server, {
    path: '/api-proxy/verify-cdk',
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(wrongType.status, 415);

  const invalidPayload = await request(server, {
    path: '/api-proxy/verify-cdk',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cdk_code: 'abc' }),
  });
  assert.equal(invalidPayload.status, 400);

  const deprecatedLookup = await request(server, { path: '/api-proxy/lookup/task?cdk_code=abc' });
  assert.equal(deprecatedLookup.status, 404);

  const unavailableAdvancedAction = await request(server, { path: '/api-proxy/advanced/refresh-cdk' });
  assert.equal(unavailableAdvancedAction.status, 404);

  const health = await request(server, { path: '/healthz' });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });

  const homepage = await request(server, { path: '/' });
  assert.equal(homepage.status, 200);
  assert.equal(homepage.headers['cache-control'], 'no-cache');
  assert.match(homepage.headers['strict-transport-security'], /max-age=31536000/);

  const appAsset = await request(server, { path: '/app.js' });
  assert.equal(appAsset.status, 200);
  assert.match(appAsset.headers['cache-control'], /max-age=300/);

  const logoAsset = await request(server, { path: '/assets/tim-letter-logo-web.png' });
  assert.equal(logoAsset.status, 200);
  assert.equal(logoAsset.headers['content-type'], 'image/png');
  assert.ok(logoAsset.body.length > 0);

  for (const hiddenPath of ['/server.js', '/server.test.js', '/package.json', '/README.md', '/.git/HEAD']) {
    const hiddenFile = await request(server, { path: hiddenPath });
    assert.equal(hiddenFile.status, 404, `${hiddenPath} must not be publicly served`);
  }

  resetRateLimits();
  for (let index = 0; index < 40; index += 1) {
    const malformed = await request(server, {
      path: index % 2 === 0 ? '/api-proxy/create-task' : '/api-proxy/regular/create-task',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
  }
  const rawLimited = await request(server, {
    path: '/api-proxy/create-task',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(rawLimited.status, 429);
  assert.equal(enforceRateLimit({ socket: { remoteAddress: '127.0.0.1' } }, {}, '/api-proxy/create-task'), true);
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
