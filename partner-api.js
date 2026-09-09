// Invite-only API. Persistent files contain partner IDs, digests and status only,
// never Session, raw cards or API keys.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const advanced = require('./advanced');
const routes = {
  '/cards/verify': 'verify', '/accounts/check': 'check', '/recharges': 'redeem',
  '/recharges/query': 'query', '/recharges/batch-query': 'batch', '/stock': 'stock',
};
function fail(status, code) { throw Object.assign(new Error(code), { status, code }); }
function digest(secret, value) { return crypto.createHmac('sha256', secret).update(value).digest('hex'); }
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function normalize(channel, card) {
  if (typeof card !== 'string') fail(400, 'invalid_card');
  const value = channel === 'advanced' ? card.replace(/\s+/g, '').toUpperCase() : card.trim();
  if (channel === 'advanced' ? !advanced.validCode(value) : value.length < 4 || value.length > 128 || /[\u0000-\u0020\u007f]/.test(value)) fail(400, 'invalid_card');
  return value;
}
function cardHash(secret, channel, card) { return digest(secret, JSON.stringify([channel, normalize(channel, card)])); }
function session(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 256 * 1024) fail(400, 'invalid_session');
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail(400, 'invalid_session'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'invalid_session');
  // Canonical ordering allows equivalent JSON formatting on retries.
  const sort = v => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(parsed));
}
function record(file, data) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function resultStatus(task) {
  const state = String(task?.task_status || task?.status || '');
  return ({ completed: 'success', success: 'success', failed: 'failed', pending: 'processing', submitted: 'processing', manual_review: 'processing', active: 'unused', not_found: 'not_found' })[state] || 'unconfirmed';
}
function eligible(channel, checked) {
  const s = checked.summary || {};
  const plan = String(s.plan_type || '').toLowerCase();
  if (checked.ok !== true || s.is_team === true || plan.includes('team')) return false;
  return channel === 'advanced' ? s.can_redeem === true && s.is_team === false : plan === 'free' && s.has_active_subscription !== true && s.can_redeem !== false;
}
function createPartnerApi({ invoke, send, env = process.env }) {
  const buckets = new Map();
  let inflight = 0;
  function limit(key, maximum) {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.until <= now) buckets.delete(k);
    if (!buckets.has(key)) {
      if (buckets.size >= 10000) fail(429, 'rate_limited');
      buckets.set(key, { until: now + 60000, count: 0 });
    }
    if (++buckets.get(key).count > maximum) fail(429, 'rate_limited');
  }
  function settings() {
    if (env.PARTNER_API_ENABLED !== '1') fail(404, 'not_found');
    const dir = env.PARTNER_DATA_DIR;
    const file = env.PARTNER_CONFIG_FILE;
    const secret = env.PARTNER_HASH_SECRET;
    if (!dir || !file || !path.isAbsolute(dir) || !path.isAbsolute(file) || !secret || secret.length < 32) fail(503, 'configuration_required');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(config.partners)) fail(503, 'configuration_required');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { config, dir, secret };
  }
  async function body(request) {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) fail(415, 'json_required');
    const chunks = []; let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 300 * 1024) fail(413, 'body_too_large');
      chunks.push(chunk);
    }
    try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
    catch { fail(400, 'invalid_json'); }
  }
  return async (request, response, pathname) => {
    let occupied = false;
    try {
      if (env.PARTNER_API_ENABLED !== '1') fail(404, 'not_found');
      limit('global', 600);
      limit(`ip:${request.socket.remoteAddress}`, 180);
      const operation = routes[pathname.slice('/partner-api/v1'.length)];
      if (!operation) fail(404, 'not_found');
      if (request.method !== (operation === 'stock' ? 'GET' : 'POST')) fail(405, 'method_not_allowed');
      if (new URL(request.url, 'http://local').search) fail(400, 'query_parameters_not_allowed');
      const { config, dir, secret } = settings();
      const auth = /^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(request.headers.authorization || '');
      if (!auth) fail(401, 'invalid_api_key');
      const hash = tokenHash(auth[1]);
      const partner = config.partners.find(p => p.enabled === true && Array.isArray(p.key_hashes) && p.key_hashes.some(h => /^[a-f0-9]{64}$/.test(h) && crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'))));
      if (!partner || !/^[A-Za-z0-9_-]{1,64}$/.test(partner.id)) fail(401, 'invalid_api_key');
      limit(`partner:${partner.id}`, Math.min(120, Math.max(1, Number(partner.requests_per_minute) || 60)));
      if (inflight >= 20) fail(429, 'busy');
      inflight++; occupied = true;
      const input = operation === 'stock' ? { channel: 'advanced' } : await body(request);
      const channel = input.channel;
      if (!['regular', 'advanced'].includes(channel) || !partner.channels?.includes(channel)) fail(403, 'channel_not_allowed');
      // Possession model: an authenticated partner may use any valid card on an
      // allowed channel. Card digests are still claimed permanently on submit
      // so changing request_id cannot cause a duplicate redemption.
      function accept(card) { return normalize(channel, card); }
      if (operation === 'stock') {
        const value = await invoke(channel, 'queue-status', {});
        const grade = n => !Number.isSafeInteger(n) || n < 0 ? 'unavailable' : n === 0 ? 'none' : n <= 5 ? 'low' : n <= 15 ? 'medium' : 'high';
        return send(response, 200, { ok: true, stock: Object.fromEntries(['plus', 'plus_year', 'pro5x', 'pro20x'].map(k => [k, grade(value.stock?.[k])])) });
      }
      const cards = operation === 'batch' ? input.cards : [input.card];
      if (!Array.isArray(cards) || cards.length < 1 || cards.length > 50) fail(400, 'invalid_card_count');
      const accepted = [...new Set(cards.map(accept))];
      const card = accepted[0];
      const safeTask = task => ({ status: resultStatus(task), product: typeof task?.plan_type === 'string' ? task.plan_type.slice(0, 120) : null });
      if (operation === 'query' || operation === 'batch') {
        const value = await invoke(channel, 'lookup/tasks', { codes: accepted });
        if (!Array.isArray(value.tasks)) fail(502, 'provider_unavailable');
        return send(response, 200, { ok: true, results: accepted.map(c => {
          const task = value.tasks.find(t => t.cdk_code === c);
          return { card: c, ...safeTask(task) };
        }) });
      }
      if (operation === 'verify') {
        const value = await invoke(channel, 'verify-cdk', { cdk_code: card });
        return send(response, 200, { ok: true, valid: value.valid === true, product: typeof value.plan_type === 'string' ? value.plan_type.slice(0, 120) : null });
      }
      const sessionJson = session(input.session);
      if (operation === 'check') {
        const value = await invoke(channel, 'check-subscription', { token_input: sessionJson });
        const s = value.summary || {};
        return send(response, 200, { ok: value.ok === true, email: typeof s.account_email === 'string' ? s.account_email : null, plan: s.plan_type || null, can_redeem: eligible(channel, value) });
      }
      if (typeof input.request_id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(input.request_id) || input.confirmed !== true) fail(400, 'confirmation_required');
      const id = digest(secret, JSON.stringify([partner.id, input.request_id]));
      const fingerprint = digest(secret, JSON.stringify([channel, card, sessionJson, true]));
      const intentFile = path.join(dir, `request-${id}.json`);
      const outcomeFile = path.join(dir, `result-${id}.json`);
      const claimFile = path.join(dir, `card-${cardHash(secret, channel, card)}.json`);
      const fallback = { request_id: input.request_id, status: 'unconfirmed', product: null };
      try { record(intentFile, { partner_id: partner.id, fingerprint, created_at: new Date().toISOString() }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
        if (intent.fingerprint !== fingerprint) fail(409, 'request_id_conflict');
        if (fs.existsSync(claimFile)) {
          const claim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
          if (claim.request !== id) return send(response, 409, { ok: false, code: 'card_submission_exists', status: 'unconfirmed' });
        }
        const prior = fs.existsSync(outcomeFile) ? JSON.parse(fs.readFileSync(outcomeFile, 'utf8')) : fallback;
        return send(response, prior.status === 'unconfirmed' ? 202 : 200, { ok: true, replayed: true, ...prior });
      }
      // Permanent card claim also prevents a new request ID bypassing deduplication.
      try { record(claimFile, { partner_id: partner.id, request: id }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; return send(response, 409, { ok: false, code: 'card_submission_exists', status: 'unconfirmed' }); }
      let outcome = fallback;
      try {
        const checked = await invoke(channel, 'check-subscription', { token_input: sessionJson });
        if (!eligible(channel, checked)) outcome = { ...fallback, status: 'rejected' };
        else {
          const task = await invoke(channel, 'create-task', { cdk_code: card, session_json: sessionJson });
          outcome = { request_id: input.request_id, ...safeTask(task) };
        }
      } catch { /* Ambiguous results must never trigger automatic redemption retries. */ }
      record(outcomeFile, outcome);
      send(response, ['unconfirmed', 'processing'].includes(outcome.status) ? 202 : 200, { ok: true, ...outcome });
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) send(response, error.status || 503, { ok: false, code: error.code && error.status ? error.code : 'service_unavailable' }, error.status === 429 ? { 'Retry-After': '60' } : {});
    } finally { if (occupied) inflight--; }
  };
}
module.exports = { createPartnerApi, cardHash, tokenHash, resultStatus };
