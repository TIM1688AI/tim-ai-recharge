'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
function fail(status, message) { throw Object.assign(new Error(message), { status, safe: true }); }
function equal(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function config(env) {
  const key = Buffer.from(env.ADMIN_DATA_KEY || '', 'base64');
  if (key.length !== 32 || !env.DATABASE_URL || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(env.ADMIN_PASSWORD_HASH || '') || !/^[A-Z2-7]{32,}$/.test(env.ADMIN_TOTP_SECRET || '')) throw new Error('工作台配置不完整，请查看 WORKBENCH.md');
  const origin = new URL(env.ADMIN_ORIGIN || '');
  const local = ['localhost', '127.0.0.1'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(local && env.NODE_ENV !== 'production' && env.RENDER !== 'true')) throw new Error('工作台必须使用 HTTPS');
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('ADMIN_ORIGIN 必须为站点根地址');
  return { key, origin: origin.origin, secure: origin.protocol === 'https:', password: env.ADMIN_PASSWORD_HASH, totp: env.ADMIN_TOTP_SECRET };
}
function vault(key) {
  return {
    hash: text => crypto.createHmac('sha256', key).update(text).digest('hex'),
    seal(value) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(JSON.stringify(value)), c.final(), c.getAuthTag()]).toString('base64'); },
    open(value) { const data = Buffer.from(value, 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); d.setAuthTag(data.subarray(-16)); return JSON.parse(Buffer.concat([d.update(data.subarray(12, -16)), d.final()]).toString()); },
  };
}
async function passwordHash(password) { const salt = crypto.randomBytes(16).toString('hex'); return `scrypt$${salt}$${(await scrypt(password, salt, 64)).toString('hex')}`; }
async function checkPassword(password, encoded) { if (typeof password !== 'string' || password.length > 256) return false; const [, salt, hash] = encoded.split('$'); return equal((await scrypt(password, salt, 64)).toString('hex'), hash); }
function base32(secret) { let bits = ''; for (const ch of secret) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch).toString(2).padStart(5, '0'); return Buffer.from((bits.match(/.{8}/g) || []).map(b => parseInt(b, 2))); }
function totp(secret, counter) { const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter)); const h = crypto.createHmac('sha1', base32(secret)).update(msg).digest(); const offset = h[h.length - 1] & 15; return String((h.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0'); }
function totpCounter(secret, value, time = Date.now()) { if (!/^\d{6}$/.test(String(value))) return -1; const counter = Math.floor(time / 30000); return [counter, counter - 1, counter + 1].find(n => equal(totp(secret, n), value)) ?? -1; }
async function readJson(req) { if (!String(req.headers['content-type']).startsWith('application/json')) fail(415, '仅接受 JSON 请求'); let size = 0; const chunks = []; for await (const c of req) { size += c.length; if (size > 512 * 1024) fail(413, '请求过大'); chunks.push(c); } try { const p = JSON.parse(Buffer.concat(chunks).toString()); if (!p || typeof p !== 'object' || Array.isArray(p)) throw 0; return p; } catch { fail(400, 'JSON 格式错误'); } }
module.exports = { fail, equal, config, vault, passwordHash, checkPassword, totp, totpCounter, readJson };
