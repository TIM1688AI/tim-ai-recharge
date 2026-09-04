const CONFIG = {
  brandName: 'Tim AI',
  pageTitle: 'Tim | GPT充值服务',
  proxyBase: '/api-proxy',
  requestTimeout: 25000,
  taskPollInterval: 5000,
  queuePollInterval: 15000,
  channels: Object.freeze({
    regular: Object.freeze({ id: 'regular', label: '常规充值', supportsRefresh: true, supportsCancel: true, allowsActiveSubscription: false, cardNote: '常规充值：已有 Plus / Pro 账号无法提交充值，Team 账号暂不支持。', recordsNote: '查询常规充值已提交任务；未提交的有效卡密会显示“暂无提交记录”' }),
    advanced: Object.freeze({ id: 'advanced', label: '进阶充值', supportsRefresh: false, supportsCancel: false, allowsActiveSubscription: true, cardNote: '进阶充值：已有 Plus / Pro 账号可继续提交，Team 账号暂不支持。', recordsNote: '查询进阶充值已提交任务；未提交的有效卡密会显示“暂无提交记录”' }),
  }),
};

const state = {
  activeChannel: 'regular',
  verifiedCardKey: '',
  verifiedPlan: '',
  refreshRemaining: 0,
  pendingRedeemSession: null,
  activeTask: null,
  taskPollTimer: null,
  taskGeneration: 0,
  queueEventSource: null,
  queuePollTimer: null,
  queueReconnectTimer: null,
  modalReturnFocus: null,
  subscriptionModalReturnFocus: null,
  operationModalReturnFocus: null,
  pendingOperation: '',
  quickToolReturnFocus: null,
  quickTool: '',
  quickToolStage: 'input',
  quickToolCardKey: '',
  batchModalReturnFocus: null,
  channelSwitchReturnFocus: null,
  pendingChannel: '',
  subscriptionCanContinue: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function getChannel(channelId = state.activeChannel) {
  return CONFIG.channels[channelId] || CONFIG.channels.regular;
}

function isAdvancedChannel(channelId = state.activeChannel) {
  return getChannel(channelId).id === 'advanced';
}

function channelApiPath(path, channelId = state.activeChannel) {
  return `/${getChannel(channelId).id}${path}`;
}

function configureBrand() {
  $$('[data-brand]').forEach((element) => { element.textContent = CONFIG.brandName; });
  document.title = CONFIG.pageTitle;
}

function startHandwrittenIntro() {
  const note = $('#hero-handwritten');
  if (!note) return;
  const stage = note.closest('.hero-trust-stage');
  const signature = $('.hero-signature', stage || document);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let alreadySeen = false;
  try {
    alreadySeen = sessionStorage.getItem('tim-ai-handwritten-intro-seen') === '1';
    if (!alreadySeen) sessionStorage.setItem('tim-ai-handwritten-intro-seen', '1');
  } catch {
    // Storage can be unavailable for local files or privacy-restricted browsers.
  }
  if (alreadySeen || reducedMotion) {
    note.classList.add('is-written');
    stage?.classList.add('is-written');
    return;
  }
  note.classList.add('is-writing');
  stage?.classList.add('is-writing');
  signature?.addEventListener('animationend', () => {
    note.classList.remove('is-writing');
    note.classList.add('is-written');
    stage?.classList.remove('is-writing');
    stage?.classList.add('is-written');
  }, { once: true });
}

function startHandwrittenAmbientMotion() {
  const note = $('#hero-handwritten');
  if (!note) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let inViewport = true;

  const sync = () => {
    note.classList.toggle('is-ambient-active', !reducedMotion.matches && !document.hidden && inViewport);
  };

  document.addEventListener('visibilitychange', sync);
  reducedMotion.addEventListener?.('change', sync);
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(([entry]) => {
      inViewport = entry.isIntersecting;
      sync();
    }, { threshold: 0.05 });
    observer.observe(note);
  }
  sync();
}

function startHeroSubtitleRotation() {
  const rotator = $('#hero-subtitle-rotator');
  const items = rotator ? $$('.hero-subtitle', rotator) : [];
  if (items.length < 2) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let activeIndex = Math.max(0, items.findIndex((item) => item.classList.contains('active')));
  let timer = null;
  let inViewport = true;
  let pointerPaused = false;

  const stop = () => {
    clearTimeout(timer);
    timer = null;
  };
  const canRotate = () => !reducedMotion.matches
    && !document.hidden
    && inViewport
    && !pointerPaused;
  const schedule = () => {
    stop();
    const active = canRotate();
    rotator.classList.toggle('is-ambient-active', active);
    if (active) timer = setTimeout(advance, 3000);
  };
  function advance() {
    if (!canRotate()) {
      schedule();
      return;
    }
    const current = items[activeIndex];
    const nextIndex = (activeIndex + 1) % items.length;
    const next = items[nextIndex];
    current.classList.remove('active');
    current.classList.add('leaving');
    current.setAttribute('aria-hidden', 'true');
    next.classList.remove('leaving');
    next.classList.add('active');
    next.removeAttribute('aria-hidden');
    activeIndex = nextIndex;
    setTimeout(() => current.classList.remove('leaving'), 380);
    schedule();
  }

  rotator.addEventListener('pointerenter', () => {
    pointerPaused = true;
    stop();
  });
  rotator.addEventListener('pointerleave', () => {
    pointerPaused = false;
    schedule();
  });
  document.addEventListener('visibilitychange', schedule);
  reducedMotion.addEventListener?.('change', schedule);
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(([entry]) => {
      inViewport = entry.isIntersecting;
      schedule();
    }, { threshold: 0.2 });
    observer.observe(rotator);
  }
  schedule();
}

function setupEntranceMotion() {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) return;

  const tracked = [];
  const splitText = (element, mode = 'character', interval = 32, baseDelay = 0) => {
    if (!element || element.dataset.motionSplit === 'true') return;
    const accessibleLabel = element.innerText.replace(/\s+/g, ' ').trim();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    let unitIndex = 0;

    textNodes.forEach((textNode) => {
      const wrapper = document.createElement('span');
      wrapper.className = 'motion-fragment';
      wrapper.setAttribute('aria-hidden', 'true');
      const segments = mode === 'word'
        ? textNode.nodeValue.split(/(\s+)/)
        : Array.from(textNode.nodeValue);

      segments.forEach((segment) => {
        if (!segment || /^\s+$/.test(segment)) {
          wrapper.append(document.createTextNode(segment));
          return;
        }
        const unit = document.createElement('span');
        unit.className = 'motion-unit';
        unit.textContent = segment;
        unit.style.setProperty('--motion-delay', `${baseDelay + Math.min(unitIndex * interval, 620)}ms`);
        wrapper.append(unit);
        unitIndex += 1;
      });
      textNode.replaceWith(wrapper);
    });

    if (accessibleLabel) element.setAttribute('aria-label', accessibleLabel);
    element.dataset.motionSplit = 'true';
    element.classList.add('motion-text');
    element.dataset.motionSettle = String(baseDelay + Math.min(unitIndex * interval, 620) + 900);
    tracked.push(element);
  };

  const registerReveal = (selector, { delay = 0, mockup = false } = {}) => {
    $$(selector).forEach((element, index) => {
      element.classList.add('motion-reveal');
      if (mockup) element.classList.add('motion-mockup');
      element.style.setProperty('--motion-delay', `${delay + index * 90}ms`);
      element.dataset.motionSettle = String(delay + index * 90 + 900);
      tracked.push(element);
    });
  };

  const registerGroup = (selector, { delay = 0, interval = 70 } = {}) => {
    $$(selector).forEach((group) => {
      const children = [...group.children];
      if (!children.length) return;
      group.classList.add('motion-stagger');
      children.forEach((child, index) => {
        child.classList.add('motion-item');
        child.style.setProperty('--motion-delay', `${delay + Math.min(index * interval, 420)}ms`);
      });
      group.dataset.motionSettle = String(delay + Math.min((children.length - 1) * interval, 420) + 900);
      tracked.push(group);
    });
  };

  registerReveal('.site-header', { delay: 0 });
  registerReveal('.hero-copy', { delay: 50 });
  splitText($('.hero h1'), 'character', 28, 90);
  registerReveal('.hero-handwritten', { delay: 180 });
  registerGroup('.hero-trust', { delay: 260, interval: 65 });
  registerReveal('.how-it-works, .recharge-shell', { mockup: true });
  registerGroup('.session-guide', { delay: 100, interval: 80 });
  registerGroup('.mode-tabs', { delay: 100, interval: 80 });
  registerGroup('.steps', { delay: 150, interval: 80 });
  registerGroup('.utility-actions', { delay: 0, interval: 70 });
  registerReveal('.hero-subtitle-rotator', { delay: 180 });

  const settle = (element) => {
    const delay = Number(element.dataset.motionSettle || 1000);
    window.setTimeout(() => {
      element.classList.remove('motion-reveal', 'motion-mockup', 'motion-text', 'motion-stagger', 'is-motion-visible');
      element.style.removeProperty('--motion-delay');
      element.querySelectorAll('.motion-item, .motion-unit').forEach((child) => {
        child.classList.remove('motion-item', 'motion-unit');
        child.style.removeProperty('--motion-delay');
      });
      delete element.dataset.motionSettle;
    }, delay);
  };

  const reveal = (element) => {
    if (element.dataset.motionPlayed === 'true') return;
    element.dataset.motionPlayed = 'true';
    requestAnimationFrame(() => element.classList.add('is-motion-visible'));
    settle(element);
  };

  if (!('IntersectionObserver' in window)) {
    requestAnimationFrame(() => tracked.forEach(reveal));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      reveal(entry.target);
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: '0px' });
  tracked.forEach((element) => observer.observe(element));
}

