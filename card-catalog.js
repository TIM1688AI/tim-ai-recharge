'use strict';
// One server-side authority for aliases. Never replace inside a card's suffix.
const PREFIXES = Object.freeze([
  ['advanced', 'plus', 'JZ-', 'TIM-', 11],
  ['advanced', 'pro5', 'JZ5X-', 'TIM5X-', 11],
  ['advanced', 'pro20', 'JZ20X-', 'TIM20X-', 11],
  ['premium', 'claude_pro', 'CLAUDEPRO-', 'TIMC-PRO-'],
  ['premium', 'claude_max5', 'CLAUDEMAX5-', 'TIMC-MAX5-'],
  ['premium', 'claude_max5_special', 'CLAUDEMAX5SPECIAL-', 'TIMC-MAX5SPECIAL-'],
  ['premium', 'claude_max20', 'CLAUDEMAX20-', 'TIMC-MAX20-'],
  ['premium', 'plus', 'PLUS-', 'TIMG-PLUS-'],
  ['premium', 'pro5', 'PRO5-', 'TIMG-PRO5-'],
  ['premium', 'pro5_special', 'PRO5SPECIAL-', 'TIMG-PRO5SPECIAL-'],
  ['premium', 'pro20', 'PRO20-', 'TIMG-PRO20-'],
]);
const LABELS = Object.freeze({ plus: 'GPT Plus', plus_year: 'GPT 年Plus', pro5: 'GPT Pro 5X', pro5_special: 'GPT Pro 5X Special', pro20: 'GPT Pro 20X', claude_pro: 'Claude Pro', claude_max5: 'Claude Max 5X', claude_max5_special: 'Claude Max 5X Special', claude_max20: 'Claude Max 20X' });
const PRODUCTS = Object.freeze({ regular: ['plus', 'plus_year', 'pro5', 'pro20'], advanced: ['plus', 'plus_year', 'pro5', 'pro20'], premium: ['plus', 'pro5', 'pro5_special', 'pro20', 'claude_pro', 'claude_max5', 'claude_max5_special', 'claude_max20'] });
function card(channel, value, { raw = false, product } = {}) {
  if (!PRODUCTS[channel] || typeof value !== 'string' || value.length > 128) throw new Error('卡密或通道不正确');
  const code = value.trim();
  if (!code || /\s|[\u0000-\u001f\u007f]/.test(code)) throw new Error('卡密不能包含空格或控制字符');
  if (channel === 'regular') {
    if (code.length < 4 || PREFIXES.some(p => code.startsWith(p[2]) || code.startsWith(p[3])) || /^LZ/.test(code)) throw new Error('卡密不属于常规通道');
    if (!PRODUCTS.regular.includes(product)) throw new Error('请选择常规产品');
    return { channel, product, supplier: code, public: code };
  }
  if (channel === 'advanced' && /^[A-Z0-9]{16}$/.test(code)) {
    if (product && product !== 'plus_year') throw new Error('年度卡与产品不符');
    return { channel, product: 'plus_year', supplier: code, public: code };
  }
  for (const [provider, type, original, alias, length] of PREFIXES) {
    if (provider !== channel) continue;
    const prefix = code.startsWith(alias) ? alias : raw && code.startsWith(original) ? original : null;
    if (!prefix) continue;
    const suffix = code.slice(prefix.length);
    if (!/^[A-Z0-9]+$/.test(suffix) || (length ? suffix.length !== length : original.length + suffix.length < 8 || original.length + suffix.length > 64)) throw new Error('卡密后缀格式不正确');
    if (product && product !== type) throw new Error('卡密与所选产品不符');
    return { channel, product: type, supplier: original + suffix, public: alias + suffix };
  }
  throw new Error('未识别的卡密格式');
}
function productFromPlan(value) {
  const s = String(value || '').toLowerCase().replace(/[\s_-]/g, '');
  const aliases = {
    plus: ['plus', 'chatgptplus', 'gptplus', '月度plus', 'plus月卡'],
    plus_year: ['plusyear', 'plusannual', '年度plus', '年plus', 'plus年卡'],
    pro5: ['pro5', 'pro5x', 'chatgptpro5x', 'gptpro5x', '5x'],
    pro5_special: ['pro5special', 'pro5xspecial', 'chatgptpro5xspecial', 'gptpro5xspecial'],
    pro20: ['pro20', 'pro20x', 'chatgptpro20x', 'gptpro20x', '20x'],
    claude_pro: ['claudepro'], claude_max5: ['claudemax5', 'claudemax5x'], claude_max5_special: ['claudemax5special', 'claudemax5xspecial'], claude_max20: ['claudemax20', 'claudemax20x'],
  };
  return Object.keys(aliases).find(key => aliases[key].includes(s)) || '';
}
function mask(value) { const s = String(value || ''); return !s ? '' : s.length <= 8 ? '••••' : s.slice(0, 5) + '••••' + s.slice(-4); }
module.exports = { PREFIXES, PRODUCTS, LABELS, card, productFromPlan, mask };
