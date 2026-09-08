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
const maxUpstreamResponseBytes = 1024 * 1024;
const upstreamBaseUrl = createUpstreamBaseUrl(
  process.env.REGULAR_API_BASE_URL || process.env.CDK_API_BASE_URL || 'http://localhost:8080/api/v1',
);
const advancedUpstreamBaseUrl = createUpstreamBaseUrl(process.env.ADVANCED_API_BASE_URL || 'https://jzplus.org');
const providers = Object.freeze({
  regular: Object.freeze({
    id: 'regular',
    baseUrl: upstreamBaseUrl,
    apiKey: String(process.env.REGULAR_STATION_API_KEY || process.env.STATION_API_KEY || '').trim(),
    supportsRefresh: true,
    supportsCancel: true,
  }),
  advanced: Object.freeze({
    id: 'advanced',
    baseUrl: advancedUpstreamBaseUrl,
    apiKey: '',
    supportsRefresh: false,
    supportsCancel: false,
  }),
});
const staticFiles = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
  ['/assets/tim-letter-logo-web.png', 'assets/tim-letter-logo-web.png'],
]);

const routeDefinitions = Object.freeze([
  ['status', { method: 'GET', upstreamPath: '' }],
  ['announcement', { method: 'GET', upstreamPath: 'announcement' }],
  ['verify-cdk', { method: 'POST', upstreamPath: 'recharge/verify-cdk' }],
  ['create-task', { method: 'POST', upstreamPath: 'recharge/create-task' }],
  ['check-subscription', { method: 'POST', upstreamPath: 'recharge/check-subscription' }],
  ['queue-status', { method: 'GET', upstreamPath: 'recharge/queue-status' }],
  ['lookup/tasks', { method: 'POST', upstreamPath: 'lookup/tasks' }],
]);
const regularOnlyRouteDefinitions = Object.freeze([
  ['queue-events', { method: 'GET', upstreamPath: 'recharge/queue-events', sse: true }],
  ['refresh-cdk', { method: 'POST', upstreamPath: 'recharge/refresh-cdk' }],
  ['cancel-task', { method: 'POST', upstreamPath: 'recharge/cancel-task' }],
]);
const rateLimitByRoute = Object.freeze({
  status: { perIp: 30, global: 300, rawPerIp: 60 },
  announcement: { perIp: 30, global: 300, rawPerIp: 60 },
  'verify-cdk': { perIp: 60, global: 600, rawPerIp: 90 },
  'create-task': { perIp: 20, global: 300, rawPerIp: 40 },
  'refresh-cdk': { perIp: 12, global: 180, rawPerIp: 24 },
  'cancel-task': { perIp: 12, global: 180, rawPerIp: 24 },
  'check-subscription': { perIp: 20, global: 300, rawPerIp: 40 },
  'queue-status': { perIp: 30, global: 600, rawPerIp: 60 },
  'queue-events': { perIp: 12, global: 600, rawPerIp: 24 },
  'lookup/tasks': { perIp: 30, global: 600, rawPerIp: 60 },
});

function buildApiRoutes() {
  const routes = new Map();
  const register = (channel, prefix, definitions) => {
    definitions.forEach(([name, definition]) => {
      routes.set(`/api-proxy${prefix}/${name}`, {
        ...definition,
        channel,
        routeName: name,
      });
    });
  };
  register('regular', '/regular', [...routeDefinitions, ...regularOnlyRouteDefinitions]);
  register('advanced', '/advanced', routeDefinitions);
  // Preserve the original public paths for existing card links and integrations.
  register('regular', '', [...routeDefinitions, ...regularOnlyRouteDefinitions]);
  return routes;
}

const apiRoutes = buildApiRoutes();
const rateLimitRules = new Map([...apiRoutes.entries()].map(([publicPath, route]) => [
  publicPath,
  {
    ...rateLimitByRoute[route.routeName],
    bucketName: `${route.channel}:${route.routeName}`,
  },
]));

