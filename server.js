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
const upstreamApiKey = String(process.env.STATION_API_KEY || '').trim();
const upstreamBaseUrl = createUpstreamBaseUrl(process.env.CDK_API_BASE_URL || 'http://localhost:8080/api/v1');
const staticFiles = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
]);

const apiRoutes = new Map([
  ['/api-proxy/status', { method: 'GET', upstreamPath: '' }],
  ['/api-proxy/announcement', { method: 'GET', upstreamPath: 'announcement' }],
  ['/api-proxy/verify-cdk', { method: 'POST', upstreamPath: 'recharge/verify-cdk' }],
  ['/api-proxy/create-task', { method: 'POST', upstreamPath: 'recharge/create-task' }],
  ['/api-proxy/refresh-cdk', { method: 'POST', upstreamPath: 'recharge/refresh-cdk' }],
  ['/api-proxy/cancel-task', { method: 'POST', upstreamPath: 'recharge/cancel-task' }],
  ['/api-proxy/check-subscription', { method: 'POST', upstreamPath: 'recharge/check-subscription' }],
  ['/api-proxy/queue-status', { method: 'GET', upstreamPath: 'recharge/queue-status' }],
  ['/api-proxy/queue-events', { method: 'GET', upstreamPath: 'recharge/queue-events', sse: true }],
  ['/api-proxy/lookup/tasks', { method: 'POST', upstreamPath: 'lookup/tasks' }],
]);

const rateLimitRules = new Map([
  ['/api-proxy/status', { perIp: 30, global: 300, rawPerIp: 60 }],
  ['/api-proxy/announcement', { perIp: 30, global: 300, rawPerIp: 60 }],
  ['/api-proxy/verify-cdk', { perIp: 60, global: 600, rawPerIp: 90 }],
  ['/api-proxy/create-task', { perIp: 20, global: 300, rawPerIp: 40 }],
  ['/api-proxy/refresh-cdk', { perIp: 12, global: 180, rawPerIp: 24 }],
  ['/api-proxy/cancel-task', { perIp: 12, global: 180, rawPerIp: 24 }],
  ['/api-proxy/check-subscription', { perIp: 20, global: 300, rawPerIp: 40 }],
  ['/api-proxy/queue-status', { perIp: 30, global: 600, rawPerIp: 60 }],
  ['/api-proxy/queue-events', { perIp: 12, global: 600, rawPerIp: 24 }],
  ['/api-proxy/lookup/tasks', { perIp: 30, global: 600, rawPerIp: 60 }],
]);

const rateLimitBuckets = new Map();
const rateLimitWindowMs = 60 * 1000;
const sseConnectionsByIp = new Map();
const sseConnectionLimits = { perIp: 2, global: 200 };
let activeSseConnections = 0;
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-DNS-Prefetch-Control': 'off',
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