function showToast(message, type = 'info') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast show ${type === 'error' ? 'error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 3600);
}

function setButtonLabel(button, label) {
  const labelNode = $('span', button);
  if (!labelNode) return;
  labelNode.textContent = label;
  if (button.classList.contains('is-loading')) button.dataset.loadingLabel = label;
}

function setLoading(button, loading, label) {
  const labelNode = $('span', button);
  button.disabled = loading;
  button.classList.toggle('is-loading', loading);
  button.setAttribute('aria-busy', String(loading));

  if (loading) {
    button.dataset.loadingLabel = labelNode?.textContent || '';
    if (labelNode) labelNode.textContent = label;
    if (!$('.button-loading-dots', button)) {
      const dots = document.createElement('span');
      dots.className = 'button-loading-dots';
      dots.setAttribute('aria-hidden', 'true');
      dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
      button.append(dots);
    }
  } else {
    if (labelNode && button.dataset.loadingLabel) labelNode.textContent = button.dataset.loadingLabel;
    delete button.dataset.loadingLabel;
    $('.button-loading-dots', button)?.remove();
  }
}

async function apiRequest(path, { method = 'GET', body, timeout = CONFIG.requestTimeout, channel = state.activeChannel } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${CONFIG.proxyBase}${channelApiPath(path, channel)}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error || payload?.message || `请求失败（${response.status}）`);
      error.status = response.status;
      error.payload = payload;
      error.retryAfter = Number(response.headers.get('Retry-After')) || 0;
      throw error;
    }
    if (!payload || typeof payload !== 'object') throw new Error('接口返回格式异常');
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时，请稍后重试');
    if (error instanceof TypeError) throw new Error('无法连接充值服务，请检查网络后重试');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeKey(value) {
  return String(value || '').trim();
}

function isPlausibleKey(value) {
  const key = normalizeKey(value);
  return key.length >= 4 && key.length <= 128 && !/[\u0000-\u001f\u007f]/.test(key);
}