const rateLimitBuckets = new Map();
const rateLimitWindowMs = 60 * 1000;
const sseConnectionsByIp = new Map();
const sseConnectionLimits = { perIp: 2, global: 200 };
let activeSseConnections = 0;
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
    throw new Error('API Base URL 仅支持 http 或 https');
  }
  const configuredPath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${configuredPath && configuredPath !== '/' ? configuredPath : '/api/v1'}/`;
  url.search = '';
  url.hash = '';
  return url;
}

function buildUpstreamUrl(upstreamPath, requestUrl, baseUrl = upstreamBaseUrl) {
  const target = new URL(String(upstreamPath || '').replace(/^\/+/, ''), baseUrl);
  if (!upstreamPath) target.pathname = target.pathname.replace(/\/$/, '');
  return target;
}

function getProvider(channel) {
  return providers[channel] || providers.regular;
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
    const cloudflareRay = request.headers['cf-ray'];
    const cloudflareHeader = request.headers['cf-connecting-ip'];
    const cloudflareAddress = Array.isArray(cloudflareHeader) ? cloudflareHeader[0] : cloudflareHeader;
    if (cloudflareRay && cloudflareAddress?.trim()) {
      clientIp = cloudflareAddress.trim().slice(0, 64);
    } else {
      const forwarded = request.headers['x-forwarded-for'];
      const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const addresses = value?.split(',').map((item) => item.trim()).filter(Boolean) || [];
      const nearestAddress = addresses.at(-1);
      if (nearestAddress) clientIp = nearestAddress.slice(0, 64);
    }
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
  const bucketName = rule.bucketName || publicPath;
  const configuredBuckets = phase === 'raw'
    ? [
        { key: `raw-global:${bucketName}`, limit: Math.max(rule.rawPerIp, rule.global * 2) },
        { key: `raw-ip:${bucketName}:${clientIp}`, limit: rule.rawPerIp },
      ]
    : [
        { key: `global:${bucketName}`, limit: rule.global },
        { key: `ip:${bucketName}:${clientIp}`, limit: rule.perIp },
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

function normalizeAdvancedCdk(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

function isAdvancedCdkCode(value) {
  return typeof value === 'string' && value.length <= 128
    && /^(?:TIM|TIM5X|TIM20X)-[A-Z0-9]{11}$/.test(normalizeAdvancedCdk(value));
}

function toSupplierCdk(value) {
  if (!isAdvancedCdkCode(value)) throw new Error('进阶卡密格式不正确');
  return normalizeAdvancedCdk(value).replace(/^TIM(5X|20X)?-/, 'JZ$1-');
}

// Only documented card fields and user-facing messages are adapted.
function toPublicAdvancedPayload(value, field = '') {
  if (typeof value === 'string') {
    if (['cdk_code', 'new_code'].includes(field)) {
      return value.replace(/^JZ(5X|20X)?-([A-Z0-9]{11})$/i, (_, tier = '', suffix) => `TIM${tier.toUpperCase()}-${suffix.toUpperCase()}`);
    }
    if (['error', 'message', 'failure_reason'].includes(field)) {
      return value.replace(/\bJZ(5X|20X)?-/gi, (_, tier = '') => `TIM${tier.toUpperCase()}-`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => toPublicAdvancedPayload(item, field));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toPublicAdvancedPayload(item, key)]));
  }
  return value;
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

function validateProxyPayload(routeOrPath, payload) {
  const route = typeof routeOrPath === 'string'
    ? { upstreamPath: routeOrPath, channel: 'regular' }
    : routeOrPath;
  const upstreamPath = route?.upstreamPath;
  const acceptsCdk = route?.channel === 'advanced' ? isAdvancedCdkCode : isCdkCode;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '请求体必须是 JSON 对象';

  if (['recharge/verify-cdk', 'recharge/refresh-cdk', 'recharge/cancel-task'].includes(upstreamPath)) {
    return acceptsCdk(payload.cdk_code) ? null : 'cdk_code 格式或长度不正确';
  }
  if (upstreamPath === 'recharge/create-task') {
    if (!acceptsCdk(payload.cdk_code)) return 'cdk_code 格式或长度不正确';
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
    return payload.codes.every(acceptsCdk)
      ? null
      : 'codes 中存在格式或长度错误的卡密';
  }
  return '不支持的代理接口';
}

function buildUpstreamPayload(route, payload) {
  if (route.channel === 'advanced') {
    if (route.upstreamPath === 'recharge/check-subscription') {
      return { session: payload.token_input };
    }
    if (typeof payload.cdk_code === 'string') {
      return { ...payload, cdk_code: toSupplierCdk(payload.cdk_code) };
    }
    if (Array.isArray(payload.codes)) {
      return { ...payload, codes: payload.codes.map(toSupplierCdk) };
    }
  }
  return payload;
}

function buildUpstreamHeaders(route, body) {
  const provider = getProvider(route.channel);
  const headers = {
    Accept: route.sse ? 'text/event-stream' : 'application/json',
    'User-Agent': 'Tim-AI-Recharge/2.1',
  };
  if (route.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = body.length;
  }
  if (provider.apiKey) headers['X-API-Key'] = provider.apiKey;
  return headers;
}

function forwardUpstream(request, response, route, body) {
  const provider = getProvider(route.channel);
  const target = buildUpstreamUrl(route.upstreamPath, request.url, provider.baseUrl);
  const transport = target.protocol === 'https:' ? https : http;
  const headers = buildUpstreamHeaders(route, body);

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
    if (route.sse) {
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      upstreamResponse.pipe(response);
      return;
    }

    const declaredLength = Number(upstreamResponse.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxUpstreamResponseBytes) {
      upstreamResponse.destroy();
      sendJson(response, 502, { code: 'upstream_response_too_large', error: '充值服务返回内容异常，请稍后重试' });
      return;
    }

    const chunks = [];
    let size = 0;
    let exceeded = false;
    upstreamResponse.on('data', (chunk) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > maxUpstreamResponseBytes) {
        exceeded = true;
        upstreamResponse.destroy();
        if (!response.headersSent && !response.destroyed) {
          sendJson(response, 502, { code: 'upstream_response_too_large', error: '充值服务返回内容异常，请稍后重试' });
        }
        return;
      }
      chunks.push(chunk);
    });
    upstreamResponse.on('end', () => {
      if (exceeded || response.writableEnded || response.destroyed) return;
      let responseBody = Buffer.concat(chunks);
      if (route.channel === 'advanced') {
        try {
          responseBody = Buffer.from(JSON.stringify(toPublicAdvancedPayload(JSON.parse(responseBody.toString('utf8')))));
          responseHeaders['Content-Type'] = 'application/json; charset=utf-8';
        } catch {
          sendJson(response, 502, { code: 'upstream_invalid_response', error: '充值服务返回异常，请稍后重试' });
          return;
        }
      }
      responseHeaders['Content-Length'] = responseBody.length;
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      response.end(responseBody);
    });
    upstreamResponse.on('error', () => {
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 502, { code: 'upstream_invalid_response', error: '充值服务返回异常，请稍后重试' });
      }
    });
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
    const validationError = validateProxyPayload(route, payload);
    if (validationError) {
      sendJson(response, 400, { code: 'invalid_request', error: validationError });
      return;
    }
    if (!enforceRateLimit(request, response, publicPath)) return;
    forwardUpstream(request, response, route, Buffer.from(JSON.stringify(buildUpstreamPayload(route, payload))));
  });
}

function createServer() {
  const server = http.createServer((request, response) => {
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
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 100;
  return server;
}

function validateProductionConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production' || env.RENDER === 'true';
  if (!isProduction) return;
  const missing = [];
  if (!String(env.REGULAR_API_BASE_URL || env.CDK_API_BASE_URL || '').trim()) {
    missing.push('REGULAR_API_BASE_URL（或 CDK_API_BASE_URL）');
  }
  if (!String(env.REGULAR_STATION_API_KEY || env.STATION_API_KEY || '').trim() && env.ALLOW_EMPTY_STATION_API_KEY !== '1') {
    missing.push('REGULAR_STATION_API_KEY（或 STATION_API_KEY）');
  }
  if (missing.length) {
    throw new Error(`生产环境缺少必要配置：${missing.join(', ')}`);
  }
  const upstreams = [
    ['常规充值', env.REGULAR_API_BASE_URL || env.CDK_API_BASE_URL],
    ['进阶充值', env.ADVANCED_API_BASE_URL || 'https://jzplus.org'],
  ];
  upstreams.forEach(([label, value]) => {
    const url = createUpstreamBaseUrl(value);
    if (url.protocol !== 'https:') {
      throw new Error(`生产环境的${label} API Base URL 必须使用 HTTPS`);
    }
  });
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
    if (!process.env.CDK_API_BASE_URL && !process.env.REGULAR_API_BASE_URL) {
      console.log('Tim AI: 当前使用本地 API 默认地址 http://localhost:8080/api/v1');
    }
    if (!process.env.ADVANCED_API_BASE_URL) {
      console.log('Tim AI: 进阶充值默认连接 https://jzplus.org/api/v1');
    }
  });
}

module.exports = {
  buildApiRoutes,
  buildUpstreamHeaders,
  buildUpstreamPayload,
  buildUpstreamUrl,
  createUpstreamBaseUrl,
  createServer,
  enforceRateLimit,
  getProvider,
  isAdvancedCdkCode,
  isCdkCode,
  normalizeAdvancedCdk,
  toSupplierCdk,
  toPublicAdvancedPayload,
  resetRateLimits: () => rateLimitBuckets.clear(),
  validateProductionConfig,
  validateProxyPayload,
};
