'use strict';
const $ = s => document.querySelector(s);
const channels = { regular: '常规充值', advanced: '进阶充值', premium: '高阶充值' };
const states = { pending: '待验证 / 待处理', available: '可用', reserved: '已占用', issued: '已出库', used: '已核销', quarantine: '已隔离', processing: '处理中', success: '成功', failed: '失败', unknown: '待确认' };
let csrf = '', products = {}, labels = {}, currentId = '', requestId = '', issueId = '', stocks = [], importSnapshot = '';
let inventoryOffset = 0, recordsOffset = 0;
let selectedPool = '';
function notice(text) { ($('#reauth-dialog').open ? $('#reauth-error') : $('#notice')).textContent = text; }
function data(form) { return Object.fromEntries(new FormData(form)); }
function text(tag, value, cls) { const e = document.createElement(tag); e.textContent = value ?? '—'; if (cls) e.className = cls; return e; }
function action(label, fn) { const b = text('button', label, 'quiet'); b.type = 'button'; b.onclick = () => run(b, fn); return b; }
async function api(route, body) {
  const res = await fetch('/admin-api/v1' + route, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await res.json();
  if (!res.ok) { if (res.status === 401 && !['/login','/reauth'].includes(route)) { $('#workspace').hidden = true; $('#login-panel').hidden = false; $('#account-actions').hidden = true; } throw new Error(result.error || '请求失败，请稍后查询'); }
  return result;
}
async function run(button, fn) { if (button?.disabled) return; if (button) button.disabled = true; notice(''); try { await fn(); } catch (e) { notice(e.message || '操作未完成，请稍后重试'); } finally { if (button) button.disabled = false; } }
function table(selector, heads, rows) {
  const host = $(selector); host.replaceChildren();
  host.tabIndex = 0; host.setAttribute('role','region'); host.setAttribute('aria-label', heads.join('、') + '，窄屏可横向滚动');
  if (!rows.length) { host.append(text('p', '暂无记录', 'empty muted')); return; }
  const t = document.createElement('table'), head = document.createElement('thead'), tr = document.createElement('tr');
  heads.forEach(h => { const th = text('th', h); th.scope = 'col'; tr.append(th); }); head.append(tr); t.append(head);
  const body = document.createElement('tbody');
  rows.forEach(row => { const r = document.createElement('tr'); row.forEach(value => { const td = document.createElement('td'); if (value instanceof Node) td.append(value); else td.textContent = value ?? '—'; r.append(td); }); body.append(r); }); t.append(body); host.append(t);
}
function date(value) { return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'; }
function download(content, name, type = 'text/plain') { const url = URL.createObjectURL(new Blob([content], { type: type + ';charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function fillProducts(form) { const s = form.querySelector('.product'); s.replaceChildren(...products[form.elements.channel.value].map(p => new Option(labels[p], p))); }
function setInputs() {
  const f = $('#recharge-form'), premium = f.elements.channel.value === 'premium', claude = f.elements.product.value.startsWith('claude_');
  $('#session-input').hidden = premium; $('#premium-input').hidden = !premium; $('#gpt-session').hidden = claude; $('#claude-hint').hidden = !claude;
  $('#target-label').textContent = claude ? 'Claude Organization ID' : 'ChatGPT Account ID';
  void availability();
}
async function availability(force = false) {
  const f = $('#recharge-form'), key = `${f.elements.channel.value}:${f.elements.product.value}`;
  if (!force && key === selectedPool) return; selectedPool = key;
  $('#pool-count').textContent = '正在读取所选产品的可用库存…';
  try { const r = await api('/availability?channel=' + encodeURIComponent(f.elements.channel.value) + '&product=' + encodeURIComponent(f.elements.product.value));
    if (key !== selectedPool) return;
    $('#pool-count').textContent = r.available ? `当前可用 ${r.available} 张 · 以提交时分配结果为准。` : '当前无可用卡密，请先入库并验证；提交时不会跨通道取卡。';
  } catch { if (key === selectedPool) $('#pool-count').textContent = '库存读取失败，请稍后切换通道重试；不能将其视为有库存。'; }
}
function invalidate() { $('#confirmation').hidden = true; $('#recharge-form').elements.confirmed.checked = false; $('#recharge-form').elements.overwrite_confirmed.checked = false; }
async function boot() {
  const s = await api('/session'); csrf = s.csrf; products = s.products; labels = s.labels;
  $('#records-product').replaceChildren(new Option('全部产品', ''), ...Object.entries(labels).map(([k,v]) => new Option(v,k)));
  $('#login-panel').hidden = true; $('#workspace').hidden = false; $('#account-actions').hidden = false;
  document.querySelectorAll('select.channel').forEach(select => { select.replaceChildren(...Object.entries(channels).map(([k, v]) => new Option(v, k))); fillProducts(select.form); });
  setInputs();
}
$('#login-form').onsubmit = e => { e.preventDefault(); run(e.submitter, async () => { const r = await api('/login', data(e.target)); csrf = r.csrf; e.target.reset(); await boot(); }); };
$('#logout').onclick = () => run($('#logout'), async () => { await api('/logout', {}); location.reload(); });
$('#reauth-open').onclick = () => { $('#reauth-error').textContent = ''; $('#reauth-dialog').showModal(); };
$('#reauth-close').onclick = () => { $('#reauth-form').reset(); $('#reauth-dialog').close(); };
$('#reauth-dialog').addEventListener('close', () => $('#reauth-form').reset());
$('#reauth-form').onsubmit = e => { e.preventDefault(); run(e.submitter, async () => { await api('/reauth', data(e.target)); e.target.reset(); $('#reauth-dialog').close(); notice('身份已验证，可在 5 分钟内查看或导出敏感信息。'); }); };
document.querySelectorAll('select.channel').forEach(s => s.onchange = () => { fillProducts(s.form); if (s.form.id === 'recharge-form') setInputs(); });
$('#recharge-form').addEventListener('input', e => { if (!['confirmed', 'overwrite_confirmed'].includes(e.target.name)) { invalidate(); setInputs(); } });
$('#extract').onclick = () => run($('#extract'), async () => { const s = JSON.parse($('#extract-session').value); const account = s.account?.id; if (typeof account !== 'string' || !/^[a-f0-9-]{36}$/i.test(account)) throw new Error('Session 中未找到有效 account.id，请手动填写'); const f = $('#recharge-form'); f.elements.account_id.value = account; f.elements.account_confirm.value = ''; f.elements.email.value = s.user?.email || ''; $('#extract-session').value = ''; invalidate(); notice('已识别账号 ID，请再次输入 ID 核对。'); });
$('#check-account').onclick = () => run($('#check-account'), async () => { const p = data($('#recharge-form')); if (p.channel === 'premium') delete p.session_json; const who = await api('/account/check', p); $('#confirmed-target').textContent = `${channels[p.channel]} · ${labels[p.product]}\n${who.account_id || ''}\n${who.email || ''}`; $('#overwrite-label').hidden = !who.replacement; $('#confirmation').hidden = false; if (!requestId) requestId = crypto.randomUUID(); });
function renderOrder(o) { currentId = o.id; const dl = document.createElement('dl'); [['订单状态', states[o.state]], ['充值类型', `${channels[o.channel]} · ${labels[o.product]}`], ['账号 / 组织 ID', o.account_id], ['邮箱', o.email], ['订单号', o.id], ['供应商任务编号', o.task_id], ['提交时间', date(o.created_at)], ['说明', o.note]].forEach(([k, v]) => { dl.append(text('dt', k), text('dd', v || '—')); }); $('#current-order').replaceChildren(dl); $('#query-current').hidden = ['success','failed'].includes(o.state); $('#new-order').hidden = false; }
$('#recharge-form').onsubmit = e => { e.preventDefault(); run(e.submitter, async () => {
  const f = e.target, p = data(f); if (!f.elements.confirmed.checked) throw new Error('请勾选账号核对确认');
  p.confirmed = true; p.overwrite_confirmed = f.elements.overwrite_confirmed.checked; p.request_id = requestId;
  if (p.channel === 'premium') delete p.session_json;
  try { const o = await api('/recharge', p); renderOrder(o); $('#confirmation').hidden = true; await availability(true); }
  catch (err) { $('#new-order').hidden = false; throw new Error(err.message + '。如提交已发出，可在充值记录查询；重试保持同一请求编号。'); }
  finally { f.elements.session_json.value = ''; $('#extract-session').value = ''; }
}); };
$('#query-current').onclick = () => run($('#query-current'), async () => renderOrder(await api('/orders/query', { id: currentId })));
$('#new-order').onclick = () => { if (!confirm('请确认上一笔已核查。结果不明时请勿给同一账号重复充值。开始新订单？')) return; $('#recharge-form').reset(); requestId = ''; currentId = ''; fillProducts($('#recharge-form')); setInputs(); invalidate(); $('#current-order').replaceChildren(text('p', '等待新的充值订单', 'muted')); $('#new-order').hidden = true; $('#query-current').hidden = true; };
$('#import-file').onchange = async e => { const file = e.target.files[0]; if (!file) return; if (file.size > 100000) { notice('文件超过 100 KB'); return; } $('#import-form').elements.text.value = await file.text(); $('#commit-import').disabled = true; };
$('#import-form').oninput = () => { $('#commit-import').disabled = true; importSnapshot = ''; };
$('#preview-import').onclick = () => run($('#preview-import'), async () => { const p = data($('#import-form')), rows = await api('/inventory/preview', p); $('#import-preview').replaceChildren(...rows.map(r => text('p', `第 ${r.line} 行：${r.valid ? r.public : r.error}`))); importSnapshot = JSON.stringify(p); $('#commit-import').disabled = !rows.some(r => r.valid); notice('预览仅检查格式和重复。确认入库后还需验证供应商状态；无效行不会入库。'); });
$('#import-form').onsubmit = e => { e.preventDefault(); run(e.submitter, async () => { const p = data(e.target); if (JSON.stringify(p) !== importSnapshot) throw new Error('内容已变化，请重新预览'); p.already_issued = e.target.elements.already_issued.checked; const rows = await api('/inventory/import', p); $('#import-preview').replaceChildren(...rows.map(r => text('p', `第 ${r.line} 行：${r.ok ? '已入库' : r.error}`))); e.target.elements.text.value = ''; importSnapshot = ''; notice(`已入库 ${rows.filter(r => r.ok).length} 张，请验证待入库卡密。`); await inventory(); }); };
async function batchDownload(id) { const r = await api('/batch/download', { id }); download(r.text, `TIM-${id}.txt`); }
$('#issue-form').oninput = () => { if (issueId) notice('出库请求已建立；重试请保持原参数。确认上一批结果后，点击“新建下一批”。'); };
$('#issue-form').onsubmit = e => { e.preventDefault(); run(e.submitter, async () => { const p = data(e.target); if (!issueId) issueId = crypto.randomUUID(); p.request_id = issueId; p.quantity = Number(p.quantity); const batch = await api('/issue', p); $('#issue-result').replaceChildren(text('p', `已出库 ${batch.quantity} 张。批次：${batch.id}`), action('下载该批 TIM 卡密', () => batchDownload(batch.id)), action('新建下一批', async () => { issueId = ''; $('#issue-result').replaceChildren(); notice('可提交新的出库批次。'); })); await inventory(); }); };
async function inventory() {
  const [inventoryData, batches] = await Promise.all([api('/inventory?offset=' + inventoryOffset), api('/batches')]); const rows = inventoryData.rows; stocks = rows;
  $('#inventory-count').textContent = `第 ${Math.floor(inventoryOffset / 100) + 1} 页 · 共 ${inventoryData.total} 张`;
  $('#inventory-prev').disabled = inventoryOffset === 0; $('#inventory-next').disabled = inventoryOffset + 100 >= inventoryData.total;
  table('#inventory-table', ['通道 / 产品','卡密','状态','入库时间','操作'], rows.map(r => { const controls = document.createElement('div');
    if (['pending','quarantine'].includes(r.state)) controls.append(action(r.state === 'quarantine' ? '核查后回库' : '验证', async () => { if (r.state === 'quarantine' && !confirm('确认供应商原订单已终结、无延迟扣卡，且卡密未消耗？系统还会重新验证。')) return; await api('/inventory/verify', { id: r.id, release_confirmed: r.state === 'quarantine' }); await inventory(); }));
    controls.append(action('查看卡密', async () => { const c = await api('/inventory/detail', { id: r.id }); controls.replaceChildren(text('p', c.public, 'mono'), text('p', '仅用于核查，请勿直接外发；发卡请走出库流程。'), action('收起', inventory)); }));
    return [channels[r.channel] + ' · ' + labels[r.product], r.hint, text('span', states[r.state], 'status ' + r.state), date(r.created_at), controls]; }));
  table('#batches-table', ['批次','通道 / 产品','数量','时间','操作'], batches.map(b => [b.id, channels[b.channel] + ' · ' + labels[b.product], b.quantity, date(b.created_at), action('下载 TIM 卡密', () => batchDownload(b.id))]));
}
$('#refresh-inventory').onclick = () => run($('#refresh-inventory'), inventory);
$('#verify-pending').onclick = () => run($('#verify-pending'), async () => { const pending = stocks.filter(s => s.state === 'pending'); let ok = 0; for (const [i, s] of pending.entries()) { try { await api('/inventory/verify', { id: s.id }); ok++; } catch { /* Summary below; no raw supplier errors. */ } notice(`正在验证 ${i + 1}/${pending.length} 张`); } await inventory(); notice(`验证完成：${ok} 张可用，${pending.length - ok} 张仍待处理。`); });
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); $('#records-form').elements.from.value = today; $('#records-form').elements.to.value = today;
function recordFilters() { return { ...data($('#records-form')), product: $('#records-product').value, offset: recordsOffset }; }
async function records() { const r = await api('/orders', recordFilters()); $('#records-count').textContent = `共 ${r.total} 条 · 第 ${Math.floor(recordsOffset / 100) + 1} 页`;
  $('#records-prev').disabled = recordsOffset === 0; $('#records-next').disabled = recordsOffset + 100 >= r.total;
  table('#records-table', ['产品 / 通道','账号信息','状态','提交 / 完成','订单 / 任务','操作'], r.rows.map(o => { const operations = document.createElement('div'); operations.append(action('查询结果', async () => { await api('/orders/query', { id: o.id }); await records(); }), action('查看完整账号', async () => { const full = await api('/orders/detail', { id: o.id }); operations.replaceChildren(text('p', `${full.account_id || '无 ID'}\n${full.email || '无邮箱'}`), action('收起', records)); })); return [labels[o.product] + ' · ' + channels[o.channel], (o.account_id || '') + '\n' + (o.email || ''), text('span', states[o.state], 'status ' + o.state), date(o.created_at) + '\n' + date(o.completed_at), o.id + '\n' + (o.task_id || '—'), operations]; })); }
$('#records-form').onsubmit = e => { e.preventDefault(); recordsOffset = 0; run(e.submitter, records); };
$('#records-product').onchange = () => { recordsOffset = 0; run(null, records); };
$('#export-records').onclick = () => run($('#export-records'), async () => { const r = await api('/orders/export', recordFilters()); download(r.csv, '充值记录.csv', 'text/csv'); });
$('#inventory-prev').onclick = () => run(null, async () => { inventoryOffset = Math.max(0, inventoryOffset - 100); await inventory(); });
$('#inventory-next').onclick = () => run(null, async () => { inventoryOffset += 100; await inventory(); });
$('#records-prev').onclick = () => run(null, async () => { recordsOffset = Math.max(0, recordsOffset - 100); await records(); });
$('#records-next').onclick = () => run(null, async () => { recordsOffset += 100; await records(); });
async function stats() { const r = await api('/stats'); const day = d => String(d).slice(0,10); table('#daily-table', ['日期','提交','失败','未确认 / 处理中','产品','通道'], r.daily.map(x => [day(x.day), x.submitted, x.failed, x.unresolved, labels[x.product], channels[x.channel]])); table('#success-table', ['完成日期','成功充值','成功账号','产品','通道'], r.success.map(x => [day(x.day),x.succeeded,x.accounts,labels[x.product],channels[x.channel]])); table('#issued-table', ['日期','出库张数'], r.issued.map(x => [day(x.day),x.quantity])); table('#stock-table', ['数量','状态','产品','通道'], r.inventory.map(x => [x.quantity,states[x.state],labels[x.product],channels[x.channel]])); }
$('#refresh-stats').onclick = () => run($('#refresh-stats'), stats);
document.querySelectorAll('nav button').forEach(button => button.onclick = () => run(null, async () => { document.querySelectorAll('nav button').forEach(b => b.removeAttribute('aria-current')); button.setAttribute('aria-current','page'); document.querySelectorAll('.page').forEach(p => p.hidden = p.id !== 'page-' + button.dataset.page); if (button.dataset.page === 'recharge') await availability(true); if (button.dataset.page === 'inventory') await inventory(); if (button.dataset.page === 'records') await records(); if (button.dataset.page === 'stats') await stats(); }));
boot().catch(() => {});
