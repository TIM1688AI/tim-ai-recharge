'use strict';
const crypto = require('node:crypto');
const { card, PRODUCTS, LABELS, productFromPlan, mask } = require('./card-catalog');
const { fail, equal, config, vault, checkPassword, totpCounter, readJson } = require('./workbench-security');
const { createStore } = require('./workbench-store');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value) { if (!UUID.test(String(value || ''))) fail(400, '请求编号不正确'); return value; }
function selection(p) { if (!PRODUCTS[p.channel]?.includes(p.product)) fail(400, '请选择通道和产品'); }
function identityFor(channel, p) {
  let s = {};
  if (channel !== 'premium') {
    if (typeof p.session_json !== 'string' || p.session_json.length > 256 * 1024) fail(400, '请输入 Session JSON');
    try { s = JSON.parse(p.session_json); } catch { fail(400, 'Session JSON 格式不正确'); }
    if (!s || typeof s !== 'object' || Array.isArray(s)) fail(400, 'Session JSON 格式不正确');
    if (channel === 'regular' && (![s.accessToken || s.access_token, s.sessionToken || s.session_token].every(x => typeof x === 'string' && x.trim()))) fail(400, '常规通道 Session 缺少 accessToken 或 sessionToken');
  }
  const account = channel === 'premium' ? String(p.account_id || '').trim().toLowerCase() : String(s.account?.id || '').trim();
  const email = String(channel === 'premium' ? p.email || '' : s.user?.email || s.account?.email || s.email || '').trim();
  if (channel === 'premium' && (!UUID.test(account) || account !== String(p.account_confirm || '').trim().toLowerCase())) fail(400, '请核对两次输入的账号/组织 ID');
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) fail(400, '邮箱格式不正确');
  if (account.length > 128 || (!account && !email)) fail(400, '无法识别充值账号');
  return { account_id: account, email };
}
function stateOf(data) {
  const value = data?.task_status || data?.status;
  const state = ({ completed: 'success', success: 'success', failed: 'failed', pending: 'processing', submitted: 'processing', processing: 'processing', paying: 'processing' })[value] || 'unknown';
  const supplied = typeof data?.completed_at === 'string' ? data.completed_at : '';
  const explicitZone = /(?:Z|[+-]\d\d:?\d\d)$/i.test(supplied);
  const time = Date.parse(explicitZone ? supplied : supplied.replace(' ', 'T') + '+08:00');
  const completed = Number.isFinite(time) && time <= Date.now() + 300000 ? new Date(time).toISOString() : null;
  return { state, completed_at: completed, task_id: typeof data?.task_id === 'string' ? data.task_id.slice(0, 160) : '', note: state === 'unknown' ? '结果待确认，只查询原任务' : state === 'failed' ? '供应商处理失败，卡密已隔离' : state === 'success' && !completed ? '供应商未提供有效完成时间，按本站确认时间记录' : '' };
}
function parseLines(text) {
  if (typeof text !== 'string' || text.length > 100000) fail(400, '请导入不超过 100 KB 的单列 TXT/CSV');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (/^(card|code|卡密)$/i.test(lines[0])) lines.shift();
  if (!lines.length || lines.length > 500) fail(400, '每次导入 1–500 张卡密');
  return lines.map(line => /^"[^"\r\n]*"$/.test(line) ? line.slice(1, -1) : line);
}
function csv(rows) { return '\ufeff' + rows.map(row => row.map(v => { const s = String(v ?? ''); return '"' + (/^[\s]*[=+@-]/.test(s) ? "'" + s : s).replaceAll('"', '""') + '"'; }).join(',')).join('\r\n'); }
function createWorkbench({ invoke, send, env = process.env, pool: suppliedPool }) {
  if (env.ADMIN_ENABLED !== '1' && env.ADMIN_INVENTORY_GUARD !== '1') return { enabled: false, guard: false, handle: async (req, res) => send(res, 404, { error: 'Not found' }), publicInvoke: invoke, close() {} };
  const cfg = config(env), v = vault(cfg.key);
  const pool = suppliedPool || new (require('pg').Pool)({ connectionString: env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5000, query_timeout: 15000, statement_timeout: 15000 });
  pool.on?.('error', () => {}); // Requests fail closed; never print driver errors that may include connection details.
  const store = createStore(pool);
  const ready = (async () => {
    const check = v.hash('workbench-data-key-check-v1');
    await store.query('INSERT INTO wb_settings(id,key_check) VALUES(1,$1) ON CONFLICT DO NOTHING', [check]);
    const saved = (await store.query('SELECT key_check FROM wb_settings WHERE id=1')).rows[0];
    if (!saved || !equal(saved.key_check, check)) throw new Error('Data key does not match the database');
  })();
  ready.catch(() => {}); // Fail closed in handlers, without an unhandled rejection or secret-bearing log.
  const digest = item => v.hash('card:' + item.channel + ':' + item.supplier);
  const cookieName = cfg.secure ? '__Host-tim_admin' : 'tim_admin_local';
  const cookie = (token, expiry = 28800) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expiry}${cfg.secure ? '; Secure' : ''}`;
  const identifyHash = who => v.hash('identity:' + (who.account_id || who.email).toLowerCase());
  async function credentials(p) {
    const attempt = (await store.query("UPDATE wb_auth SET attempts=CASE WHEN window_at<now()-interval '15 minutes' THEN 1 ELSE attempts+1 END,window_at=CASE WHEN window_at<now()-interval '15 minutes' THEN now() ELSE window_at END WHERE id=1 AND (attempts<10 OR window_at<now()-interval '15 minutes') RETURNING id")).rowCount;
    if (!attempt) fail(429, '登录尝试过多，请 15 分钟后重试');
    const counter = totpCounter(cfg.totp, p.otp);
    if (!await checkPassword(p.password, cfg.password) || counter < 0) fail(401, '密码或动态验证码错误');
    const accepted = await store.query('UPDATE wb_auth SET last_totp=$1,attempts=0 WHERE id=1 AND last_totp<$1 RETURNING id', [counter]);
    if (!accepted.rowCount) fail(401, '验证码已使用，请等待下一组验证码');
  }
  async function session(req, mutate) {
    const token = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) fail(401, '请先登录工作台');
    const row = (await store.query('SELECT * FROM wb_sessions WHERE digest=$1 AND expires_at>now()', [v.hash('session:' + token)])).rows[0];
    if (!row) fail(401, '登录已过期，请重新登录');
    if (mutate && !equal(row.csrf, req.headers['x-csrf-token'] || '')) fail(403, '请求校验失败，请刷新页面');
    return row;
  }
  function elevated(s) { if (new Date(s.elevated_until).getTime() < Date.now()) fail(403, '请先重新验证身份，再查看或导出敏感数据'); }
  async function verifyStock(stock) {
    const c = v.open(stock.secret);
    const result = await invoke(stock.channel, 'verify-cdk', { cdk_code: c.public });
    if (result.valid !== true || productFromPlan(result.plan_type) !== stock.product) fail(409, '卡密不可用或供应商产品未匹配，已保留待处理');
    if (stock.channel === 'advanced' || stock.channel === 'premium') {
      const result = await invoke(stock.channel, 'lookup/tasks', { codes: [c.public] });
      const task = result.tasks?.find(t => t.cdk_code === c.public);
      if (stock.channel === 'advanced' ? task?.task_status !== 'active' : task?.task_status !== 'not_found' || Boolean(task.task_id)) fail(409, '供应商未确认卡密未使用，或仍关联旧订单；不能自动分配');
    }
    if (stock.channel === 'premium' && result.redeem_type !== (stock.product.startsWith('claude_') ? 'claude_org_id' : 'chatgpt_account_id')) fail(409, '供应商兑换目标与产品不匹配');
    return c;
  }
  async function checkAccount(p) {
    selection(p); const who = identityFor(p.channel, p);
    if (p.channel !== 'premium') {
      const r = await invoke(p.channel, 'check-subscription', { token_input: p.session_json });
      const s = r.summary, plan = String(s?.plan_type || s?.subscription_plan || '').toLowerCase();
      if (r.ok !== true || !s || s.is_team === true || plan.includes('team')) fail(422, '账号检查未通过或属于 Team');
      if (p.channel === 'regular' && (s.has_active_subscription === true || /plus|pro/.test(plan))) fail(422, '常规通道不支持已有 Plus / Pro 账号');
      if (p.channel === 'advanced' && (s.can_redeem !== true || s.is_team !== false)) fail(422, '当前账号不符合进阶充值资格');
      return { ...who, replacement: p.channel === 'advanced' && (s.is_paid === true || s.has_active_subscription === true) };
    }
    return { ...who, replacement: false };
  }
  function present(o, full = false) {
    const who = v.open(o.identity);
    return { id: o.id, channel: o.channel, product: o.product, source: o.source, state: o.state, task_id: o.task_id, note: o.note, created_at: o.created_at, completed_at: o.completed_at,
      account_id: full ? who.account_id : mask(who.account_id), email: full ? who.email : who.email ? mask(who.email) : '' };
  }
  async function queryOrder(orderId) {
    const o = (await store.query('SELECT o.*,c.secret FROM wb_orders o JOIN wb_cards c ON c.id=o.card_id WHERE o.id=$1', [orderId])).rows[0];
    if (!o) fail(404, '订单不存在');
    if (['success', 'failed'].includes(o.state)) return o;
    try {
      const c = v.open(o.secret), r = await invoke(o.channel, 'lookup/tasks', { codes: [c.public] });
      const task = r.tasks?.find(t => t.cdk_code === c.public);
      // Card-scoped status only: never choose another card or re-submit a saved target.
      return await store.updateOrder(o.id, stateOf(task));
    } catch { await store.query("UPDATE wb_orders SET next_check=now()+interval '5 minutes' WHERE id=$1", [o.id]); return o; }
  }
  async function submit(p) {
    selection(p); id(p.request_id);
    const who = identityFor(p.channel, p);
    const fingerprint = v.hash(JSON.stringify([p.channel, p.product, who]));
    const prior = await store.existing(p.request_id, fingerprint);
    if (prior) return present(prior);
    const checked = await checkAccount(p);
    if (p.confirmed !== true || checked.replacement && p.overwrite_confirmed !== true) fail(422, '请先核对账号并确认覆盖风险');
    const reservation = await store.reserve({ key: p.request_id, fingerprint, channel: p.channel, product: p.product, identity: v.seal(who), identityHash: identifyHash(who) });
    if (!reservation.fresh) return present(reservation.order);
    const { order, stock } = reservation;
    let c;
    try { c = await verifyStock(stock); }
    catch { return present(await store.updateOrder(order.id, { state: 'failed', note: '提交前卡密检查失败，未调用充值；请核查库存' })); }
    try {
      const payload = p.channel === 'premium' ? { cdk_code: c.public, account_id: who.account_id, account_confirm: who.account_id, redeem_type: p.product.startsWith('claude_') ? 'claude_org_id' : 'chatgpt_account_id' } : { cdk_code: c.public, session_json: p.session_json };
      const result = await invoke(p.channel, 'create-task', payload);
      return present(await store.updateOrder(order.id, stateOf(result)));
    } catch { return present(await store.updateOrder(order.id, { state: 'unknown', note: '提交结果待确认，请查询原订单，不要重新充值' })); }
  }
  async function publicInvoke(channel, name, payload) {
    if (!['create-task', 'refresh-cdk', 'cancel-task'].includes(name)) return invoke(channel, name, payload);
    await ready;
    let normalized;
    try { normalized = card(channel, payload.cdk_code, { product: 'plus' }); }
    catch {
      // Public validators already determine syntax; identity is independent of selected product.
      try { normalized = card(channel, payload.cdk_code); } catch { if (channel === 'regular') normalized = { channel, supplier: String(payload.cdk_code).trim() }; else fail(400, '卡密格式错误'); }
    }
    const d = digest(normalized);
    if (name !== 'create-task') {
      if ((await store.query('SELECT 1 FROM wb_cards WHERE digest=$1', [d])).rowCount) fail(409, '工作台管理的卡密请在工作台处理');
      return invoke(channel, name, payload);
    }
    const who = identityFor(channel, payload);
    const order = await store.publicClaim(d, v.seal(who), identifyHash(who));
    try { const result = await invoke(channel, name, payload); if (order) await store.updateOrder(order.id, stateOf(result)); return result; }
    catch (e) { if (order) await store.updateOrder(order.id, { state: 'unknown', note: '公众入口提交结果待确认' }); throw e; }
  }
  async function handle(req, res, pathname) {
    try {
      if (env.ADMIN_ENABLED !== '1') fail(404, 'Not found');
      await ready;
      if (!['GET', 'POST'].includes(req.method)) fail(405, '不支持的请求方法');
      const write = req.method === 'POST';
      if (write && req.headers.origin !== cfg.origin) fail(403, '来源校验失败');
      const route = pathname.slice('/admin-api/v1'.length);
      const p = write ? await readJson(req) : {};
      if (route === '/login' && write) {
        await credentials(p);
        const token = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
        await store.query('DELETE FROM wb_sessions WHERE expires_at<=now()');
        await store.query("INSERT INTO wb_sessions(digest,csrf,expires_at,elevated_until) VALUES($1,$2,now()+interval '8 hours',now()+interval '5 minutes')", [v.hash('session:' + token), csrf]);
        await store.audit(pool, 'login'); return send(res, 200, { csrf }, { 'Set-Cookie': cookie(token) });
      }
      const s = await session(req, write);
      if (route === '/session' && !write) return send(res, 200, { csrf: s.csrf, products: PRODUCTS, labels: LABELS });
      if (route === '/logout' && write) { await store.query('DELETE FROM wb_sessions WHERE digest=$1', [s.digest]); return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); }
      if (route === '/reauth' && write) { await credentials(p); await store.query("UPDATE wb_sessions SET elevated_until=now()+interval '5 minutes' WHERE digest=$1", [s.digest]); await store.audit(pool, 'reauth'); return send(res, 200, { ok: true }); }
      let out;
      if (route === '/availability' && !write) {
        const params = new URL(req.url, cfg.origin).searchParams;
        const selected = { channel: params.get('channel'), product: params.get('product') }; selection(selected);
        out = (await store.query("SELECT count(*)::int available FROM wb_cards WHERE channel=$1 AND product=$2 AND state='available'", [selected.channel, selected.product])).rows[0];
      } else if (route === '/inventory/preview' && write) {
        selection(p); elevated(s); const seen = new Set(); out = [];
        for (const [index, line] of parseLines(p.text).entries()) {
          try { const c = card(p.channel, line, { raw: true, product: p.product }), d = digest(c);
            if (seen.has(d)) throw new Error('本批重复'); seen.add(d);
            if ((await store.query('SELECT 1 FROM wb_cards WHERE digest=$1 UNION ALL SELECT 1 FROM wb_public_claims WHERE digest=$1', [d])).rowCount) throw new Error('已入库或已有提交记录');
            out.push({ line: index + 1, public: c.public, valid: true });
          } catch (e) { out.push({ line: index + 1, valid: false, error: e.safe || !e.code ? e.message : '校验失败' }); }
        }
        await store.audit(pool, 'import_preview');
      } else if (route === '/inventory/import' && write) {
        selection(p); elevated(s); out = [];
        for (const [index, line] of parseLines(p.text).entries()) {
          try { const c = card(p.channel, line, { raw: true, product: p.product }); const cardId = await store.importCard({ ...c, digest: digest(c), secret: v.seal(c), hint: mask(c.public), state: p.already_issued === true ? 'issued' : 'pending' }); out.push({ line: index + 1, id: cardId, ok: true }); }
          catch (e) { if (!e.safe && e.code) throw e; out.push({ line: index + 1, ok: false, error: e.message }); }
        }
      } else if (route === '/inventory/verify' && write) {
        id(p.id); const stock = (await store.query('SELECT * FROM wb_cards WHERE id=$1', [p.id])).rows[0];
        if (!stock || !['pending', 'quarantine'].includes(stock.state)) fail(409, '仅待验证或隔离卡可核查');
        if (stock.state === 'quarantine' && p.release_confirmed !== true) fail(422, '隔离卡回库须确认供应商原订单已终结且卡密未消耗');
        if ((await store.query("SELECT 1 FROM wb_orders WHERE card_id=$1 AND state IN ('pending','processing','unknown','success')", [p.id])).rowCount) fail(409, '该卡仍有未确认或成功订单，不能回库');
        await verifyStock(stock);
        await store.tx(async c => { const r = await c.query("UPDATE wb_cards SET state='available',note='',updated_at=now() WHERE id=$1 AND state=$2 RETURNING id", [stock.id, stock.state]); if (!r.rowCount) fail(409, '卡密状态已变化'); await store.audit(c, 'verify_release', stock.id); }); out = { ok: true };
      } else if (route === '/inventory' && !write) {
        const params = new URL(req.url, cfg.origin).searchParams;
        const offset = Number(params.get('offset') || 0);
        if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) fail(400, '页码无效');
        out = { rows: (await store.query('SELECT id,channel,product,hint,state,note,created_at FROM wb_cards ORDER BY created_at DESC,id LIMIT 100 OFFSET $1', [offset])).rows, total: (await store.query('SELECT count(*)::int total FROM wb_cards')).rows[0].total };
      } else if (route === '/inventory/detail' && write) {
        elevated(s); id(p.id); const stock = (await store.query('SELECT secret FROM wb_cards WHERE id=$1', [p.id])).rows[0];
        if (!stock) fail(404, '卡密不存在'); await store.audit(pool, 'view_card', p.id); out = { public: v.open(stock.secret).public };
      } else if (route === '/batches' && !write) {
        out = (await store.query('SELECT id,channel,product,quantity,created_at FROM wb_batches ORDER BY created_at DESC LIMIT 100')).rows;
      } else if (route === '/issue' && write) {
        elevated(s); selection(p); id(p.request_id); if (!Number.isInteger(p.quantity) || p.quantity < 1 || p.quantity > 100) fail(400, '每批出库 1–100 张');
        out = await store.issue({ key: p.request_id, channel: p.channel, product: p.product, quantity: p.quantity });
      } else if (route === '/batch/download' && write) {
        elevated(s); id(p.id); const rows = (await store.query('SELECT c.secret FROM wb_issued i JOIN wb_cards c ON c.id=i.card_id WHERE i.batch_id=$1 ORDER BY c.created_at,c.id', [p.id])).rows;
        if (!rows.length) fail(404, '批次不存在'); await store.audit(pool, 'download_batch', p.id); out = { text: rows.map(r => v.open(r.secret).public).join('\n') };
      } else if (route === '/account/check' && write) { out = await checkAccount(p);
      } else if (route === '/recharge' && write) { out = await submit(p);
      } else if (route === '/orders/query' && write) { id(p.id); out = present(await queryOrder(p.id));
      } else if (route === '/orders/detail' && write) {
        elevated(s); id(p.id); const o = (await store.query('SELECT * FROM wb_orders WHERE id=$1', [p.id])).rows[0]; if (!o) fail(404, '订单不存在'); await store.audit(pool, 'view_identity', o.id); out = present(o, true);
      } else if (['/orders', '/orders/export'].includes(route) && write) {
        if (route.endsWith('export')) elevated(s);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(p.to || '') || !Number.isFinite(Date.parse(p.from)) || !Number.isFinite(Date.parse(p.to))) fail(400, '请选择开始和结束日期');
        if (Date.parse(p.to) < Date.parse(p.from) || Date.parse(p.to) - Date.parse(p.from) > 366 * 86400000) fail(400, '查询范围须在一年内');
        if (p.channel && !PRODUCTS[p.channel] || p.state && !['pending','processing','success','failed','unknown'].includes(p.state)) fail(400, '筛选条件错误');
        // Identity is encrypted at rest; exact search evaluates in memory within a bounded date range.
        const rows = (await store.query("SELECT * FROM wb_orders WHERE created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND created_at < (($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai') AND ($3='' OR channel=$3) AND ($4='' OR state=$4) ORDER BY created_at DESC LIMIT 10001", [p.from, p.to, p.channel || '', p.state || ''])).rows;
        if (rows.length > 10000) fail(422, '结果超过一万条，请缩小日期范围');
        const found = rows.map(r => present(r, true)).filter(r => (!p.product || r.product === p.product) && (!p.search || [r.account_id, r.email, r.id].some(x => x.toLowerCase().includes(String(p.search).toLowerCase()))));
        if (route.endsWith('export')) { await store.audit(pool, 'export_orders'); out = { csv: csv([['订单号','通道','产品','账号ID','邮箱','结果','提交时间','完成时间','任务编号'], ...found.map(r => [r.id,r.channel,LABELS[r.product],r.account_id,r.email,r.state,new Date(r.created_at).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}),r.completed_at ? new Date(r.completed_at).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}) : '',r.task_id])]) }; }
        else { const offset = Number(p.offset || 0); if (!Number.isInteger(offset) || offset < 0 || offset > 10000) fail(400, '页码无效'); out = { total: found.length, rows: found.slice(offset, offset + 100).map(r => ({ ...r, account_id: mask(r.account_id), email: r.email ? mask(r.email) : '' })) }; }
      } else if (route === '/stats' && !write) {
        out = { daily: (await store.query("SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day,channel,product,count(*)::int AS submitted,count(*) FILTER(WHERE state='failed')::int AS failed,count(*) FILTER(WHERE state IN ('unknown','pending','processing'))::int AS unresolved FROM wb_orders WHERE created_at>=(((now() AT TIME ZONE 'Asia/Shanghai')::date-29)::timestamp AT TIME ZONE 'Asia/Shanghai') GROUP BY 1,2,3 ORDER BY 1 DESC")).rows,
          success: (await store.query("SELECT (completed_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day,channel,product,count(*)::int AS succeeded,count(DISTINCT identity_hash)::int AS accounts FROM wb_orders WHERE state='success' AND completed_at>=(((now() AT TIME ZONE 'Asia/Shanghai')::date-29)::timestamp AT TIME ZONE 'Asia/Shanghai') GROUP BY 1,2,3 ORDER BY 1 DESC")).rows,
          issued: (await store.query("SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day,sum(quantity)::int AS quantity FROM wb_batches WHERE created_at>=(((now() AT TIME ZONE 'Asia/Shanghai')::date-29)::timestamp AT TIME ZONE 'Asia/Shanghai') GROUP BY 1 ORDER BY 1 DESC")).rows,
          inventory: (await store.query('SELECT channel,product,state,count(*)::int AS quantity FROM wb_cards GROUP BY 1,2,3 ORDER BY 1,2,3')).rows };
      } else fail(404, '接口不存在');
      send(res, 200, out);
    } catch (e) { send(res, e.safe ? e.status : 503, { error: e.safe ? e.message : '工作台暂不可用，请检查数据库或稍后查询；不要重复提交充值' }); }
  }
  let checking = false;
  const timer = setInterval(async () => { if (checking) return; checking = true; try { await ready; for (const row of await store.takeDue()) await queryOrder(row.id); } catch { /* No secrets or upstream bodies in logs. */ } finally { checking = false; } }, 30000);
  timer.unref();
  return { enabled: env.ADMIN_ENABLED === '1', guard: true, handle, publicInvoke, store, submit, queryOrder, async close() { clearInterval(timer); if (!suppliedPool) await pool.end(); } };
}
module.exports = { createWorkbench, identityFor, stateOf, parseLines, csv };
