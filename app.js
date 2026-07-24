const CONFIG = {
  brandName: "Tim AI",
  apiBase: "https://jzai16888.com/api/v1",
  proxyBase: "/api-proxy",
  requestTimeout: 25000,
};

const state = {
  verifiedCardKey: "",
  modalReturnFocus: null,
  accountModalReturnFocus: null,
  pendingRedeemSession: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function configureBrand() {
  $$('[data-brand]').forEach((el) => { el.textContent = CONFIG.brandName; });
  document.title = `${CONFIG.brandName} · AI 会员充值`;
}

function showToast(message, type = "info") {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast show ${type === 'error' ? 'error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 3200);
}

function setLoading(button, loading, label) {
  button.disabled = loading;
  if (loading) {
    button.dataset.label = $('span', button).textContent;
    $('span', button).textContent = label;
  } else if (button.dataset.label) {
    $('span', button).textContent = button.dataset.label;
  }
}

async function apiRequest(path, body, { proxyOnly = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeout);
  try {
    const bases = proxyOnly ? [CONFIG.proxyBase] : [CONFIG.apiBase];
    if (!proxyOnly && (location.protocol === 'http:' || location.protocol === 'https:') && CONFIG.proxyBase) {
      bases.push(CONFIG.proxyBase);
    }

    let lastError;
    for (let index = 0; index < bases.length; index += 1) {
      try {
        const response = await fetch(`${bases[index]}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.message || `请求失败（${response.status}）`);
        if (!payload) throw new Error('接口返回格式异常');
        return payload;
      } catch (error) {
        lastError = error;
        const canRetryThroughProxy = error instanceof TypeError && index < bases.length - 1;
        if (!canRetryThroughProxy) throw error;
      }
    }
    throw lastError;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时，请稍后重试');
    if (error instanceof TypeError) throw new Error('无法连接充值接口，请检查网络或接口跨域设置');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeKey(value) {
  const compact = String(value || '').trim().replace(/\s/g, '');
  const match = compact.match(/^([a-z0-9]{1,32})-([a-z0-9]{16})$/i);
  return match ? `${match[1]}-${match[2].toUpperCase()}` : compact;
}

function isPlausibleKey(value) {
  return /^[A-Za-z0-9]{1,32}-[A-Z0-9]{16}$/.test(value);
}

function getCardKeyFromUrl(search) {
  const rawCardKey = new URLSearchParams(String(search || '')).get('card');
  if (!rawCardKey) return '';
  const cardKey = normalizeKey(rawCardKey);
  return isPlausibleKey(cardKey) ? cardKey : '';
}

function getInventoryLabel(availableValue, queuedValue, maintenance = false) {
  if (maintenance) return { kind: 'maintenance', text: '通道维护中' };
  const available = Math.max(0, Math.floor(Number(availableValue) || 0));
  const queued = Math.max(0, Math.floor(Number(queuedValue) || 0));
  if (queued > 0) return { kind: 'queued', text: `需排队 ${queued + 1} 位` };
  if (available > 0) return { kind: 'available', text: '无需排队' };
  return { kind: 'empty', text: '暂无库存' };
}

async function loadInventoryStatus() {
  const section = $('#inventory-status');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${CONFIG.proxyBase}/inventory-status`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.code !== 0 || !payload.data || typeof payload.data !== 'object') {
      throw new Error('库存状态不可用');
    }

    const data = payload.data;
    const products = [
      ['#inventory-plus', data.plusAvailable, data.plusQueued],
      ['#inventory-prolite', data.proliteAvailable, data.proliteQueued],
      ['#inventory-pro', data.proAvailable, data.proQueued],
    ];
    products.forEach(([selector, available, queued]) => {
      const status = getInventoryLabel(available, queued, data.maintenance === true);
      const element = $(selector);
      element.textContent = status.text;
      element.dataset.state = status.kind;
    });
    section.classList.remove('hidden');
  } catch {
    section.classList.add('hidden');
  } finally {
    clearTimeout(timer);
  }
}

function prefillCardKeyFromUrl() {
  const cardKey = getCardKeyFromUrl(location.search);
  if (!cardKey) return;

  $('#card-key').value = cardKey;
  const params = new URLSearchParams(location.search);
  params.delete('card');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

function canRedeemCard(data) {
  const status = Number(data?.status);
  return status === 4 || (data?.valid === true && status === 0);
}

function maskKey(key) {
  const prefix = key.split('-', 1)[0];
  return `${prefix}-•••• •••• •••• ${key.slice(-4)}`;
}

function showStep(step) {
  $$('.step-section, .result-section').forEach((section) => {
    section.classList.toggle('hidden', Number(section.dataset.section) !== step);
  });
  $$('.steps li').forEach((item) => {
    const active = Number(item.dataset.step) <= step;
    item.classList.toggle('active', active);
    if (Number(item.dataset.step) === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
}

function openOverrideModal() {
  state.modalReturnFocus = document.activeElement;
  $('#override-modal').classList.remove('hidden');
  $('.override-modal-close').focus();
}

function clearPendingRedeemSession() {
  state.pendingRedeemSession = null;
  $('#confirm-account-value').textContent = '';
}

function closeOverrideModal({ restoreFocus = true, clearPending = true } = {}) {
  $('#override-modal').classList.add('hidden');
  if (restoreFocus && state.modalReturnFocus instanceof HTMLElement) {
    state.modalReturnFocus.focus();
  }
  state.modalReturnFocus = null;
  if (clearPending) clearPendingRedeemSession();
}

function openAccountConfirmModal(sessionInfo) {
  state.accountModalReturnFocus = document.activeElement;
  state.pendingRedeemSession = Object.freeze({ ...sessionInfo });
  $('#confirm-account-value').textContent = sessionInfo.accountLabel;
  $('#account-confirm-modal').classList.remove('hidden');
  $('#cancel-account-redeem').focus();
}

function closeAccountConfirmModal({ restoreFocus = true, clearPending = true } = {}) {
  $('#account-confirm-modal').classList.add('hidden');
  $('#confirm-account-value').textContent = '';
  if (restoreFocus && state.accountModalReturnFocus instanceof HTMLElement) {
    state.accountModalReturnFocus.focus();
  }
  state.accountModalReturnFocus = null;
  if (clearPending) clearPendingRedeemSession();
}

function resetRecharge() {
  state.verifiedCardKey = '';
  closeAccountConfirmModal({ restoreFocus: false });
  closeOverrideModal({ restoreFocus: false });
  $('#recharge-form').reset();
  $('#card-key').value = '';
  $('#expires-date').textContent = '—';
  showStep(1);
}

async function verifyCard() {
  const button = $('#verify-btn');
  if (button.disabled) return;
  const cardKey = normalizeKey($('#card-key').value);
  $('#card-key').value = cardKey;
  if (!isPlausibleKey(cardKey)) {
    showToast('请输入“产品前缀-16位卡密”格式', 'error');
    $('#card-key').focus();
    return;
  }

  setLoading(button, true, '正在验证…');
  try {
    const result = await apiRequest('/verify-cardkey', { cardKey });
    if (result.code !== 0 || !canRedeemCard(result.data)) {
      throw new Error(result.data?.message || result.message || '该卡密当前不可使用');
    }
    state.verifiedCardKey = cardKey;
    $('#masked-card-key').textContent = maskKey(cardKey);
    showStep(2);
    $('#session-json').focus();
    showToast(Number(result.data.status) === 4 ? '卡密可重新提交' : '卡密验证通过');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setLoading(button, false);
  }
}

function parseSessionJsonValue(value) {
  if (typeof value !== 'string') throw new Error('请粘贴 Session JSON');
  const normalizedValue = value.trim();
  if (!normalizedValue) throw new Error('请粘贴 Session JSON');
  let session;
  try {
    session = JSON.parse(normalizedValue);
  } catch {
    throw new Error('Session JSON 格式不正确');
  }
  if (
    !session ||
    typeof session !== 'object' ||
    typeof session.account?.id !== 'string' ||
    !session.account.id.trim()
  ) {
    throw new Error('Session JSON 中缺少 account.id');
  }
  const accountEmail = [session.user?.email, session.account?.email, session.email]
    .find((item) => typeof item === 'string' && item.trim());
  return Object.freeze({
    accountSession: JSON.stringify(session),
    accountLabel: accountEmail?.trim() || session.account.id.trim(),
  });
}

function validateSessionJson() {
  return parseSessionJsonValue($('#session-json').value);
}

function buildRedeemPayload(cardKey, sessionInfo, confirmOverride) {
  return {
    cardKey,
    accountSession: sessionInfo.accountSession,
    confirmOverride,
  };
}

function prepareRedeem() {
  const button = $('#redeem-btn');
  if (button.disabled) return;
  try {
    openAccountConfirmModal(validateSessionJson());
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function submitRedeem(sessionInfo, confirmOverride = false) {
  const button = $('#redeem-btn');
  if (button.disabled) return;
  if (!sessionInfo?.accountSession) {
    clearPendingRedeemSession();
    showToast('充值确认信息已失效，请重新确认账号', 'error');
    return;
  }

  setLoading(button, true, '正在提交…');
  let awaitingOverride = false;
  try {
    const result = await apiRequest(
      '/redeem',
      buildRedeemPayload(state.verifiedCardKey, sessionInfo, confirmOverride),
      { proxyOnly: true },
    );
    if (result.code === 60804 || result.data?.requireConfirm) {
      if (confirmOverride) throw new Error(result.data?.message || result.message || '覆盖订阅确认未生效，请稍后重试');
      state.pendingRedeemSession = sessionInfo;
      awaitingOverride = true;
      openOverrideModal();
      return;
    }
    if (result.code !== 0 || !result.data?.success) {
      throw new Error(result.data?.message || result.message || '充值未成功，请稍后重试');
    }
    $('#expires-date').textContent = formatExpiryDate(result.data.expiresDate);
    $('#session-json').value = '';
    state.verifiedCardKey = '';
    showStep(3);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setLoading(button, false);
    if (!awaitingOverride) clearPendingRedeemSession();
  }
}

function parseBatchKeys() {
  return [...new Set($('#batch-keys').value.split(/[\s,，]+/).map(normalizeKey).filter(Boolean))];
}

function getBatchKeys() {
  return parseBatchKeys().slice(0, 100);
}

function updateBatchControls() {
  const count = parseBatchKeys().length;
  $('#key-count').textContent = `${count} / 100`;
  $('#key-count').classList.toggle('over-limit', count > 100);
  $('#batch-clear').disabled = $('#batch-keys').value.length === 0;
  $('#batch-summary').classList.add('hidden');
  $('#batch-results').classList.add('hidden');
}

function clearBatchKeys() {
  const input = $('#batch-keys');
  if (!input.value) return;
  input.value = '';
  updateBatchControls();
  input.focus();
}

function maskEmail(email) {
  if (!email || typeof email !== 'string') return '—';
  const [name, domain] = email.split('@');
  if (!domain) return `${email.slice(0, 2)}***`;
  const visibleName = name.length <= 2
    ? `${name.slice(0, 1)}***`
    : `${name.slice(0, 2)}***${name.slice(-1)}`;
  return `${visibleName}@${domain}`;
}

function formatUsedTime(value) {
  if (!value) return '—';
  const text = String(value).trim();
  const isPlainDateTime = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text);
  const normalized = isPlainDateTime ? `${text.replace(' ', 'T')}Z` : text;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Asia/Shanghai',
  }).format(date).replaceAll('/', '-');
}

function formatExpiryDate(value) {
  if (!value) return '请在账户内查看';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeZone: 'Asia/Shanghai',
  }).format(date);
}

function getCardStatus(item) {
  const rawStatus = item.status;
  const status = rawStatus === null || rawStatus === undefined || rawStatus === ''
    ? null
    : Number(rawStatus);
  const description = String(item.statusDesc || '').trim();

  if (status === -1 || description.includes('不存在')) {
    return { kind: 'missing', label: '不存在' };
  }
  if (status === 0 || description.includes('未使用')) {
    return { kind: 'unused', label: '未使用' };
  }
  if (status === 3 || description.includes('排队')) {
    return { kind: 'queued', label: description || '排队中' };
  }
  if (status === 4 || description.includes('失败')) {
    return { kind: 'retry', label: description || '可重新提交' };
  }
  if (
    status === 1 ||
    status === 2 ||
    description.includes('已使用') ||
    description.includes('已绑定') ||
    description.includes('已消费') ||
    item.externalEmail ||
    item.usedTime
  ) {
    return { kind: 'used', label: description || '已使用' };
  }

  return item.valid === true
    ? { kind: 'unused', label: description || '未使用' }
    : { kind: 'missing', label: description || '不存在' };
}

function renderBatchSummary(items) {
  const counts = items.reduce((summary, item) => {
    summary[getCardStatus(item).kind] += 1;
    return summary;
  }, { unused: 0, used: 0, queued: 0, retry: 0, missing: 0 });
  const labels = {
    unused: '未使用',
    used: '已使用',
    queued: '排队中',
    retry: '可重试',
    missing: '不存在',
  };
  const summary = $('#batch-summary');
  summary.replaceChildren(...Object.entries(labels).map(([kind, label]) => {
    const card = document.createElement('div');
    card.className = `batch-summary-card ${kind}`;
    const title = document.createElement('span');
    title.textContent = label;
    const value = document.createElement('b');
    value.textContent = counts[kind];
    card.append(title, value);
    return card;
  }));
  summary.classList.remove('hidden');
}

async function queryBatch() {
  const button = $('#batch-btn');
  if (button.disabled) return;
  const allCardKeys = parseBatchKeys();
  if (allCardKeys.length > 100) return showToast(`单次最多查询 100 个，当前为 ${allCardKeys.length} 个`, 'error');
  const cardKeys = allCardKeys;
  if (!cardKeys.length) return showToast('请至少输入一个卡密', 'error');
  if (cardKeys.some((key) => !isPlausibleKey(key))) return showToast('列表中存在格式错误的卡密', 'error');

  $('#batch-summary').classList.add('hidden');
  $('#batch-results').classList.add('hidden');
  setLoading(button, true, '正在查询…');
  try {
    const result = await apiRequest('/cardkey/batch-status', { cardKeys });
    if (result.code !== 0 || !Array.isArray(result.data)) throw new Error(result.message || '查询失败');
    renderBatchSummary(result.data);
    const container = $('#batch-results');
    container.replaceChildren(...result.data.map((item) => {
      const statusInfo = getCardStatus(item);
      const row = document.createElement('div');
      row.className = 'batch-result';
      const head = document.createElement('div');
      head.className = 'batch-result-head';
      const key = document.createElement('code');
      key.className = 'batch-result-key';
      key.textContent = item.cardKey || '—';
      const status = document.createElement('b');
      status.className = `batch-status ${statusInfo.kind}`;
      status.textContent = statusInfo.label;
      head.append(key, status);
      row.append(head);

      if (statusInfo.kind === 'used') {
        const meta = document.createElement('div');
        meta.className = 'batch-result-meta';
        const account = document.createElement('span');
        account.append('充值账号：');
        const accountValue = document.createElement('b');
        accountValue.textContent = maskEmail(item.externalEmail);
        account.append(accountValue);
        const usedTime = document.createElement('span');
        usedTime.append('使用时间：');
        const timeValue = document.createElement('b');
        timeValue.textContent = formatUsedTime(item.usedTime);
        usedTime.append(timeValue);
        meta.append(account, usedTime);
        row.append(meta);
      }

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy-key';
      copy.title = '复制卡密';
      copy.setAttribute('aria-label', `复制卡密 ${item.cardKey || ''}`);
      copy.textContent = '⧉';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(item.cardKey || '');
          showToast('卡密已复制');
        } catch { showToast('复制失败，请手动复制', 'error'); }
      });
      row.append(copy);
      return row;
    }));
    container.classList.remove('hidden');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setLoading(button, false);
  }
}

function bindEvents() {
  $$('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.mode-tab').forEach((item) => {
        const active = item === tab;
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
      });
      $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === tab.dataset.panel));
    });
  });

  $('#paste-key').addEventListener('click', async () => {
    try {
      $('#card-key').value = normalizeKey(await navigator.clipboard.readText());
    } catch { showToast('浏览器未允许读取剪贴板，请手动粘贴', 'error'); }
  });
  $('#paste-session').addEventListener('click', async () => {
    try {
      $('#session-json').value = await navigator.clipboard.readText();
    } catch { showToast('浏览器未允许读取剪贴板，请手动粘贴', 'error'); }
  });
  $('#card-key').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); verifyCard(); } });
  $('#verify-btn').addEventListener('click', verifyCard);
  $('#change-key').addEventListener('click', resetRecharge);
  $('#recharge-form').addEventListener('submit', (event) => { event.preventDefault(); prepareRedeem(); });
  $('#restart-btn').addEventListener('click', resetRecharge);

  $('#batch-keys').addEventListener('input', updateBatchControls);
  $('#batch-clear').addEventListener('click', clearBatchKeys);
  $('#batch-btn').addEventListener('click', queryBatch);

  $('.account-modal-close').addEventListener('click', () => closeAccountConfirmModal());
  $('#cancel-account-redeem').addEventListener('click', () => closeAccountConfirmModal());
  $('#account-confirm-modal').addEventListener('click', (event) => { if (event.target.id === 'account-confirm-modal') closeAccountConfirmModal(); });
  $('#confirm-account-redeem').addEventListener('click', () => {
    const sessionInfo = state.pendingRedeemSession;
    closeAccountConfirmModal({ restoreFocus: false, clearPending: false });
    submitRedeem(sessionInfo, false);
  });

  $('.override-modal-close').addEventListener('click', () => closeOverrideModal());
  $('#cancel-override').addEventListener('click', () => closeOverrideModal());
  $('#override-modal').addEventListener('click', (event) => { if (event.target.id === 'override-modal') closeOverrideModal(); });
  $('#confirm-override').addEventListener('click', () => {
    const sessionInfo = state.pendingRedeemSession;
    closeOverrideModal({ restoreFocus: false, clearPending: false });
    submitRedeem(sessionInfo, true);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('#account-confirm-modal').classList.contains('hidden')) closeAccountConfirmModal();
    else if (!$('#override-modal').classList.contains('hidden')) closeOverrideModal();
  });
}

if (typeof document !== 'undefined') {
  configureBrand();
  bindEvents();
  prefillCardKeyFromUrl();
  loadInventoryStatus();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildRedeemPayload,
    canRedeemCard,
    getCardKeyFromUrl,
    getInventoryLabel,
    getCardStatus,
    isPlausibleKey,
    maskKey,
    normalizeKey,
    parseSessionJsonValue,
  };
}
