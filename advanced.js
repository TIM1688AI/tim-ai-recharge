// Advanced provider boundary. Never log request bodies or redemption codes.
const crypto = require('node:crypto');

function createSubmissionGuard(now = Date.now) {
  const entries = new Map();
  return key => {
    const time = now();
    for (const [digest, expiry] of entries) if (expiry <= time) entries.delete(digest);
    const digest = crypto.createHash('sha256').update(supplierCode(key)).digest('hex');
    if (entries.has(digest)) return null;
    if (entries.size >= 10000) throw new Error('提交繁忙，请稍后查询结果');
    entries.set(digest, Infinity);
    return confirmed => entries.set(digest, now() + (confirmed ? 60000 : 300000));
  };
}
const claim = createSubmissionGuard();

function normalizeCode(value) { return String(value || '').replace(/\s+/g, '').toUpperCase(); }
function validCode(value) {
  return typeof value === 'string' && value.length <= 128 && /^(?:TIM(?:5X|20X)?-[A-Z0-9]{11}|[A-Z0-9]{16})$/.test(normalizeCode(value));
}
function supplierCode(value) {
  if (!validCode(value)) throw new Error('卡密格式不正确');
  return normalizeCode(value).replace(/^TIM(5X|20X)?-/, 'JZ$1-');
}
function publicCode(value) { return String(value || '').replace(/^JZ(5X|20X)?-([A-Z0-9]{11})$/i, 'TIM$1-$2').toUpperCase(); }
function taskResult(data, key) {
  const raw = data.result_status === 'pending' ? 'pending' : data.status;
  const labels = { active: '卡密未使用', used: '卡密已使用，结果待确认', pending: '正在处理', disabled: '卡密已停用', invalid: '卡密无效', receipt_invalid: '充值凭证无效', receipt_used: '凭证已使用，请联系售后核查', failed: '充值失败，请联系售后', unknown: '结果待确认', error: '查询暂不可用，请重试' };
  const status = raw === 'success' ? 'completed' : ['disabled', 'invalid', 'receipt_invalid', 'failed'].includes(raw) ? 'failed' : raw === 'active' ? 'active' : raw === 'pending' ? 'pending' : 'unconfirmed';
  return { cdk_code: publicCode(key), task_status: data.found === false ? 'not_found' : status, status_label: data.found === false ? '未找到卡密' : labels[raw], plan_type: data.product_name || data.tier_code || '', account_email: typeof data.used_by === 'string' ? data.used_by : '', created_at: data.created_at, completed_at: raw === 'success' ? data.used_at : undefined, failure_reason: labels[raw] || '', advanced: true };
}
async function call(endpoint, body) {
  const base = new URL(process.env.ADVANCED_API_BASE_URL || 'https://jzplus.org');
  const target = new URL(`/api/${endpoint}`, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint === 'redeem' ? 120000 : 20000);
  try {
    const response = await fetch(target, { method: body ? 'POST' : 'GET', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, redirect: 'error' });
    let text = '';
    let size = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) { controller.abort(); throw new Error('Invalid response'); }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    if (!response.ok) throw new Error('Provider unavailable');
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response');
    return data;
  } finally { clearTimeout(timer); }
}
async function handle(route, payload = {}) {
  const name = route.routeName;
  if (name === 'announcement') return { enabled: false };
  if (name === 'status') return { ok: true };
  if (name === 'queue-status') {
    const data = await call('stock');
    if (data.success !== true || !data.stock) throw new Error('库存暂不可用');
    return { stock: data.stock };
  }
  if (name === 'check-subscription') {
    const data = await call('check-session', { session: payload.token_input });
    return { ok: data.success === true && data.valid === true, summary: { ...data, account_email: data.email, has_active_subscription: data.is_paid === true }, error: '账号检查未通过，请重新获取 Session 或稍后重试' };
  }
  if (name === 'lookup/tasks') {
    const keys = [...new Set(payload.codes.map(supplierCode))];
    if (keys.length > 50) throw new Error('单次最多查询 50 个卡密');
    if (keys.length === 1) return { tasks: [taskResult(await call('query-key', { key: keys[0] }), keys[0])] };
    const data = await call('query-keys', { keys });
    if (!Array.isArray(data.results)) throw new Error('查询暂不可用');
    return { tasks: keys.map(key => taskResult(data.results.find(item => normalizeCode(item.key) === key) || { status: 'error' }, key)) };
  }
  const key = supplierCode(payload.cdk_code);
  if (name === 'verify-cdk') {
    const data = await call('verify-key', { key });
    return { valid: data.success === true, plan_type: data.product_name || data.tier_code || '', error: '卡密验证未通过，请检查卡密或联系供应商' };
  }
  if (name === 'create-task') {
    // Recheck immediately before submission; never rely on browser eligibility.
    const check = await call('check-session', { session: payload.session_json });
    if (check.success !== true || check.valid !== true || check.can_redeem !== true || check.is_team !== false) throw new Error('当前账号未通过充值资格检查，请重新检查账号');
    const finish = claim(payload.cdk_code);
    if (!finish) return taskResult({ status: 'unknown' }, key);
    let confirmed = false;
    try {
      const data = await call('redeem', { key, session: payload.session_json });
      confirmed = data.success === true;
      return taskResult({ ...data, status: data.success === true ? 'success' : 'unknown', used_by: data.email || data.account_id }, key);
    } catch { return taskResult({ status: 'unknown' }, key); }
    finally { finish(confirmed); }
  }
  throw new Error('不支持的操作');
}
module.exports = { validCode, supplierCode, publicCode, taskResult, handle, createSubmissionGuard };
