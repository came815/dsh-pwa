import { readFile as readAsset } from 'node:fs/promises';

// No request-controlled value participates in a filesystem path.
const files = new Map([
  ['/m', { url: new URL('./web/index.html', import.meta.url), type: 'text/html; charset=utf-8', index: true }],
  ['/m/', { url: new URL('./web/index.html', import.meta.url), type: 'text/html; charset=utf-8', index: true }],
  ['/m/app.js', { url: new URL('./web/app.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/m/theme.js', { url: new URL('./theme.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/m/style.css', { url: new URL('./web/style.css', import.meta.url), type: 'text/css; charset=utf-8' }],
  ['/m/manifest.webmanifest', { url: new URL('./web/manifest.webmanifest', import.meta.url), type: 'application/manifest+json; charset=utf-8' }],
  ['/m/icon.svg', { url: new URL('./web/icon.svg', import.meta.url), type: 'image/svg+xml' }],
  ['/m/icon-180.png', { url: new URL('./web/icon-180.png', import.meta.url), type: 'image/png' }],
  ['/m/icon-512.png', { url: new URL('./web/icon-512.png', import.meta.url), type: 'image/png' }],
]);

const originalThemeBlock = `<script>
/* 主题预置：首帧前落地，避免浅色用户冷启动闪黑 */
(function(){try{var t=localStorage.getItem('dsh-pwa-theme');if(!t&&typeof matchMedia!=='undefined')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';if(t==='light')document.documentElement.classList.add('light')}catch(e){}})();
</script>`;

/** Fail closed if the pinned index's expected bootstrap changes. */
export function transformIndex(source) {
  const html = source.replaceAll('\r\n', '\n');
  if (html.split(originalThemeBlock).length !== 2) {
    throw new Error('dsh-local-pwa: unexpected upstream theme bootstrap');
  }
  const transformed = html
    .replace(originalThemeBlock, '<script src="/m/theme.js"></script>')
    .replace('<html lang="zh-CN">', '<html lang="ja">')
    .replace('<title>DSH PWA</title>', '<title>DeepSeek Harness</title>');
  if (/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i.test(transformed)) {
    throw new Error('dsh-local-pwa: unexpected inline script');
  }
  return transformed;
}

/** A CSP authority must be bare and preserve the already authenticated Host. */
function safeAuthority(req) {
  const host = req.headers?.host;
  if (typeof host !== 'string' || !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::\d{1,5})?$/.test(host)) return;
  try {
    const http = new URL(`http://${host}`);
    const https = new URL(`https://${host}`);
    const port = http.port || https.port;
    const authority = `${http.hostname}${port ? `:${port}` : ''}`;
    if (authority !== host.toLowerCase()) return;
    return authority;
  } catch {
    return;
  }
}

function securityHeaders(authority) {
  // Explicit same-authority WebSocket sources are needed by some Safari versions.
  // The authority is used only after connection.requestRejection admitted it.
  const connect = authority ? `'self' ws://${authority} wss://${authority}` : "'self'";
  return {
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      `connect-src ${connect}`,
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "worker-src 'none'",
    ].join('; '),
  };
}

function emptyResponse(res, status, headers) {
  res.writeHead(status, { ...headers, 'content-length': '0' });
  res.end();
}

/** Serve a fixed allowlist only after the runtime's existing trust/auth check. */
export function createRouteHandler(connection, { readFile = readAsset } = {}) {
  if (typeof connection?.requestRejection !== 'function') {
    throw new TypeError('dsh-local-pwa: connection.requestRejection is required');
  }
  return async function mobileRoute(req, res) {
    // This must precede routing, methods, content reads, and the health response.
    const rejection = connection.requestRejection(req);
    if (rejection !== undefined) {
      emptyResponse(res, rejection === 401 ? 401 : 403, securityHeaders());
      return;
    }
    const authority = safeAuthority(req);
    if (!authority) {
      emptyResponse(res, 403, securityHeaders());
      return;
    }
    const headers = securityHeaders(authority);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      emptyResponse(res, 405, { ...headers, allow: 'GET, HEAD' });
      return;
    }
    // Match the original target verbatim: URL normalization must not turn a
    // traversal, percent escape, absolute URL, or backslash into an allowlist hit.
    const pathname = typeof req.url === 'string' ? req.url.split('?', 1)[0] : '';
    if (pathname === '/m/health') {
      const body = Buffer.from('{"ok":true,"surface":"dsh-local-pwa"}\n');
      res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    const file = files.get(pathname);
    if (!file) {
      emptyResponse(res, 404, headers);
      return;
    }
    let body;
    try {
      const bytes = await readFile(file.url);
      body = file.index ? Buffer.from(transformIndex(bytes.toString('utf8'))) : bytes;
    } catch {
      // Do not disclose filesystem paths or upstream source on a failed read.
      emptyResponse(res, 500, headers);
      return;
    }
    res.writeHead(200, { ...headers, 'content-type': file.type, 'content-length': String(body.length) });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