function createUpstreamBaseUrl(value) {
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('CDK_API_BASE_URL 仅支持 http 或 https');
  }
  const configuredPath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${configuredPath && configuredPath !== '/' ? configuredPath : '/api/v1'}/`;
  url.search = '';
  url.hash = '';
  return url;
}

function buildUpstreamUrl(upstreamPath, requestUrl) {
  const target = new URL(String(upstreamPath || '').replace(/^\/+/, ''), upstreamBaseUrl);
  if (!upstreamPath) target.pathname = target.pathname.replace(/\/$/, '');
  return target;
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    ...securityHeaders,
    ...extraHeaders,
    'Cache-Control': 'no-store',
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

function acquireSseSlot(request, response) {
  const clientIp = getClientIp(request);
  const perIpCount = sseConnectionsByIp.get(clientIp) || 0;
  if (perIpCount >= sseConnectionLimits.perIp || activeSseConnections >= sseConnectionLimits.global) {
    sendJson(response, 429, { code: 'sse_capacity_reached', error: '实时队列连接较多，页面将自动使用轮询更新' }, {
      'Retry-After': '30',
    });
    return false;
  }

  activeSseConnections += 1;
  sseConnectionsByIp.set(clientIp, perIpCount + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeSseConnections = Math.max(0, activeSseConnections - 1);
    const remaining = Math.max(0, (sseConnectionsByIp.get(clientIp) || 1) - 1);
    if (remaining) sseConnectionsByIp.set(clientIp, remaining);
    else sseConnectionsByIp.delete(clientIp);
  };
  response.once('close', release);
  response.once('finish', release);
  return true;
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
    sendJson(response, 429, { code: 'rate_limited', error: '请求过于频繁，请稍后再试' }, {
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

function isCdkCode(value) {
  return typeof value === 'string'
    && value.trim().length >= 4
    && value.trim().length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseSessionJson(value) {
  if (typeof value !== 'string' || !value || value.length > 256 * 1024) return null;
  try {
    const session = JSON.parse(value);
    return session && typeof session === 'object' && !Array.isArray(session) ? session : null;
  } catch {
    return null;
  }
}

function validateProxyPayload(upstreamPath, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '请求体必须是 JSON 对象';

  if (['recharge/verify-cdk', 'recharge/refresh-cdk', 'recharge/cancel-task'].includes(upstreamPath)) {
    return isCdkCode(payload.cdk_code) ? null : 'cdk_code 格式或长度不正确';
  }
  if (upstreamPath === 'recharge/create-task') {
    if (!isCdkCode(payload.cdk_code)) return 'cdk_code 格式或长度不正确';
    const session = parseSessionJson(payload.session_json);
    if (!session) return 'session_json 不是有效的 JSON 对象或内容过大';
    const token = session.accessToken || session.access_token;
    if (typeof token !== 'string' || !token.trim()) return 'session_json 中缺少 accessToken';
    const sessionToken = session.sessionToken || session.session_token;
    if (typeof sessionToken !== 'string' || !sessionToken.trim()) return 'session_json 中缺少 sessionToken';
    const email = session.user?.email || session.account?.email || session.email;
    if (typeof email !== 'string' || !email.trim()) return 'session_json 中缺少账号邮箱';
    return null;
  }
  if (upstreamPath === 'recharge/check-subscription') {
    return typeof payload.token_input === 'string'
      && payload.token_input.trim().length > 0
      && payload.token_input.length <= 256 * 1024
      ? null
      : 'token_input 格式或长度不正确';
  }
  if (upstreamPath === 'lookup/tasks') {
    if (!Array.isArray(payload.codes) || payload.codes.length < 1 || payload.codes.length > 100) {
      return 'codes 数量必须为 1–100 个';
    }
    return payload.codes.every((item) => typeof item === 'string' && item.trim() && item.length <= 512)
      ? null
      : 'codes 中存在格式或长度错误的卡密';
  }
  return '不支持的代理接口';
}

function forwardUpstream(request, response, route, body) {
  const target = buildUpstreamUrl(route.upstreamPath, request.url);
  const transport = target.protocol === 'https:' ? https : http;
  const headers = {
    Accept: route.sse ? 'text/event-stream' : 'application/json',
    'User-Agent': 'Tim-AI-Recharge/2.0',
  };
  if (route.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = body.length;
  }
  if (upstreamApiKey) headers['X-API-Key'] = upstreamApiKey;

  const upstream = transport.request(target, {
    method: route.method,
    headers,
  }, (upstreamResponse) => {
    const responseHeaders = {
      ...securityHeaders,
      'Cache-Control': 'no-store',
      'Content-Type': upstreamResponse.headers['content-type'] || 'application/json; charset=utf-8',
    };
    if (route.sse) {
      responseHeaders['Cache-Control'] = 'no-cache, no-transform';
      responseHeaders.Connection = 'keep-alive';
      responseHeaders['X-Accel-Buffering'] = 'no';
    }
    if (upstreamResponse.headers['retry-after']) {
      responseHeaders['Retry-After'] = upstreamResponse.headers['retry-after'];
    }
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  response.on('close', () => {
    if (!response.writableEnded) upstream.destroy(new Error('Client disconnected'));
  });
  if (!route.sse) {
    upstream.setTimeout(route.method === 'POST' ? 25000 : 12000, () => upstream.destroy(new Error('Upstream timeout')));
  }
  upstream.on('error', () => {
    if (!response.headersSent && !response.destroyed) {
      sendJson(response, 502, { code: 'upstream_unavailable', error: '充值服务暂时不可用，请稍后重试' });
    } else if (!response.destroyed) response.destroy();
  });
  upstream.end(body);
}

function proxyApi(request, response, route, publicPath) {
  if (request.method !== route.method) {
    response.writeHead(405, { ...securityHeaders, Allow: route.method }).end('Method not allowed');
    return;
  }
  if (!enforceRateLimit(request, response, publicPath, { phase: 'raw' })) return;

  if (route.method === 'GET') {
    if (!enforceRateLimit(request, response, publicPath)) return;
    if (route.sse && !acquireSseSlot(request, response)) return;
    forwardUpstream(request, response, route, Buffer.alloc(0));
    return;
  }

  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    sendJson(response, 415, { code: 'unsupported_media_type', error: '仅支持 application/json' });
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
      sendJson(response, 413, { code: 'payload_too_large', error: '请求内容过大' });
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
      sendJson(response, 400, { code: 'invalid_json', error: '请求体不是有效的 JSON' });
      return;
    }
    const validationError = validateProxyPayload(route.upstreamPath, payload);
    if (validationError) {
      sendJson(response, 400, { code: 'invalid_request', error: validationError });
      return;
    }
    if (!enforceRateLimit(request, response, publicPath)) return;
    forwardUpstream(request, response, route, Buffer.from(JSON.stringify(payload)));
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

    if (pathname === '/healthz') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { ...securityHeaders, Allow: 'GET, HEAD' }).end('Method not allowed');
        return;
      }
      if (request.method === 'HEAD') response.writeHead(204, securityHeaders).end();
      else sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { ...securityHeaders, Allow: 'GET, HEAD' }).end('Method not allowed');
      return;
    }

    const staticFile = staticFiles.get(pathname);
    if (!staticFile) {
      response.writeHead(404, securityHeaders).end('Not found');
      return;
    }
    const filePath = path.join(root, staticFile);

    fs.stat(filePath, (statError, stats) => {
      if (statError || !stats.isFile()) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.writeHead(200, {
        ...securityHeaders,
        'Cache-Control': staticFile === 'index.html' ? 'no-cache' : 'public, max-age=300, must-revalidate',
        'Content-Type': mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      });
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(filePath).pipe(response);
    });
  });
}

function validateProductionConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production' || env.RENDER === 'true';
  if (!isProduction) return;
  const missing = [];
  if (!String(env.CDK_API_BASE_URL || '').trim()) missing.push('CDK_API_BASE_URL');
  if (!String(env.STATION_API_KEY || '').trim() && env.ALLOW_EMPTY_STATION_API_KEY !== '1') {
    missing.push('STATION_API_KEY');
  }
  if (missing.length) {
    throw new Error(`生产环境缺少必要配置：${missing.join(', ')}`);
  }
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const key of rateLimitBuckets.keys()) activeRateBucket(key, now);
}, 5 * 60 * 1000);
cleanupTimer.unref();

if (require.main === module) {
  validateProductionConfig();
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
    if (!process.env.CDK_API_BASE_URL) {
      console.log('Tim AI: 当前使用本地 API 默认地址 http://localhost:8080/api/v1');
    }
  });
}

module.exports = {
  buildUpstreamUrl,
  createUpstreamBaseUrl,
  createServer,
  enforceRateLimit,
  isCdkCode,
  resetRateLimits: () => rateLimitBuckets.clear(),
  validateProductionConfig,
  validateProxyPayload,
};
