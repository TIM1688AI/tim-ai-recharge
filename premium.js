const crypto = require('crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['invalid', 'unused', 'pending', 'processing', 'used', 'disabled', 'success', 'failed', 'review', 'unknown']);

function normalizeCard(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : '';
}

function isCard(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 64 && /^[\x21-\x7e]+$/.test(value);
}

function validate(routeName, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '请求体必须是 JSON 对象';
  if (routeName === 'verify-cdk' || routeName === 'redeem-status') {
    return isCard(normalizeCard(payload.cdk_code)) ? null : '卡密须为 8–64 位字符';
  }
  if (routeName === 'create-task') {
    if (!isCard(normalizeCard(payload.cdk_code))) return '卡密须为 8–64 位字符';
    if (!UUID.test(String(payload.account_id || ''))) return 'ChatGPT Account ID 须为 36 位 UUID';
    if (payload.account_id !== payload.account_confirm) return '两次填写的 Account ID 不一致';
    return null;
  }
  if (routeName === 'lookup/tasks') {
    return Array.isArray(payload.codes) && payload.codes.length >= 1 && payload.codes.length <= 20
      && payload.codes.every((code) => isCard(normalizeCard(code)))
      ? null : '请提交 1–20 个有效卡密';
  }
  return '不支持的高阶接口';
}

function createPremiumApi({ fetchImpl = fetch, getKey = () => process.env.AGENT_API_KEY,
  baseUrl = process.env.AGENT_API_BASE_URL || 'https://www.vip555ai.com' } = {}) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
    || !['', '/'].includes(origin.pathname)) throw new Error('AGENT_API_BASE_URL 须为 HTTPS 站点根地址');

  async function call(method, endpoint, body) {
    const key = String(getKey() || '').trim();
    if (!key) throw Object.assign(new Error('高阶充值尚未配置，请联系站长'), { status: 503, publicMessage: '高阶充值尚未配置，请联系站长' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), endpoint === '/cards/redeem' ? 25000 : 8000);
    try {
      const response = await fetchImpl(new URL(`/api/agent/v1${endpoint}`, origin), {
        method, redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', 'X-Agent-API-Key': key,
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let raw;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1024 * 1024) {
              await reader.cancel();
              throw new Error('高阶服务返回内容异常');
            }
            chunks.push(Buffer.from(value));
          }
          raw = Buffer.concat(chunks).toString('utf8');
        } finally { reader.releaseLock(); }
      } else {
        raw = await response.text();
        if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('高阶服务返回内容异常');
      }
      let envelope;
      try { envelope = JSON.parse(raw); } catch { throw new Error('高阶服务返回格式异常'); }
      if (!response.ok || envelope?.code !== 0) {
        const code = Number(envelope?.code);
        const publicMessages = {
          100101: '卡密无效', 100102: '卡密已使用', 100103: '卡密已过期',
          100301: '充值失败，请查询卡密状态或联系客服',
          100401: '需要覆盖确认，请联系供应商处理',
          100501: '当前产品库存不足，请稍后再试',
          40300: '高阶通道配置或权限异常，请联系站长',
          40900: '原请求正在处理或幂等冲突，请查询结果，勿重复提交',
          42900: '请求过于频繁，请稍后再试',
        };
        throw Object.assign(new Error(publicMessages[code] || '高阶服务暂不可用，请稍后查询结果'), {
          status: response.status >= 400 ? response.status : 400,
          code, traceId: typeof envelope?.trace_id === 'string' ? envelope.trace_id : '',
          publicMessage: publicMessages[code] || '高阶服务暂不可用，请稍后查询结果',
          review: code === 40900 && envelope?.data?.requires_manual_review === true,
        });
      }
      if (!envelope.data || typeof envelope.data !== 'object') throw new Error('高阶服务返回内容异常');
      return envelope.data;
    } finally { clearTimeout(timeout); }
  }

  function idempotencyKey(card) {
    return `redeem-${crypto.createHmac('sha256', String(getKey() || '')).update(`tim-premium-v1:${card}`).digest('hex')}`;
  }

  function task(card, data) {
    const status = STATUSES.has(data?.status) ? data.status : 'unknown';
    const mapped = {
      unused: 'not_found', pending: 'pending', processing: 'submitted', success: 'completed',
      failed: 'failed', review: 'manual_review', unknown: 'manual_review',
      invalid: 'not_found', used: 'manual_review', disabled: 'manual_review',
    };
    return {
      premium: true, cdk_code: card, task_id: typeof data?.order_no === 'string' ? data.order_no : '',
      task_status: mapped[status], status_label: {
        unused: '尚未兑换', pending: '等待处理', processing: '处理中', success: '充值成功',
        failed: '充值失败', review: '人工复核', unknown: '结果待确认',
        invalid: '卡密无效', used: '卡密已使用，结果待确认', disabled: '卡密不可用',
      }[status],
      stop_polling: data?.stop_polling === true,
      plan_type: typeof data?.product_code === 'string' ? data.product_code : '',
      created_at: data?.submitted_at || null, completed_at: data?.completed_at || null,
      failure_reason: status === 'failed' ? '供应商处理失败，请携卡密联系供应商核对。' : '',
    };
  }

  async function statusForCard(card) {
    try {
      return task(card, await call('GET', `/redeem/${idempotencyKey(card)}`));
    } catch (error) {
      if (error.review) return task(card, { status: 'review', stop_polling: true, message: '请联系客服核对原请求' });
      if (error.status !== 404) throw error;
      return task(card, await call('POST', '/cards/redeem-status', { card_code: card }));
    }
  }

  async function handle(route, payload) {
    const validationError = validate(route.routeName, payload);
    if (validationError) throw Object.assign(new Error(validationError), { status: 400 });
    if (route.routeName === 'verify-cdk') {
      const card = normalizeCard(payload.cdk_code);
      const data = await call('POST', '/cards/probe', { code: card });
      if (data.valid !== true) return { valid: false, error: '卡密无效或不属于当前通道' };
      if (data.status !== 'unused') return { valid: false, pending: ['processing', 'used', 'unknown'].includes(data.status), error: '卡密当前不可提交，请查询结果' };
      if (data.redeem_type !== 'chatgpt_account_id') return { valid: false, error: '此卡密需要其他兑换目标，当前网站暂不支持' };
      return { valid: true, plan_type: String(data.product_name || data.product_code || '') };
    }
    if (route.routeName === 'create-task') {
      const card = normalizeCard(payload.cdk_code);
      const probe = await call('POST', '/cards/probe', { code: card });
      if (probe.valid !== true || probe.status !== 'unused' || probe.redeem_type !== 'chatgpt_account_id') {
        throw Object.assign(new Error('卡密状态已变化，请先查询结果'), { status: 409 });
      }
      const id = payload.account_id.toLowerCase();
      const data = await call('POST', '/cards/redeem', {
        card_code: card, redeem_type: 'chatgpt_account_id', target_value: id,
        target_confirm: id, idempotency_key: idempotencyKey(card),
      });
      const numericStatus = Number(data.status);
      const status = { 1: 'pending', 2: 'processing', 3: 'success', 4: 'failed', 5: 'review' }[numericStatus] || 'unknown';
      return task(card, { ...data, status });
    }
    if (route.routeName === 'redeem-status') {
      const card = normalizeCard(payload.cdk_code);
      return statusForCard(card);
    }
    if (route.routeName === 'lookup/tasks') {
      const cards = [...new Set(payload.codes.map(normalizeCard))];
      const tasks = [];
      for (let index = 0; index < cards.length; index += 4) {
        tasks.push(...await Promise.all(cards.slice(index, index + 4).map(statusForCard)));
      }
      return { tasks };
    }
    throw Object.assign(new Error('不支持的高阶接口'), { status: 404 });
  }

  return { handle };
}

module.exports = { createPremiumApi, validate, normalizeCard };
