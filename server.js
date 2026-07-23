const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const configuredPort = Number(process.env.PORT);
const host = process.env.HOST || '0.0.0.0';
const port = Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65535
  ? configuredPort
  : 4173;
const trustProxy = process.env.TRUST_PROXY === '1';
const root = __dirname;
const upstreamHostname = 'jzai16888.com';
const upstreamOrigin = `https://${upstreamHostname}`;
const apiRoutes = new Map([
  ['/api-proxy/verify-cardkey', '/api/v1/verify-cardkey'],
  ['/api-proxy/redeem', '/api/v1/redeem'],
  ['/api-proxy/cardkey/batch-status', '/api/v1/cardkey/batch-status'],
]);
const rateLimitRules = new Map([
  ['/api-proxy/verify-cardkey', { perIp: 10, global: 10, rawPerIp: 30 }],
  ['/api-proxy/redeem', { perIp: 5, global: 5, rawPerIp: 30 }],
  ['/api-proxy/cardkey/batch-status', { perIp: 10, global: 10, rawPerIp: 30 }],
]);
const rateLimitBuckets = new Map();
const rateLimitWindowMs = 60 * 1000;
const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' ${upstreamOrigin}; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    ...securityHeaders,
    ...extraHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  response.end(body);
}

function getClientIp(request) {
  let clientIp = request.socket.remoteAddress || 'unknown';
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const firstAddress = value?.split(',')[0]?.trim();
    if (firstAddress) clientIp = firstAddress.slice(0, 64);
  }
  return clientIp;
}

function activeRateBucket(key, now) {
  const active = (rateLimitBuckets.get(key) || []).filter((timestamp) => now - timestamp < rateLimitWindowMs);
  if (active.length) rateLimitBuckets.set(key, active);
  else rateLimitBuckets.delete(key);
  return active;
}

function enforceRateLimit(request, response, publicPath, { phase = 'validated' } = {}) {
  const rule = rateLimitRules.get(publicPath);
  if (!rule) return true;

  const now = Date.now();
  const clientIp = getClientIp(request);
  const configuredBuckets = phase === 'raw'
    ? [{ key: `raw-ip:${publicPath}:${clientIp}`, limit: rule.rawPerIp }]
    : [
        { key: `global:${publicPath}`, limit: rule.global },
        { key: `ip:${publicPath}:${clientIp}`, limit: rule.perIp },
      ];
  const buckets = configuredBuckets.map((entry) => ({
    ...entry,
    values: activeRateBucket(entry.key, now),
  }));
  const blocked = buckets.find((entry) => entry.values.length >= entry.limit);
  if (blocked) {
    const retryAfter = Math.max(1, Math.ceil((blocked.values[0] + rateLimitWindowMs - now) / 1000));
    sendJson(response, 429, { code: 42900, message: '请求过于频繁，请稍后重试' }, {
      'Retry-After': String(retryAfter),
    });
    return false;
  }

  buckets.forEach((entry) => {
    entry.values.push(now);
    rateLimitBuckets.set(entry.key, entry.values);
  });
  return true;
}

function validateProxyPayload(upstreamPath, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '请求体必须是 JSON 对象';
  const isCardKey = (value) => typeof value === 'string' && /^Plus-[A-Z0-9]{16}$/.test(value);

  if (upstreamPath === '/api/v1/verify-cardkey') {
    return isCardKey(payload.cardKey) ? null : 'cardKey 格式不正确';
  }
  if (upstreamPath === '/api/v1/cardkey/batch-status') {
    if (!Array.isArray(payload.cardKeys) || payload.cardKeys.length < 1 || payload.cardKeys.length > 100) {
      return 'cardKeys 数量必须为 1–100 个';
    }
    return payload.cardKeys.every(isCardKey) ? null : 'cardKeys 中存在格式错误的卡密';
  }
  if (upstreamPath === '/api/v1/redeem') {
    if (!isCardKey(payload.cardKey)) return 'cardKey 格式不正确';
    if (typeof payload.accountSession !== 'string' || !payload.accountSession || payload.accountSession.length > 256 * 1024) {
      return 'accountSession 格式或长度不正确';
    }
    if (payload.confirmOverride !== undefined && typeof payload.confirmOverride !== 'boolean') {
      return 'confirmOverride 必须是布尔值';
    }
    try {
      const session = JSON.parse(payload.accountSession);
      if (!session || typeof session !== 'object' || typeof session.account?.id !== 'string' || !session.account.id.trim()) {
        return 'accountSession 中缺少 account.id';
      }
    } catch {
      return 'accountSession 不是有效的 JSON 字符串';
    }
    return null;
  }
  return '不支持的代理接口';
}

function proxyApi(request, response, upstreamPath, publicPath) {
  if (request.method !== 'POST') {
    response.writeHead(405, { ...securityHeaders, Allow: 'POST' }).end('Method not allowed');
    return;
  }
  if (!enforceRateLimit(request, response, publicPath, { phase: 'raw' })) return;
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    sendJson(response, 415, { code: 41500, message: '仅支持 application/json' });
    return;
  }

  const chunks = [];
  let size = 0;
  let rejected = false;
  request.on('data', (chunk) => {
    if (rejected) return;
    size += chunk.length;
    if (size > 512 * 1024) {
      rejected = true;
      sendJson(response, 413, { code: 41300, message: '请求内容过大' });
      request.removeAllListeners('data');
      request.resume();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (rejected) return;
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      sendJson(response, 400, { code: 40000, message: '请求体不是有效的 JSON' });
      return;
    }
    const validationError = validateProxyPayload(upstreamPath, payload);
    if (validationError) {
      sendJson(response, 400, { code: 40000, message: validationError });
      return;
    }
    if (!enforceRateLimit(request, response, publicPath)) return;
    const body = Buffer.from(JSON.stringify(payload));
    const upstream = https.request({
      hostname: upstreamHostname,
      port: 443,
      path: upstreamPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'User-Agent': 'Tim-AI-Recharge/1.0',
      },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, {
        ...securityHeaders,
        'Content-Type': upstreamResponse.headers['content-type'] || 'application/json; charset=utf-8',
      });
      upstreamResponse.pipe(response);
    });
    response.on('close', () => {
      if (!response.writableEnded) upstream.destroy(new Error('Client disconnected'));
    });
    upstream.setTimeout(18000, () => upstream.destroy(new Error('Upstream timeout')));
    upstream.on('error', () => {
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 502, { code: 50200, message: '充值接口暂时不可用，请稍后重试' });
      } else if (!response.destroyed) response.destroy();
    });
    upstream.end(body);
  });
}

function createServer() {
  return http.createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  if (apiRoutes.has(pathname)) {
    proxyApi(request, response, apiRoutes.get(pathname), pathname);
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { ...securityHeaders, Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      ...securityHeaders,
      'Content-Type': mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(filePath).pipe(response);
  });
  });
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const key of rateLimitBuckets.keys()) activeRateBucket(key, now);
}, 5 * 60 * 1000);
cleanupTimer.unref();

if (require.main === module) {
  const server = createServer();
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Tim AI: 端口 ${port} 已被占用，请停止旧服务或设置其他 PORT`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });
  server.listen(port, host, () => {
    const localHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    console.log(`Tim AI: http://${localHost}:${port}/`);
  });
}

module.exports = {
  createServer,
  enforceRateLimit,
  validateProxyPayload,
  resetRateLimits: () => rateLimitBuckets.clear(),
};