function getCardKeyFromUrl(search, hash = '') {
  const queryKey = normalizeKey(new URLSearchParams(String(search || '')).get('card'));
  if (isPlausibleKey(queryKey)) return queryKey;
  const fragment = String(hash || '').replace(/^#/, '');
  const fragmentKey = normalizeKey(new URLSearchParams(fragment).get('card'));
  return isPlausibleKey(fragmentKey) ? fragmentKey : '';
}

function maskKey(value) {
  const key = normalizeKey(value);
  if (key.length <= 8) return `${key.slice(0, 2)}••${key.slice(-2)}`;
  return `${key.slice(0, 4)}••••••${key.slice(-4)}`;
}

function prefillCardKeyFromUrl() {
  const cardKey = getCardKeyFromUrl(location.search, location.hash);
  if (!cardKey) return;
  $('#card-key').value = cardKey;
  const params = new URLSearchParams(location.search);
  params.delete('card');
  const query = params.toString();
  const fragmentHasCard = new URLSearchParams(location.hash.replace(/^#/, '')).has('card');
  const nextHash = fragmentHasCard ? '#recharge' : location.hash;
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${nextHash}`);
  if (fragmentHasCard) requestAnimationFrame(() => $('#recharge').scrollIntoView({ block: 'start' }));
}

function syncModalIsolation() {
  const openModal = $('.modal-backdrop:not(.hidden)');
  document.body.classList.toggle('modal-open', Boolean(openModal));
  [...document.body.children].forEach((element) => {
    if (element.tagName === 'SCRIPT') return;
    element.inert = Boolean(openModal && element !== openModal);
  });
}

function setModalVisibility(modal, visible) {
  modal.classList.toggle('hidden', !visible);
  syncModalIsolation();
}

function trapModalFocus(event) {
  const openModal = $('.modal-backdrop:not(.hidden)');
  if (!openModal || event.key !== 'Tab') return false;
  const focusable = $$('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]', openModal)
    .filter((element) => !element.closest('.hidden'));
  if (!focusable.length) {
    event.preventDefault();
    return true;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!openModal.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
  return true;
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

async function loadAnnouncement(channel = state.activeChannel) {
  const announcement = $('#announcement');
  try {
    const payload = await apiRequest('/announcement', { timeout: 8000, channel });
    if (channel !== state.activeChannel) return;
    if (payload.enabled === true && typeof payload.content === 'string' && payload.content.trim()) {
      $('#announcement-content').textContent = payload.content.trim();
      announcement.classList.remove('hidden');
    } else {
      announcement.classList.add('hidden');
    }
  } catch {
    if (channel === state.activeChannel) announcement.classList.add('hidden');
  }
}

function getQueueDisplay(value) {
  const count = Math.max(0, Math.floor(Number(value) || 0));
  return {
    count,
    message: count > 0 ? `队列 ${count} 个任务` : '队列空闲',
  };
}

function getQueueErrorDisplay() {
  return {
    message: '暂时无法获取，点击重试',
  };
}

function setQueueMessage(message, { state = 'loading', retry = false, detail = '' } = {}) {
  const section = $('#queue-status');
  const liveAction = $('#queue-live-label');
  liveAction.textContent = message;
  liveAction.disabled = !retry;
  liveAction.setAttribute('aria-label', detail ? `${message}，${detail}` : message);
  section.dataset.state = state;
  section.classList.remove('hidden');
}

function renderQueueStatus(payload, updateLabel = '实时更新') {
  if (payload?.status !== 'ok') throw new Error('队列状态不可用');
  const queue = getQueueDisplay(payload.pending_count);
  setQueueMessage(queue.message, {
    state: queue.count > 0 ? 'busy' : 'clear',
    detail: payload.at ? `更新于 ${formatDateTime(payload.at)}` : updateLabel,
  });
}

function renderQueueError() {
  const queue = getQueueErrorDisplay();
  setQueueMessage(queue.message, { state: 'error', retry: true });
}

async function loadQueueStatus(channel = state.activeChannel) {
  try {
    const payload = await apiRequest('/queue-status', { timeout: 8000, channel });
    if (channel !== state.activeChannel) return false;
    renderQueueStatus(payload, '自动刷新');
    return true;
  } catch {
    if (channel === state.activeChannel) renderQueueError();
    return false;
  }
}

async function retryQueueStatus() {
  setQueueMessage('正在重新获取…', { state: 'loading' });
  await loadQueueStatus();
}

function stopQueuePolling() {
  clearInterval(state.queuePollTimer);
  state.queuePollTimer = null;
}

function stopQueueUpdates() {
  clearTimeout(state.queueReconnectTimer);
  state.queueReconnectTimer = null;
  stopQueuePolling();
  state.queueEventSource?.close();
  state.queueEventSource = null;
}

function startQueuePolling({ reconnecting = false, channel = state.activeChannel } = {}) {
  if (state.queuePollTimer) return;
  setQueueMessage(reconnecting ? '连接断开，正在重新连接…' : '正在获取队列状态…', { state: 'loading' });
  loadQueueStatus(channel);
  state.queuePollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && channel === state.activeChannel) loadQueueStatus(channel);
  }, CONFIG.queuePollInterval);
}

function startQueueUpdates() {
  const channel = state.activeChannel;
  stopQueueUpdates();
  setQueueMessage('正在获取队列状态…', { state: 'loading' });
  loadQueueStatus(channel);
  if (typeof EventSource === 'undefined') {
    startQueuePolling({ channel });
    return;
  }

  const source = new EventSource(`${CONFIG.proxyBase}${channelApiPath('/queue-events', channel)}`);
  state.queueEventSource = source;
  source.addEventListener('open', () => {
    if (channel === state.activeChannel) stopQueuePolling();
  });
  source.addEventListener('queue_status', (event) => {
    try {
      if (channel !== state.activeChannel) return;
      renderQueueStatus(JSON.parse(event.data), '实时推送');
      stopQueuePolling();
    } catch {
      // Ignore malformed events and keep the connection alive for the next valid update.
    }
  });
  source.addEventListener('error', () => {
    source.close();
    if (state.queueEventSource === source) state.queueEventSource = null;
    if (channel !== state.activeChannel) return;
    startQueuePolling({ reconnecting: true, channel });
    state.queueReconnectTimer = setTimeout(() => {
      if (channel === state.activeChannel) startQueueUpdates();
    }, 30000);
  });
}

function updateChannelInterface() {
  const channel = getChannel();
  document.body.dataset.rechargeChannel = channel.id;
  $$('.channel-choice').forEach((button) => {
    const selected = button.dataset.channel === channel.id;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('#card-key-note').textContent = channel.cardNote;
  $('#batch-limit-note').textContent = channel.recordsNote;
  $('#quick-refresh-cdk').classList.toggle('hidden', !channel.supportsRefresh);
  $('#quick-cancel-task').classList.toggle('hidden', !channel.supportsCancel);
  $('#refresh-cdk-btn').classList.toggle('hidden', !channel.supportsRefresh || state.refreshRemaining < 1);
  $('#continue-subscription').classList.add('hidden');
}

function hasRechargeDraft() {
  return Boolean(
    state.verifiedCardKey
    || state.pendingRedeemSession
    || normalizeKey($('#card-key').value)
    || String($('#session-json').value || '').trim(),
  );
}

function hasProcessingTask() {
  return Boolean(state.activeTask && !getTaskStatus(state.activeTask.latestTask).terminal);
}

function hasPendingRequest() {
  return $$('.is-loading').length > 0;
}

function closeChannelSwitchModal({ restoreFocus = true } = {}) {
  setModalVisibility($('#channel-switch-modal'), false);
  if (restoreFocus && state.channelSwitchReturnFocus instanceof HTMLElement) {
    state.channelSwitchReturnFocus.focus();
  }
  state.channelSwitchReturnFocus = null;
  state.pendingChannel = '';
}

function applyChannelChange(channelId) {
  const channel = getChannel(channelId);
  if (channel.id === state.activeChannel) return;
  stopQueueUpdates();
  resetRecharge();
  $('#batch-keys').value = '';
  updateBatchControls();
  $('#batch-results').replaceChildren();
  $('#batch-summary').replaceChildren();
  $('#batch-results-count').textContent = '共 0 条查询结果';
  $('#batch-view-results').classList.add('hidden');
  state.activeChannel = channel.id;
  updateChannelInterface();
  void loadAnnouncement(channel.id);
  startQueueUpdates();
  showToast(`已切换至${channel.label}`);
}

function requestChannelChange(channelId, trigger = document.activeElement) {
  const channel = getChannel(channelId);
  if (channel.id === state.activeChannel) return;
  if (hasPendingRequest()) {
    showToast('当前请求正在处理中，请完成后再切换通道。', 'error');
    return;
  }
  if (hasProcessingTask()) {
    showToast('当前任务正在处理中，请在原通道内跟踪任务进度。', 'error');
    return;
  }
  if (!hasRechargeDraft()) {
    applyChannelChange(channel.id);
    return;
  }
  state.channelSwitchReturnFocus = trigger;
  state.pendingChannel = channel.id;
  $('#channel-switch-title').textContent = `切换至${channel.label}？`;
  $('#channel-switch-copy').textContent = '切换后将清除当前填写的卡密与 Session，未提交的内容不会被保留。';
  setModalVisibility($('#channel-switch-modal'), true);
  $('#cancel-channel-switch').focus();
}

function clearPendingRedeemSession() {
  state.pendingRedeemSession = null;
  $('#confirm-account-value').textContent = '';
}

function openAccountConfirmModal(sessionInfo, { returnFocus = document.activeElement } = {}) {
  state.modalReturnFocus = returnFocus;
  state.pendingRedeemSession = Object.freeze({ ...sessionInfo });
  $('#confirm-account-value').textContent = sessionInfo.accountLabel;
  $('#account-confirm-note').textContent = sessionInfo.subscriptionWarning
    ? '订阅状态暂未确认，服务端会在处理时实时复查。请确认账号无误。'
    : '请仔细核对账号，确认后才会提交充值。';
  setModalVisibility($('#account-confirm-modal'), true);
  $('#cancel-account-redeem').focus();
}

function closeAccountConfirmModal({ restoreFocus = true, clearPending = true } = {}) {
  setModalVisibility($('#account-confirm-modal'), false);
  $('#confirm-account-value').textContent = '';
  if (restoreFocus && state.modalReturnFocus instanceof HTMLElement) state.modalReturnFocus.focus();
  state.modalReturnFocus = null;
  if (clearPending) clearPendingRedeemSession();
}

function formatPlanName(value) {
  const plan = String(value || '').trim();
  if (!plan) return '现有会员';
  const names = {
    free: 'Free',
    plus: 'ChatGPT Plus',
    pro: 'ChatGPT Pro',
    team: 'ChatGPT Team',
  };
  return names[plan.toLowerCase()] || plan;
}

function openSubscriptionModal(summary, { canContinue = false, blockedReason = '' } = {}) {
  const advanced = isAdvancedChannel();
  state.subscriptionModalReturnFocus = document.activeElement;
  state.subscriptionCanContinue = canContinue;
  $('#subscription-account').textContent = summary.account_email || state.pendingRedeemSession?.accountLabel || '—';
  $('#subscription-plan').textContent = formatPlanName(summary.plan_type || summary.subscription_plan);
  $('#subscription-expiry').textContent = summary.expires_at ? formatDateTime(summary.expires_at) : '请在 ChatGPT 内查看';
  $('#subscription-title').textContent = blockedReason || '当前账号已有会员';
  $('#subscription-copy').textContent = canContinue && advanced
    ? '嗨，已查询到你的账号当前已有以下订阅。进阶充值支持已有 Plus / Pro 账号继续提交，请确认账号和套餐无误后继续。'
    : blockedReason === 'Team 账号暂不支持'
      ? '当前账号属于 Team 订阅，进阶充值暂不支持该账号类型，请切换为个人账号后再提交。'
      : blockedReason === '当前账号暂不支持'
        ? '当前账号暂不符合进阶充值条件，请更换个人 Free、Plus 或 Pro 账号后再试。'
      : '嗨，后台处理充值时，查询到你的账号当前已有以下订阅，已有会员的账号无法重复充值，请会员到期后再提交充值！';
  $('#continue-subscription').classList.toggle('hidden', !canContinue);
  setModalVisibility($('#subscription-modal'), true);
  $('#close-subscription').focus();
}

function closeSubscriptionModal({ restoreFocus = true, clearPending = true } = {}) {
  setModalVisibility($('#subscription-modal'), false);
  if (restoreFocus && state.subscriptionModalReturnFocus instanceof HTMLElement) {
    state.subscriptionModalReturnFocus.focus();
  }
  state.subscriptionModalReturnFocus = null;
  state.subscriptionCanContinue = false;
  if (clearPending) clearPendingRedeemSession();
}

function openOperationModal(operation) {
  state.operationModalReturnFocus = document.activeElement;
  state.pendingOperation = operation;
  const isRefresh = operation === 'refresh';
  $('#operation-title').textContent = isRefresh ? '确认更换卡密' : '取消排队任务';
  $('#operation-copy').textContent = isRefresh
    ? '换码成功后旧卡密会立即失效，新卡密只在本次响应中展示。'
    : '取消成功后当前任务记录会被删除，卡密恢复可用，你可以重新提交。';
  $('#operation-note').textContent = isRefresh
    ? `当前还可换码 ${state.refreshRemaining} 次。请在成功后立即复制并妥善保存新卡密。`
    : '只有尚未开始处理的排队任务可以取消；如果后台已经接单，接口会拒绝取消。';
  const confirmButton = $('#confirm-operation');
  setButtonLabel(confirmButton, isRefresh ? '确认换码' : '确认取消任务');
  confirmButton.classList.toggle('danger-btn', !isRefresh);
  confirmButton.classList.toggle('primary-btn', isRefresh);
  setModalVisibility($('#operation-modal'), true);
  $('#cancel-operation').focus();
}

function closeOperationModal({ restoreFocus = true } = {}) {
  setModalVisibility($('#operation-modal'), false);
  if (restoreFocus && state.operationModalReturnFocus instanceof HTMLElement) {
    state.operationModalReturnFocus.focus();
  }
  state.operationModalReturnFocus = null;
  state.pendingOperation = '';
}

function activateModeTab(tab, { focus = false } = {}) {
  if (!tab) return;
  $$('.mode-tab').forEach((item) => {
    const active = item === tab;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
  });
  $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === tab.dataset.panel));
  if (focus) tab.focus();
}

function handleModeTabKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = $$('.mode-tab');
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0) return;
  event.preventDefault();
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? tabs.length - 1
      : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  activateModeTab(tabs[nextIndex], { focus: true });
}

function resetQuickToolResult() {
  const result = $('#quick-tool-result');
  result.className = 'quick-tool-result hidden';
  $('#quick-tool-message').textContent = '';
  $('#quick-subscription-details').classList.add('hidden');
  $('#quick-new-code').classList.add('hidden');
  $('#quick-new-code-value').textContent = '';
}

function showQuickToolResult(message, { error = false } = {}) {
  const result = $('#quick-tool-result');
  result.className = `quick-tool-result${error ? ' error' : ''}`;
  $('#quick-tool-message').textContent = message;
  $('#quick-subscription-details').classList.add('hidden');
  $('#quick-new-code').classList.add('hidden');
}

function completeQuickTool() {
  $('.quick-tool-modal').classList.add('complete');
  $('#submit-quick-tool').classList.add('hidden');
}

function openQuickTool(tool) {
  state.quickToolReturnFocus = document.activeElement;
  state.quickTool = tool;
  state.quickToolStage = 'input';
  state.quickToolCardKey = '';
  resetQuickToolResult();

  const isSubscription = tool === 'subscription';
  const advanced = isAdvancedChannel();
  const copy = {
    subscription: advanced ? '粘贴完整 Session JSON，查询当前账号的订阅摘要。' : '粘贴 Session JSON 或 accessToken，查询当前账号的订阅摘要。',
    refresh: '请先检查卡密的换码资格，换码成功后旧码会立即失效，既不能兑换也不能查询；新码只展示一次，请务必保存好新卡密',
    cancel: '先确认任务仍在排队。只有尚未开始处理的任务才能取消。',
  }[tool];
  const title = {
    subscription: '订阅查询',
    refresh: '更换卡密',
    cancel: '取消任务',
  }[tool];
  const action = {
    subscription: '查询订阅',
    refresh: '检查卡密',
    cancel: '检查任务',
  }[tool];

  $('#quick-tool-title').textContent = title;
  $('#quick-tool-copy').textContent = copy;
  $('#quick-card-field').classList.toggle('hidden', isSubscription);
  $('#quick-subscription-field').classList.toggle('hidden', !isSubscription);
  $('#quick-subscription-input').placeholder = advanced
    ? '粘贴完整 Session JSON'
    : '粘贴完整 Session JSON，或直接粘贴 accessToken';
  $('#quick-card-input').value = '';
  $('#quick-card-input').disabled = false;
  $('#quick-subscription-input').value = '';
  const submitButton = $('#submit-quick-tool');
  submitButton.classList.remove('hidden');
  submitButton.disabled = false;
  submitButton.setAttribute('aria-busy', 'false');
  setButtonLabel(submitButton, action);
  $('.quick-tool-modal').classList.remove('complete');
  setModalVisibility($('#quick-tool-modal'), true);
  (isSubscription ? $('#quick-subscription-input') : $('#quick-card-input')).focus();
}

function closeQuickTool({ restoreFocus = true } = {}) {
  setModalVisibility($('#quick-tool-modal'), false);
  $('#quick-card-input').value = '';
  $('#quick-subscription-input').value = '';
  $('#quick-new-code-value').textContent = '';
  resetQuickToolResult();
  if (restoreFocus && state.quickToolReturnFocus instanceof HTMLElement) state.quickToolReturnFocus.focus();
  state.quickToolReturnFocus = null;
  state.quickTool = '';
  state.quickToolStage = 'input';
  state.quickToolCardKey = '';
}

async function queryQuickSubscription() {
  const button = $('#submit-quick-tool');
  let tokenInput = $('#quick-subscription-input').value.trim();
  if (!tokenInput) {
    showQuickToolResult('请粘贴 Session JSON 或 accessToken。', { error: true });
    $('#quick-subscription-input').focus();
    return;
  }
  if (tokenInput.length > 256 * 1024) {
    showQuickToolResult('查询内容过大，请重新复制完整 Session JSON。', { error: true });
    return;
  }

  if (isAdvancedChannel()) {
    try {
      tokenInput = parseSessionJsonValue(tokenInput).sessionJson;
    } catch (error) {
      showQuickToolResult(error.message, { error: true });
      $('#quick-subscription-input').focus();
      return;
    }
  }

  $('#quick-subscription-input').value = '';
  setLoading(button, true, '正在查询…');
  try {
    const result = await apiRequest('/check-subscription', {
      method: 'POST',
      body: { token_input: tokenInput },
    });
    if (result.ok !== true || !result.summary) {
      throw new Error(result.error || '无法确认当前账号订阅状态');
    }
    const summary = result.summary;
    showQuickToolResult(summary.has_active_subscription === true
      ? '已查询到当前账号的有效订阅。'
      : '当前账号未检测到有效订阅。');
    $('#quick-subscription-account').textContent = summary.account_email || '—';
    $('#quick-subscription-plan').textContent = formatPlanName(summary.plan_type || summary.subscription_plan || 'free');
    $('#quick-subscription-expiry').textContent = summary.expires_at ? formatDateTime(summary.expires_at) : '—';
    $('#quick-subscription-details').classList.remove('hidden');
    completeQuickTool();
  } catch (error) {
    showQuickToolResult(error.message, { error: true });
  } finally {
    setLoading(button, false);
  }
}

async function inspectQuickCard() {
  const button = $('#submit-quick-tool');
  const cardKey = normalizeKey($('#quick-card-input').value);
  $('#quick-card-input').value = cardKey;
  if (!isPlausibleKey(cardKey)) {
    showQuickToolResult('请输入 4–128 位有效卡密。', { error: true });
    $('#quick-card-input').focus();
    return;
  }

  setLoading(button, true, state.quickTool === 'refresh' ? '正在检查…' : '正在查询…');
  try {
    const result = await apiRequest('/verify-cdk', {
      method: 'POST',
      body: { cdk_code: cardKey },
    });
    if (state.quickTool === 'refresh') {
      if (result.valid !== true) throw new Error(result.error || '该卡密当前不可换码');
      const remaining = Math.max(0, Math.floor(Number(result.refresh_remaining ?? 0) || 0));
      if (remaining < 1) throw new Error('该卡密的换码次数已用完');
      showQuickToolResult(`卡密可以更换，当前还剩 ${remaining} 次换码机会。确认后旧码立即失效。`);
      setButtonLabel(button, '确认换码');
    } else {
      if (result.pending !== true) {
        throw new Error(result.valid === true ? '该卡密当前没有排队中的任务' : (result.error || '未找到可取消的任务'));
      }
      if (result.cancellable !== true) throw new Error('任务已经开始处理，当前无法取消');
      showQuickToolResult('任务仍在排队，可以取消。确认后任务记录会删除，卡密恢复可用。');
      setButtonLabel(button, '确认取消任务');
    }
    state.quickToolStage = 'confirm';
    state.quickToolCardKey = cardKey;
    $('#quick-card-input').disabled = true;
  } catch (error) {
    showQuickToolResult(error.message, { error: true });
  } finally {
    setLoading(button, false);
  }
}

async function executeQuickCardAction() {
  const button = $('#submit-quick-tool');
  const cardKey = state.quickToolCardKey;
  if (!cardKey) return;
  setLoading(button, true, state.quickTool === 'refresh' ? '正在换码…' : '正在取消…');
  try {
    if (state.quickTool === 'refresh') {
      const result = await apiRequest('/refresh-cdk', {
        method: 'POST',
        body: { cdk_code: cardKey },
      });
      const newCode = normalizeKey(result.new_code);
      if (!isPlausibleKey(newCode)) throw new Error('接口未返回有效的新卡密，请联系客服');
      showQuickToolResult(result.message || '换码成功，请立即保存新卡密。');
      $('#quick-new-code-value').textContent = newCode;
      $('#quick-new-code').classList.remove('hidden');
      $('#card-key').value = newCode;
      completeQuickTool();
      $('#copy-quick-new-code').focus();
    } else {
      const result = await apiRequest('/cancel-task', {
        method: 'POST',
        body: { cdk_code: cardKey },
      });
      if (result.ok !== true) throw new Error(result.error || '任务未能取消');
      showQuickToolResult(result.message || '任务已取消，卡密已经恢复可用。');
      $('#card-key').value = cardKey;
      completeQuickTool();
      $('#close-quick-tool').focus();
    }
  } catch (error) {
    showQuickToolResult(error.message, { error: true });
  } finally {
    setLoading(button, false);
  }
}

function handleQuickToolSubmit() {
  if (state.quickTool === 'subscription') queryQuickSubscription();
  else if (state.quickToolStage === 'input') inspectQuickCard();
  else executeQuickCardAction();
}

function handleUtilityAction(tool) {
  if (tool === 'task') {
    activateModeTab($('#batch-tab'));
    $('.recharge-shell').scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => $('#batch-keys').focus(), 350);
    return;
  }
  openQuickTool(tool);
}

function stopTaskPolling() {
  clearTimeout(state.taskPollTimer);
  state.taskPollTimer = null;
}

function resetRecharge() {
  stopTaskPolling();
  state.taskGeneration += 1;
  state.verifiedCardKey = '';
  state.verifiedPlan = '';
  state.refreshRemaining = 0;
  state.activeTask = null;
  closeAccountConfirmModal({ restoreFocus: false });
  closeSubscriptionModal({ restoreFocus: false });
  closeOperationModal({ restoreFocus: false });
  $('#recharge-form').reset();
  $('#card-key').value = '';
  $('#refresh-cdk-btn').classList.add('hidden');
  $('#refresh-result').classList.add('hidden');
  $('#refreshed-card-code').textContent = '';
  showStep(1);
}

function getTaskStatus(task) {
  const status = String(task?.task_status || task?.status || '').trim().toLowerCase();
  if (status === 'completed') return { kind: 'completed', label: '充值已完成', terminal: true };
  if (status === 'failed') return { kind: 'failed', label: '充值处理失败', terminal: true };
  if (status === 'manual_review') return { kind: 'processing', label: '人工处理中', terminal: false };
  if (status === 'submitted') return { kind: 'processing', label: '后台正在处理', terminal: false };
  if (status === 'pending') return { kind: 'processing', label: '等待处理', terminal: false };
  if (status === 'not_found') return { kind: 'missing', label: '暂无提交记录', terminal: true };
  return { kind: 'processing', label: status ? '处理中' : '等待状态更新', terminal: false };
}

function formatDateTime(value) {
  if (!value) return '—';
  const text = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T')}+08:00`
    : text;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Asia/Shanghai',
  }).format(date).replaceAll('/', '-');
}

function parseSessionJsonValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请粘贴 Session JSON');
  let session;
  try {
    session = JSON.parse(value.trim());
  } catch {
    throw new Error('Session JSON 格式不正确，请复制完整页面内容');
  }
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new Error('Session JSON 必须是完整对象');
  }
  const token = session.accessToken || session.access_token;
  if (typeof token !== 'string' || !token.trim()) throw new Error('Session JSON 中缺少 accessToken');
  const sessionToken = session.sessionToken || session.session_token;
  if (typeof sessionToken !== 'string' || !sessionToken.trim()) {
    throw new Error('Session JSON 中缺少 sessionToken，请复制完整 Session 页面内容');
  }
  const accountEmail = [session.user?.email, session.account?.email, session.email]
    .find((item) => typeof item === 'string' && item.trim());
  if (!accountEmail) throw new Error('Session JSON 中缺少账号邮箱');
  return Object.freeze({
    sessionJson: JSON.stringify(session),
    accountLabel: accountEmail.trim(),
    planType: String(session.planType || session.plan_type || '').trim().toLowerCase(),
  });
}

