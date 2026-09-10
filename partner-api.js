// Invite-only API. Persistent records contain partner IDs, digests and status
// only, never Session, raw cards or API keys.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const advanced = require('./advanced');
const routes = {
  '/service/status': 'status', '/announcements/current': 'announcement', '/queue/status': 'queue',
  '/cards/verify': 'verify', '/cards/refresh': 'refresh', '/accounts/check': 'check', '/recharges': 'redeem',
  '/subscriptions/check': 'subscription',
  '/recharges/query': 'query', '/tasks/query': 'query', '/tasks/cancel': 'cancel',
  '/recharges/batch-query': 'batch', '/tasks/batch-query': 'batch', '/stock': 'stock',
};
function fail(status, code) { throw Object.assign(new Error(code), { status, code }); }
function digest(secret, value) { return crypto.createHmac('sha256', secret).update(value).digest('hex'); }
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function outcomeKey(secret) { return crypto.createHash('sha256').update('tim-partner-outcome\0').update(secret).digest(); }
function seal(secret, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', outcomeKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
function unseal(secret, value) {
  try {
    const [version, iv, tag, encrypted] = String(value).split('.');
    if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', outcomeKey(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
  } catch { fail(503, 'storage_unavailable'); }
}
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
function createRedisStore(env = process.env, fetchImpl = globalThis.fetch) {
  const endpoint = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  let url;
  try { url = new URL(endpoint); } catch { fail(503, 'configuration_required'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || typeof token !== 'string' || token.length < 20 || typeof fetchImpl !== 'function') fail(503, 'configuration_required');
  const base = url.toString().replace(/\/$/, '');
  async function command(parts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetchImpl(base, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(parts),
      });
      if (!response.ok) fail(503, 'storage_unavailable');
      const payload = await response.json();
      if (!payload || payload.error || !Object.prototype.hasOwnProperty.call(payload, 'result')) fail(503, 'storage_unavailable');
      return payload.result;
    } catch (error) {
      if (error?.status) throw error;
      fail(503, 'storage_unavailable');
    } finally { clearTimeout(timer); }
  }
  const key = value => `tim-partner:v1:${value}`;
  return {
    async create(name, value) { return (await command(['SET', key(name), JSON.stringify(value), 'NX'])) === 'OK'; },
    async get(name) {
      const value = await command(['GET', key(name)]);
      if (value === null) return null;
      try { return JSON.parse(value); } catch { fail(503, 'storage_unavailable'); }
    },
    async set(name, value) {
      if ((await command(['SET', key(name), JSON.stringify(value)])) !== 'OK') fail(503, 'storage_unavailable');
    },
    async delete(name) { await command(['DEL', key(name)]); },
  };
}
function resultStatus(task) {
  const state = String(task?.task_status || task?.status || '');
  return ({ completed: 'success', success: 'success', failed: 'failed', pending: 'processing', submitted: 'processing', manual_review: 'processing', active: 'unused', not_found: 'not_found' })[state] || 'unconfirmed';
}
function safeText(value, limit) { return typeof value === 'string' ? value.slice(0, limit) : null; }
function eligible(channel, checked) {
  const s = checked.summary || {};
  const plan = String(s.plan_type || '').toLowerCase();
  if (checked.ok !== true || s.is_team === true || plan.includes('team')) return false;
  return channel === 'advanced' ? s.can_redeem === true && s.is_team === false : plan === 'free' && s.has_active_subscription !== true && s.can_redeem !== false;
}
function createPartnerApi({ invoke, send, env = process.env, store }) {
  const buckets = new Map();
  let inflight = 0;
  let runtimeStore = store;
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
    const file = env.PARTNER_CONFIG_FILE;
    const secret = env.PARTNER_HASH_SECRET;
    if (!file || !path.isAbsolute(file) || !secret || secret.length < 32) fail(503, 'configuration_required');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(config.partners)) fail(503, 'configuration_required');
    if (!runtimeStore) runtimeStore = createRedisStore(env);
    return { config, storage: runtimeStore, secret };
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
      const { config, storage, secret } = settings();
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
      const grade = n => !Number.isSafeInteger(n) || n < 0 ? 'unavailable' : n === 0 ? 'none' : n <= 5 ? 'low' : n <= 15 ? 'medium' : 'high';
      if (operation === 'status') {
        await invoke(channel, 'status', {});
        return send(response, 200, { ok: true, available: true, channel });
      }
      if (operation === 'announcement') {
        const value = await invoke(channel, 'announcement', {});
        return send(response, 200, { ok: true, enabled: value.enabled === true, title: safeText(value.title, 120), message: safeText(value.message, 2000) });
      }
      if (operation === 'queue' || operation === 'stock') {
        const value = await invoke(channel, 'queue-status', {});
        if (channel === 'advanced') return send(response, 200, { ok: true, kind: 'stock', stock: Object.fromEntries(['plus', 'plus_year', 'pro5x', 'pro20x'].map(k => [k, grade(value.stock?.[k])])) });
        const pending = Number(value.pending_count);
        if (!Number.isSafeInteger(pending) || pending < 0) fail(502, 'provider_unavailable');
        return send(response, 200, { ok: true, kind: 'queue', pending_count: pending, updated_at: safeText(value.at, 80) });
      }
      if (operation === 'check' || operation === 'subscription') {
        const sessionJson = session(input.session);
        const value = await invoke(channel, 'check-subscription', { token_input: sessionJson });
        const s = value.summary || {};
        return send(response, 200, {
          ok: value.ok === true,
          email: safeText(s.account_email, 320),
          plan: safeText(s.plan_type || s.subscription_plan, 120),
          has_active_subscription: s.has_active_subscription === true,
          is_team: s.is_team === true,
          can_redeem: eligible(channel, value),
          expires_at: safeText(s.expires_at, 80),
        });
      }
      const cards = operation === 'batch' ? input.cards : [input.card];
      const maxCards = operation === 'batch' && channel === 'regular' ? 100 : 50;
      if (!Array.isArray(cards) || cards.length < 1 || cards.length > maxCards) fail(400, 'invalid_card_count');
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
        return send(response, 200, {
          ok: true,
          valid: value.valid === true,
          product: safeText(value.plan_type, 120),
          pending: value.pending === true,
          cancellable: value.cancellable === true,
          refresh_remaining: Number.isSafeInteger(Number(value.refresh_remaining)) ? Math.max(0, Number(value.refresh_remaining)) : 0,
        });
      }
      if (operation === 'refresh' || operation === 'cancel') {
        if (channel !== 'regular') fail(403, 'operation_not_supported');
        if (typeof input.request_id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(input.request_id) || input.confirmed !== true) fail(400, 'confirmation_required');
        const id = digest(secret, JSON.stringify([partner.id, operation, input.request_id]));
        const fingerprint = digest(secret, JSON.stringify([operation, channel, card, true]));
        const intentKey = `action:${operation}:request:${id}`;
        const outcomeKeyName = `action:${operation}:result:${id}`;
        const claimKey = `card:${cardHash(secret, channel, card)}`;
        const publicOutcome = stored => {
          if (!stored) return { request_id: input.request_id, status: 'unconfirmed' };
          if (operation !== 'refresh' || !stored.sealed_new_card) return stored;
          const { sealed_new_card, ...rest } = stored;
          return { ...rest, new_card: unseal(secret, sealed_new_card) };
        };
        if (!await storage.create(intentKey, { partner_id: partner.id, fingerprint, created_at: new Date().toISOString() })) {
          const intent = await storage.get(intentKey);
          if (!intent) fail(503, 'storage_unavailable');
          if (intent.fingerprint !== fingerprint) fail(409, 'request_id_conflict');
          const prior = publicOutcome(await storage.get(outcomeKeyName));
          return send(response, prior.status === 'unconfirmed' ? 202 : 200, { ok: true, replayed: true, ...prior });
        }
        if (operation === 'refresh' && !await storage.create(claimKey, { partner_id: partner.id, request: id, action: operation })) {
          return send(response, 409, { ok: false, code: 'card_submission_exists', status: 'unconfirmed' });
        }
        let outcome = { request_id: input.request_id, status: 'unconfirmed' };
        try {
          if (operation === 'refresh') {
            const value = await invoke(channel, 'refresh-cdk', { cdk_code: card });
            const newCard = normalize(channel, value.new_code);
            outcome = { request_id: input.request_id, status: 'success', new_card: newCard, message: safeText(value.message, 500) };
          } else {
            const value = await invoke(channel, 'cancel-task', { cdk_code: card });
            if (value.ok === true) {
              await storage.delete(claimKey);
              outcome = { request_id: input.request_id, status: 'success', cancelled: true, message: safeText(value.message, 500) };
            } else outcome = { request_id: input.request_id, status: 'failed', cancelled: false, message: safeText(value.error || value.message, 500) };
          }
        } catch { /* Store an uncertain outcome; never repeat a destructive action automatically. */ }
        const stored = operation === 'refresh' && outcome.new_card
          ? { ...outcome, new_card: undefined, sealed_new_card: seal(secret, outcome.new_card) }
          : outcome;
        await storage.set(outcomeKeyName, stored);
        return send(response, outcome.status === 'unconfirmed' ? 202 : 200, { ok: true, ...outcome });
      }
      const sessionJson = session(input.session);
      if (typeof input.request_id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(input.request_id) || input.confirmed !== true) fail(400, 'confirmation_required');
      const id = digest(secret, JSON.stringify([partner.id, input.request_id]));
      const fingerprint = digest(secret, JSON.stringify([channel, card, sessionJson, true]));
      const intentKey = `request:${id}`;
      const outcomeKey = `result:${id}`;
      const claimKey = `card:${cardHash(secret, channel, card)}`;
      const fallback = { request_id: input.request_id, status: 'unconfirmed', product: null };
      if (!await storage.create(intentKey, { partner_id: partner.id, fingerprint, created_at: new Date().toISOString() })) {
        const intent = await storage.get(intentKey);
        if (!intent) fail(503, 'storage_unavailable');
        if (intent.fingerprint !== fingerprint) fail(409, 'request_id_conflict');
        const claim = await storage.get(claimKey);
        if (claim && claim.request !== id) return send(response, 409, { ok: false, code: 'card_submission_exists', status: 'unconfirmed' });
        const prior = await storage.get(outcomeKey) || fallback;
        return send(response, prior.status === 'unconfirmed' ? 202 : 200, { ok: true, replayed: true, ...prior });
      }
      // Permanent card claim also prevents a new request ID bypassing deduplication.
      if (!await storage.create(claimKey, { partner_id: partner.id, request: id })) return send(response, 409, { ok: false, code: 'card_submission_exists', status: 'unconfirmed' });
      let outcome = fallback;
      try {
        const checked = await invoke(channel, 'check-subscription', { token_input: sessionJson });
        if (!eligible(channel, checked)) outcome = { ...fallback, status: 'rejected' };
        else {
          const task = await invoke(channel, 'create-task', { cdk_code: card, session_json: sessionJson });
          outcome = { request_id: input.request_id, ...safeTask(task) };
        }
      } catch { /* Ambiguous results must never trigger automatic redemption retries. */ }
      await storage.set(outcomeKey, outcome);
      send(response, ['unconfirmed', 'processing'].includes(outcome.status) ? 202 : 200, { ok: true, ...outcome });
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) send(response, error.status || 503, { ok: false, code: error.code && error.status ? error.code : 'service_unavailable' }, error.status === 429 ? { 'Retry-After': '60' } : {});
    } finally { if (occupied) inflight--; }
  };
}
module.exports = { createPartnerApi, createRedisStore, cardHash, tokenHash, resultStatus };