function buildCreateTaskPayload(cardKey, sessionInfo) {
  return {
    cdk_code: cardKey,
    session_json: sessionInfo.sessionJson,
  };
}

function isTeamSubscription(summary) {
  const plan = String(summary?.plan_type || summary?.subscription_plan || '').toLowerCase();
  return summary?.is_team === true || plan.includes('team');
}

function isPlusOrProSubscription(summary) {
  const plan = String(summary?.plan_type || summary?.subscription_plan || '').toLowerCase();
  return plan.includes('plus') || plan.includes('pro');
}

async function verifyCard() {
  const button = $('#verify-btn');
  const channel = getChannel();
  if (button.disabled) return;
  const cardKey = normalizeKey($('#card-key').value);
  $('#card-key').value = cardKey;
  if (!isPlausibleKey(cardKey)) {
    showToast('请输入 4–128 位有效卡密', 'error');
    $('#card-key').focus();
    return;
  }

  setLoading(button, true, '正在验证…');
  try {
    const result = await apiRequest('/verify-cdk', {
      method: 'POST',
      body: { cdk_code: cardKey },
    });
    if (result.valid !== true) {
      if (result.pending === true) {
        try {
          await openExistingTask(cardKey, { channel: channel.id, cancellable: channel.supportsCancel && Boolean(result.cancellable) });
          showToast('该卡密已有任务，已为你打开处理进度');
          return;
        } catch {
          throw new Error(result.error || '该卡密正在处理中，请稍后查询');
        }
      }
      throw new Error(result.error || '该卡密当前不可提交');
    }
    state.verifiedCardKey = cardKey;
    state.verifiedPlan = String(result.plan_type || '');
    state.refreshRemaining = Math.max(0, Math.floor(Number(result.refresh_remaining ?? 0) || 0));
    $('#masked-card-key').textContent = maskKey(cardKey);
    $('#refresh-cdk-btn').classList.toggle('hidden', !channel.supportsRefresh || state.refreshRemaining < 1);
    $('#refresh-cdk-btn').textContent = `换一张卡密（剩余 ${state.refreshRemaining} 次）`;
    $('#refresh-result').classList.add('hidden');
    $('#refreshed-card-code').textContent = '';
    showStep(2);
    $('#session-json').focus();
    showToast('卡密验证通过');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setLoading(button, false);
  }
}

async function prepareRedeem() {
  const button = $('#redeem-btn');
  const channel = getChannel();
  if (button.disabled) return;
  let sessionInfo;
  try {
    sessionInfo = parseSessionJsonValue($('#session-json').value);
  } catch (error) {
    showToast(error.message, 'error');
    return;
  }

  setLoading(button, true, '正在检查账号…');
  try {
    const result = await apiRequest('/check-subscription', {
      method: 'POST',
      body: { token_input: sessionInfo.sessionJson },
    });
    if (result.ok !== true || !result.summary) {
      if (['invalid_input', 'invalid_session'].includes(result.code)) {
        throw new Error(result.error || 'Session 无效或已过期，请重新获取后再试');
      }
      if (channel.id === 'advanced') {
        throw new Error(result.error || '进阶充值需要先确认账号订阅状态，请稍后重试');
      }
      const uncheckedSession = Object.freeze({
        ...sessionInfo,
        subscriptionWarning: true,
      });
      openAccountConfirmModal(uncheckedSession);
      showToast(result.error ? `${result.error}，将由处理时复查` : '订阅状态暂未确认，将由处理时复查');
      return;
    }
    const summary = result.summary;
    const confirmedSession = Object.freeze({
      ...sessionInfo,
      accountLabel: summary.account_email || sessionInfo.accountLabel,
    });
    state.pendingRedeemSession = confirmedSession;
    const plan = String(summary.plan_type || '').toLowerCase();
    const hasMembership = summary.has_active_subscription === true || (plan && plan !== 'free');
    if (isTeamSubscription(summary)) {
      openSubscriptionModal(summary, { blockedReason: 'Team 账号暂不支持' });
      return;
    }
    if (hasMembership) {
      const canContinue = channel.allowsActiveSubscription
        && (summary.can_redeem !== false || isPlusOrProSubscription(summary));
      if (canContinue) {
        openSubscriptionModal(summary, { canContinue: true });
      } else {
        openSubscriptionModal(summary, {
          blockedReason: channel.id === 'advanced' ? '当前账号暂不支持' : '',
        });
      }
      return;
    }
    if (channel.id === 'advanced' && summary.can_redeem === false) {
      openSubscriptionModal(summary, { blockedReason: '当前账号暂不支持' });
      return;
    }
    openAccountConfirmModal(confirmedSession);
  } catch (error) {
    if (channel.id === 'advanced' || !error.status || [400, 401, 403].includes(error.status)) {
      clearPendingRedeemSession();
      showToast(error.message, 'error');
    } else {
      openAccountConfirmModal(Object.freeze({
        ...sessionInfo,
        subscriptionWarning: true,
      }));
      showToast(`${error.message}，将由处理时复查`);
    }
  } finally {
    setLoading(button, false);
  }
}

async function refreshVerifiedCard() {
  const button = $('#confirm-operation');
  if (!getChannel().supportsRefresh) return;
  const oldCode = state.verifiedCardKey;
  if (!oldCode || state.refreshRemaining < 1 || button.disabled) return;
  setLoading(button, true, '正在换码…');
  try {
    const result = await apiRequest('/refresh-cdk', {
      method: 'POST',
      body: { cdk_code: oldCode },
    });
    const newCode = normalizeKey(result.new_code);
    if (!isPlausibleKey(newCode)) throw new Error('接口未返回有效的新卡密，请联系客服');
    state.verifiedCardKey = newCode;
    state.verifiedPlan = String(result.plan_type || state.verifiedPlan || '');
    state.refreshRemaining = Math.max(0, Math.floor(Number(result.refresh_remaining ?? 0) || 0));
    $('#card-key').value = newCode;
    $('#masked-card-key').textContent = maskKey(newCode);
    $('#refreshed-card-code').textContent = newCode;
    $('#refresh-remaining-note').textContent = state.refreshRemaining > 0
      ? `仍可换码 ${state.refreshRemaining} 次`
      : '换码次数已用完';
    $('#refresh-result').classList.remove('hidden');
    $('#refresh-cdk-btn').classList.toggle('hidden', !getChannel().supportsRefresh || state.refreshRemaining < 1);
    $('#refresh-cdk-btn').textContent = `换一张卡密（剩余 ${state.refreshRemaining} 次）`;
    closeOperationModal({ restoreFocus: false });
    $('#copy-refreshed-card').focus();
    showToast('换码成功，请立即复制并保存新卡密');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setLoading(button, false);
  }
}

function renderTask(task) {
  const status = getTaskStatus(task);
  const result = $('.result-section');
  result.dataset.state = status.kind;
  $('#task-result-title').textContent = status.kind === 'completed'
    ? '充值成功'
    : status.kind === 'failed'
      ? '充值未完成'
      : '充值申请已提交';
  $('#task-result-copy').textContent = status.kind === 'completed'
    ? '会员充值已经完成，请返回 ChatGPT 刷新账号状态。'
    : status.kind === 'failed'
      ? '本次处理未完成，你可以查看原因后重新提交。'
      : '任务正在后台处理，页面会自动更新进度。';
  $('#task-id').textContent = task.task_id || state.activeTask?.taskId || '—';
  $('#task-status').textContent = status.label;
  $('#task-account').textContent = task.account_email ? maskEmail(task.account_email) : '等待识别';
  $('#task-time').textContent = formatDateTime(task.completed_at || task.updated_at || task.created_at);
  const failure = $('#task-failure');
  if (status.kind === 'failed' && task.failure_reason) {
    $('#task-failure-text').textContent = task.failure_reason;
    failure.classList.remove('hidden');
  } else {
    failure.classList.add('hidden');
  }
  $('#refresh-task-btn').classList.toggle('hidden', status.terminal);
  $('#retry-task-btn').classList.toggle('hidden', status.kind !== 'failed');
  $('#cancel-task-btn').classList.toggle('hidden', !getChannel(state.activeTask?.channel).supportsCancel || !state.activeTask?.cancellable || status.terminal);
  showStep(3);
  return status;
}

function activateTask(task, cardKey, { channel = state.activeChannel, cancellable } = {}) {
  const previousTask = state.activeTask?.cardKey === cardKey && state.activeTask.channel === channel ? state.activeTask : null;
  const status = getTaskStatus(task);
  const taskStatus = String(task?.task_status || task?.status || '').trim().toLowerCase();
  const canCancel = status.terminal || taskStatus === 'manual_review'
    ? false
    : Boolean(getChannel(channel).supportsCancel && (cancellable ?? previousTask?.cancellable));
  state.activeTask = {
    channel,
    cardKey,
    taskId: task.task_id || state.activeTask?.taskId || '',
    cancellable: canCancel,
    latestTask: { ...task },
  };
  state.verifiedCardKey = '';
  state.verifiedPlan = '';
  state.refreshRemaining = 0;
  $('#session-json').value = '';
  $('#refresh-result').classList.add('hidden');
  $('#refreshed-card-code').textContent = '';
  renderTask(task);
  if (status.terminal) stopTaskPolling();
  else scheduleTaskPoll();
}

function scheduleTaskPoll(delay = CONFIG.taskPollInterval) {
  stopTaskPolling();
  state.taskPollTimer = setTimeout(() => refreshActiveTask({ silent: true }), delay);
}

async function fetchTask(cardKey, channel = state.activeTask?.channel || state.activeChannel) {
  const payload = await apiRequest('/lookup/tasks', {
    method: 'POST',
    body: { codes: [cardKey] },
    channel,
  });
  if (!Array.isArray(payload.tasks)) throw new Error('任务查询接口返回格式异常');
  const normalized = normalizeKey(cardKey).toLowerCase();
  const task = payload.tasks.find((item) => normalizeKey(item?.cdk_code).toLowerCase() === normalized);
  if (task) return task;
  const error = new Error('暂未查询到任务记录，请稍后重试');
  error.status = 404;
  throw error;
}

async function openExistingTask(cardKey, options = {}) {
  const task = await fetchTask(cardKey, options.channel);
  activateTask(task, cardKey, options);
}

async function discoverTaskCancellation(cardKey) {
  const channel = state.activeTask?.channel;
  if (!getChannel(channel).supportsCancel) return;
  try {
    const result = await apiRequest('/verify-cdk', {
      method: 'POST',
      body: { cdk_code: cardKey },
      timeout: 8000,
      channel,
    });
    if (state.activeTask?.cardKey !== cardKey || state.activeTask?.channel !== channel || result.pending !== true) return;
    state.activeTask.cancellable = Boolean(result.cancellable);
    renderTask(state.activeTask.latestTask || {});
  } catch {
    // Cancellation is an optional recovery action; task tracking remains available.
  }
}

async function refreshActiveTask({ silent = false } = {}) {
  if (!state.activeTask?.cardKey) return;
  const cardKey = state.activeTask.cardKey;
  const channel = state.activeTask.channel;
  const generation = state.taskGeneration;
  const button = $('#refresh-task-btn');
  if (!silent) setLoading(button, true, '正在刷新…');
  try {
    const task = await fetchTask(cardKey, channel);
    if (generation !== state.taskGeneration || state.activeTask?.cardKey !== cardKey || state.activeTask?.channel !== channel) return;
    activateTask(task, cardKey, { channel });
    if (!silent) showToast('任务状态已更新');
  } catch (error) {
    if (generation !== state.taskGeneration || state.activeTask?.cardKey !== cardKey) return;
    if (!silent) showToast(error.message, 'error');
    scheduleTaskPoll(Math.max(CONFIG.taskPollInterval, (error.retryAfter || 0) * 1000));
  } finally {
    if (!silent) setLoading(button, false);
  }
}

async function submitRedeem(sessionInfo) {
  const button = $('#redeem-btn');
  if (button.disabled || !sessionInfo?.sessionJson) return;
  const cardKey = state.verifiedCardKey;
  const channel = state.activeChannel;
  $('#session-json').value = '';
  clearPendingRedeemSession();
  setLoading(button, true, '正在提交…');
  try {
    const task = await apiRequest('/create-task', {
      method: 'POST',
      body: buildCreateTaskPayload(cardKey, sessionInfo),
      channel,
    });
    if (!task.task_id) throw new Error('接口未返回任务编号，请查询卡密状态');
    activateTask(task, cardKey, { channel });
    if (getChannel(channel).supportsCancel) void discoverTaskCancellation(cardKey);
  } catch (error) {
    if (error.status === 409 && error.payload?.task_id) {
      activateTask(error.payload, cardKey, { channel });
      if (getChannel(channel).supportsCancel) void discoverTaskCancellation(cardKey);
      showToast('该卡密已有任务，已为你打开处理进度');
    } else {
      showToast(`${error.message}；Session 已清除，请重新粘贴后再试`, 'error');
    }
  } finally {
    setLoading(button, false);
  }
}

async function cancelActiveTask() {
  const button = $('#confirm-operation');
  const cardKey = state.activeTask?.cardKey;
  const channel = state.activeTask?.channel;
  if (!cardKey || !getChannel(channel).supportsCancel || button.disabled) return;
  setLoading(button, true, '正在取消…');
  try {
    const result = await apiRequest('/cancel-task', {
      method: 'POST',
      body: { cdk_code: cardKey },
      channel,
    });
    if (result.ok !== true) throw new Error(result.error || '任务未能取消');
    stopTaskPolling();
    state.taskGeneration += 1;
    state.activeTask = null;
    state.verifiedCardKey = '';
    state.verifiedPlan = '';
    state.refreshRemaining = 0;
    $('#session-json').value = '';
    $('#card-key').value = cardKey;
    $('#refresh-result').classList.add('hidden');
    $('#refreshed-card-code').textContent = '';
    closeOperationModal({ restoreFocus: false });
    showStep(1);
    $('#verify-btn').focus();
    showToast(result.message || '任务已取消，请重新验证卡密后提交');
  } catch (error) {
    const code = error.payload?.code;
    if (['already_running', 'manual_review', 'completed', 'failed', 'no_task'].includes(code)) {
      if (state.activeTask?.cardKey === cardKey) state.activeTask.cancellable = false;
      closeOperationModal({ restoreFocus: false });
      if (state.activeTask?.latestTask) renderTask(state.activeTask.latestTask);
    }
    showToast(error.message, 'error');
  } finally {
    setLoading(button, false);
  }
}

function parseBatchKeys() {
  return [...new Set($('#batch-keys').value
    .split(/[\s,，;；]+/)
    .map(normalizeKey)
    .filter(Boolean))];
}

function updateBatchControls() {
  const count = parseBatchKeys().length;
  $('#key-count').textContent = `${count} / 100`;
  $('#key-count').classList.toggle('over-limit', count > 100);
  $('#batch-clear').disabled = $('#batch-keys').value.length === 0;
  $('#batch-view-results').classList.add('hidden');
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

function mergeTaskResults(codes, tasks) {
  const taskMap = new Map();
  tasks.forEach((task) => {
    const key = normalizeKey(task.cdk_code);
    if (key) {
      taskMap.set(key, task);
      taskMap.set(key.toLowerCase(), task);
    }
  });
  return codes.map((code) => taskMap.get(code) || taskMap.get(code.toLowerCase()) || {
    cdk_code: code,
    task_status: 'not_found',
  });
}

function renderBatchSummary(items) {
  const counts = items.reduce((summary, item) => {
    summary[getTaskStatus(item).kind] += 1;
    return summary;
  }, { processing: 0, completed: 0, failed: 0, missing: 0 });
  const labels = {
    processing: '处理中',
    completed: '已完成',
    failed: '失败',
    missing: '无记录',
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
}

function openBatchResultsModal({ returnFocus } = {}) {
  state.batchModalReturnFocus = returnFocus || document.activeElement;
  setModalVisibility($('#batch-results-modal'), true);
  $('.batch-results-modal-close').focus();
}

function closeBatchResultsModal({ restoreFocus = true } = {}) {
  setModalVisibility($('#batch-results-modal'), false);
  if (restoreFocus && state.batchModalReturnFocus instanceof HTMLElement) {
    state.batchModalReturnFocus.focus();
  }
  state.batchModalReturnFocus = null;
}

function createResultMeta(item, status) {
  const meta = document.createElement('div');
  meta.className = 'batch-result-meta';
  if (item.account_email) {
    const account = document.createElement('span');
    account.append('充值账号：');
    const value = document.createElement('b');
    value.textContent = maskEmail(item.account_email);
    account.append(value);
    meta.append(account);
  }
  if (item.task_id) {
    const taskId = document.createElement('span');
    taskId.append('任务编号：');
    const value = document.createElement('b');
    value.textContent = item.task_id;
    taskId.append(value);
    meta.append(taskId);
  }
  const appendTime = (label, time) => {
    if (!time) return;
    const timeRow = document.createElement('span');
    timeRow.append(`${label}：`);
    const value = document.createElement('b');
    value.textContent = formatDateTime(time);
    timeRow.append(value);
    meta.append(timeRow);
  };
  appendTime('提交时间', item.created_at);
  if (item.updated_at && item.updated_at !== item.created_at) appendTime('更新时间', item.updated_at);
  if (status.kind === 'completed') appendTime('完成时间', item.completed_at);
  if (status.kind === 'failed' && item.failure_reason) {
    const reason = document.createElement('span');
    reason.className = 'failure-reason';
    reason.textContent = `失败原因：${item.failure_reason}`;
    meta.append(reason);
  }
  return meta;
}

async function queryBatch() {
  const button = $('#batch-btn');
  const channel = state.activeChannel;
  if (button.disabled) return;
  const codes = parseBatchKeys();
  if (codes.length > 100) return showToast(`单次最多查询 100 个，当前为 ${codes.length} 个`, 'error');
  if (!codes.length) return showToast('请至少输入一个卡密', 'error');
  if (codes.some((key) => !isPlausibleKey(key))) return showToast('列表中存在长度异常的卡密', 'error');

  $('#batch-view-results').classList.add('hidden');
  setLoading(button, true, '正在查询…');
  try {
    const payload = await apiRequest('/lookup/tasks', {
      method: 'POST',
      body: { codes },
      channel,
    });
    if (channel !== state.activeChannel) return;
    if (!Array.isArray(payload.tasks)) throw new Error('查询接口返回格式异常');
    const items = mergeTaskResults(codes, payload.tasks);
    renderBatchSummary(items);
    const container = $('#batch-results');
    container.replaceChildren(...items.map((item) => {
      const status = getTaskStatus(item);
      const row = document.createElement('div');
      row.className = 'batch-result';
      const head = document.createElement('div');
      head.className = 'batch-result-head';
      const key = document.createElement('code');
      key.className = 'batch-result-key';
      key.textContent = item.cdk_code || '—';
      const badge = document.createElement('b');
      badge.className = `batch-status ${status.kind}`;
      badge.textContent = status.label;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy-key';
      copy.title = '复制卡密';
      copy.setAttribute('aria-label', `复制卡密 ${item.cdk_code || ''}`);
      copy.textContent = '复制';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(item.cdk_code || '');
          showToast('卡密已复制');
        } catch {
          showToast('复制失败，请手动复制', 'error');
        }
      });
      const actions = document.createElement('div');
      actions.className = 'batch-result-actions';
      actions.append(badge, copy);
      head.append(key, actions);
      row.append(head);
      const meta = createResultMeta(item, status);
      if (meta.childElementCount) row.append(meta);
      return row;
    }));
    $('#batch-results-count').textContent = `${getChannel(channel).label} · 共 ${items.length} 条查询结果`;
    $('#batch-view-results').classList.remove('hidden');
    openBatchResultsModal({ returnFocus: button });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setLoading(button, false);
  }
}

function retryFailedTask() {
  if (!state.activeTask?.cardKey) return;
  state.verifiedCardKey = state.activeTask.cardKey;
  $('#masked-card-key').textContent = maskKey(state.activeTask.cardKey);
  $('#session-json').value = '';
  stopTaskPolling();
  showStep(2);
  $('#session-json').focus();
  showToast('请重新粘贴 Session JSON 后提交');
}

function bindEvents() {
  $$('.channel-choice').forEach((button) => {
    button.addEventListener('click', () => requestChannelChange(button.dataset.channel, button));
  });

  $$('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => activateModeTab(tab));
    tab.addEventListener('keydown', handleModeTabKeydown);
  });

  $$('.utility-action').forEach((button) => {
    button.addEventListener('click', () => handleUtilityAction(button.dataset.tool));
  });
  $('#queue-live-label').addEventListener('click', retryQueueStatus);

  $('#paste-key').addEventListener('click', async () => {
    try {
      $('#card-key').value = normalizeKey(await navigator.clipboard.readText());
    } catch {
      showToast('浏览器未允许读取剪贴板，请手动粘贴', 'error');
    }
  });
  $('#paste-session').addEventListener('click', async () => {
    try {
      $('#session-json').value = await navigator.clipboard.readText();
    } catch {
      showToast('浏览器未允许读取剪贴板，请手动粘贴', 'error');
    }
  });
  $('#card-key').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      verifyCard();
    }
  });
  $('#verify-btn').addEventListener('click', verifyCard);
  $('#change-key').addEventListener('click', resetRecharge);
  $('#refresh-cdk-btn').addEventListener('click', () => openOperationModal('refresh'));
  $('#copy-refreshed-card').addEventListener('click', async () => {
    const cardKey = normalizeKey($('#refreshed-card-code').textContent);
    try {
      await navigator.clipboard.writeText(cardKey);
      showToast('新卡密已复制，请妥善保存');
    } catch {
      showToast('复制失败，请手动复制并保存新卡密', 'error');
    }
  });
  $('#recharge-form').addEventListener('submit', (event) => {
    event.preventDefault();
    prepareRedeem();
  });
  $('#restart-btn').addEventListener('click', resetRecharge);
  $('#retry-task-btn').addEventListener('click', retryFailedTask);
  $('#refresh-task-btn').addEventListener('click', () => refreshActiveTask());
  $('#cancel-task-btn').addEventListener('click', () => openOperationModal('cancel'));

  $('#batch-keys').addEventListener('input', updateBatchControls);
  $('#batch-clear').addEventListener('click', clearBatchKeys);
  $('#batch-btn').addEventListener('click', queryBatch);
  $('#batch-view-results').addEventListener('click', () => openBatchResultsModal());
  $('.batch-results-modal-close').addEventListener('click', () => closeBatchResultsModal());
  $('#close-batch-results').addEventListener('click', () => closeBatchResultsModal());
  $('#batch-results-modal').addEventListener('click', (event) => {
    if (event.target.id === 'batch-results-modal') closeBatchResultsModal();
  });

  $('.account-modal-close').addEventListener('click', () => closeAccountConfirmModal());
  $('#cancel-account-redeem').addEventListener('click', () => closeAccountConfirmModal());
  $('#account-confirm-modal').addEventListener('click', (event) => {
    if (event.target.id === 'account-confirm-modal') closeAccountConfirmModal();
  });
  $('#confirm-account-redeem').addEventListener('click', () => {
    const sessionInfo = state.pendingRedeemSession;
    closeAccountConfirmModal({ restoreFocus: false, clearPending: false });
    submitRedeem(sessionInfo);
  });

  $('.channel-switch-modal-close').addEventListener('click', () => closeChannelSwitchModal());
  $('#cancel-channel-switch').addEventListener('click', () => closeChannelSwitchModal());
  $('#confirm-channel-switch').addEventListener('click', () => {
    const nextChannel = state.pendingChannel;
    const returnFocus = state.channelSwitchReturnFocus;
    closeChannelSwitchModal({ restoreFocus: false });
    if (nextChannel) applyChannelChange(nextChannel);
    returnFocus?.focus();
  });
  $('#channel-switch-modal').addEventListener('click', (event) => {
    if (event.target.id === 'channel-switch-modal') closeChannelSwitchModal();
  });

  $('.subscription-modal-close').addEventListener('click', () => closeSubscriptionModal());
  $('#close-subscription').addEventListener('click', () => closeSubscriptionModal());
  $('#continue-subscription').addEventListener('click', () => {
    if (!state.subscriptionCanContinue) return;
    const sessionInfo = state.pendingRedeemSession;
    const returnFocus = state.subscriptionModalReturnFocus;
    closeSubscriptionModal({ restoreFocus: false, clearPending: false });
    if (sessionInfo) openAccountConfirmModal(sessionInfo, { returnFocus });
  });
  $('#subscription-modal').addEventListener('click', (event) => {
    if (event.target.id === 'subscription-modal') closeSubscriptionModal();
  });

  $('.operation-modal-close').addEventListener('click', () => closeOperationModal());
  $('#cancel-operation').addEventListener('click', () => closeOperationModal());
  $('#confirm-operation').addEventListener('click', () => {
    if (state.pendingOperation === 'refresh') refreshVerifiedCard();
    else if (state.pendingOperation === 'cancel') cancelActiveTask();
  });
  $('#operation-modal').addEventListener('click', (event) => {
    if (event.target.id === 'operation-modal') closeOperationModal();
  });

  $('.quick-tool-modal-close').addEventListener('click', () => closeQuickTool());
  $('#close-quick-tool').addEventListener('click', () => closeQuickTool());
  $('#submit-quick-tool').addEventListener('click', handleQuickToolSubmit);
  $('#quick-tool-modal').addEventListener('click', (event) => {
    if (event.target.id === 'quick-tool-modal') closeQuickTool();
  });
  $('#quick-card-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleQuickToolSubmit();
    }
  });
  $('#quick-subscription-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      handleQuickToolSubmit();
    }
  });
  $('#copy-quick-new-code').addEventListener('click', async () => {
    const cardKey = normalizeKey($('#quick-new-code-value').textContent);
    try {
      await navigator.clipboard.writeText(cardKey);
      showToast('新卡密已复制，请妥善保存');
    } catch {
      showToast('复制失败，请手动复制并保存新卡密', 'error');
    }
  });
  document.addEventListener('keydown', (event) => {
    if (trapModalFocus(event)) return;
    if (event.key !== 'Escape') return;
    if (!$('#account-confirm-modal').classList.contains('hidden')) closeAccountConfirmModal();
    else if (!$('#channel-switch-modal').classList.contains('hidden')) closeChannelSwitchModal();
    else if (!$('#subscription-modal').classList.contains('hidden')) closeSubscriptionModal();
    else if (!$('#operation-modal').classList.contains('hidden')) closeOperationModal();
    else if (!$('#quick-tool-modal').classList.contains('hidden')) closeQuickTool();
    else if (!$('#batch-results-modal').classList.contains('hidden')) closeBatchResultsModal();
  });
}

if (typeof document !== 'undefined') {
  configureBrand();
  setupEntranceMotion();
  startHandwrittenIntro();
  startHandwrittenAmbientMotion();
  startHeroSubtitleRotation();
  bindEvents();
  updateChannelInterface();
  prefillCardKeyFromUrl();
  loadAnnouncement();
  startQueueUpdates();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildCreateTaskPayload,
    formatDateTime,
    getCardKeyFromUrl,
    getQueueDisplay,
    getQueueErrorDisplay,
    getTaskStatus,
    isPlausibleKey,
    maskKey,
    mergeTaskResults,
    normalizeKey,
    parseSessionJsonValue,
  };
}
