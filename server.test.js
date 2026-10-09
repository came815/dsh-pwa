import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { apply } from './index.js';
import { createRouteHandler, transformIndex } from './server.js';

const assetPaths = [
  '/m', '/m/', '/m/app.js', '/m/theme.js', '/m/style.css',
  '/m/manifest.webmanifest', '/m/icon.svg', '/m/icon-180.png',
  '/m/icon-512.png', '/m/health',
];
const indexBytes = await readFile(new URL('./web/index.html', import.meta.url));
const admitted = { requestRejection: () => undefined };

function response() {
  return {
    status: undefined,
    headers: {},
    body: Buffer.alloc(0),
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
      this.ended = true;
    },
  };
}

async function request(handler, url = '/m', method = 'GET', headers = {}) {
  const res = response();
  await handler({ url, method, headers: { host: '127.0.0.1:3080', ...headers } }, res);
  assert.equal(res.ended, true);
  return res;
}

function assertHeaders(res, authority) {
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  const policies = Object.fromEntries(res.headers['content-security-policy'].split('; ').map((entry) => {
    const [name, ...values] = entry.split(' ');
    return [name, values.join(' ')];
  }));
  assert.equal(policies['default-src'], "'none'");
  assert.equal(policies['script-src'], "'self'");
  assert.equal(policies['style-src'], "'self' 'unsafe-inline'");
  assert.equal(policies['img-src'], "'self' data: blob:");
  assert.equal(policies['connect-src'], authority ? `'self' ws://${authority} wss://${authority}` : "'self'");
  for (const name of ['object-src', 'base-uri', 'form-action', 'frame-src', 'frame-ancestors', 'worker-src']) {
    assert.equal(policies[name], "'none'");
  }
  assert.doesNotMatch(res.headers['content-security-policy'], /\*|https?:|unsafe-eval/);
}

test('all mobile assets and health require auth before any file read', async () => {
  for (const rejection of [401, 403]) {
    let checks = 0;
    const handler = createRouteHandler({ requestRejection() { checks++; return rejection; } }, {
      readFile: () => { assert.fail('denied requests must never read a file'); },
    });
    for (const path of [...assetPaths, '/m/unknown', '/m/../app.js']) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        const res = await request(handler, path, method);
        assert.equal(res.status, rejection);
        assert.equal(res.body.length, 0);
        assertHeaders(res);
      }
    }
    assert.equal(checks, (assetPaths.length + 2) * 3);
  }
});

test('every fixed asset is readable with its expected media type', async () => {
  const handler = createRouteHandler(admitted);
  for (const path of assetPaths) {
    const res = await request(handler, `${path}?v=local`);
    assert.equal(res.status, 200, path);
    assert.ok(res.body.length > 0, path);
    assert.equal(Number(res.headers['content-length']), res.body.length, path);
    assertHeaders(res, '127.0.0.1:3080');
  }
  assert.match((await request(handler, '/m/app.js')).headers['content-type'], /^text\/javascript/);
  assert.equal((await request(handler, '/m/icon-180.png')).headers['content-type'], 'image/png');
  assert.match((await request(handler, '/m/manifest.webmanifest')).headers['content-type'], /^application\/manifest\+json/);
});

test('HEAD has GET headers and no body on each mapped route', async () => {
  const handler = createRouteHandler(admitted);
  for (const path of assetPaths) {
    const get = await request(handler, path);
    const head = await request(handler, path, 'HEAD');
    assert.equal(head.status, 200, path);
    assert.deepEqual(head.headers, get.headers, path);
    assert.equal(head.body.length, 0, path);
  }
});

test('methods other than GET and HEAD return 405 without reads', async () => {
  const handler = createRouteHandler(admitted, {
    readFile: () => { assert.fail('unsupported methods must not read'); },
  });
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'TRACE', 'PATCH', undefined]) {
    for (const path of assetPaths) {
      const res = response();
      await handler({ method, url: path, headers: { host: '127.0.0.1:3080' } }, res);
      assert.equal(res.status, 405);
      assert.equal(res.headers.allow, 'GET, HEAD');
      assert.equal(res.body.length, 0);
      assertHeaders(res, '127.0.0.1:3080');
    }
  }
});

test('unknown, traversal, encoded, and absolute targets never become file paths', async () => {
  let reads = 0;
  const handler = createRouteHandler(admitted, { readFile() { reads++; return Buffer.from('unexpected'); } });
  const targets = [
    '/m/sw.js', '/m/service-worker.js', '/m/prototype-harness.html', '/m/client.js',
    '/m/package.json', '/m/LICENSE', '/m/README.md', '/m/upstream.json',
    '/m/lib/index.js', '/m/web/app.js', '/m/index.html', '/m/health/',
    '/m/../app.js', '/m/a/../app.js', '/m/%2e%2e/app.js', '/m/%61pp.js',
    '/m/%2fapp.js', '/m/%5capp.js', '/m//app.js', '/m\\app.js',
    '/m/app.js/', '/m/app.js#fragment', '/m/app.js\0', '/m-app.js', '/api',
    'http://127.0.0.1:3080/m/app.js', '//127.0.0.1:3080/m/app.js', '', undefined,
  ];
  for (const target of targets) {
    const res = response();
    await handler({ method: 'GET', url: target, headers: { host: '127.0.0.1:3080' } }, res);
    assert.equal(res.status, 404, String(target));
    assert.equal(res.body.length, 0);
    assertHeaders(res, '127.0.0.1:3080');
  }
  assert.equal(reads, 0);
});

test('request values do not influence fixed filesystem URLs', async () => {
  const reads = [];
  const handler = createRouteHandler(admitted, {
    readFile(url) { reads.push(url.href); return url.pathname.endsWith('/index.html') ? indexBytes : Buffer.from('asset'); },
  });
  await request(handler, '/m/app.js?file=C:\\secret&path=../../LICENSE&token=must-not-be-used');
  await request(handler, '/m/app.js?v=2');
  assert.equal(reads.length, 2);
  assert.equal(reads[0], reads[1]);
  assert.ok(reads[0].endsWith('/web/app.js'));
  assert.doesNotMatch(reads[0], /secret|token|LICENSE/);
});

test('index exposes Japanese language/title and only external scripts', async () => {
  const res = await request(createRouteHandler(admitted));
  const html = res.body.toString('utf8');
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /<title>DeepSeek Harness<\/title>/);
  assert.match(html, /<script src="\/m\/theme\.js"><\/script>/);
  assert.match(html, /<script src="\/m\/app\.js\?v=/);
  assert.doesNotMatch(html, /<script\s*>|localStorage|getItem/);
  const theme = (await request(createRouteHandler(admitted), '/m/theme.js')).body.toString('utf8');
  assert.match(theme, /localStorage\.getItem\('dsh-pwa-theme'\)/);
  assert.doesNotMatch(theme, /setItem|cookie|token|fetch|WebSocket/);
});

test('unexpected bootstrap or added inline JavaScript fails closed', async () => {
  assert.throws(() => transformIndex('<script>unexpected()</script>'), /unexpected upstream/);
  assert.throws(() => transformIndex(`${indexBytes}\n<script>alert(1)</script>`), /unexpected inline/);
  const handler = createRouteHandler(admitted, { readFile: async () => Buffer.from('wrong index with sensitive source') });
  const res = await request(handler);
  assert.equal(res.status, 500);
  assert.equal(res.body.length, 0);
  assertHeaders(res, '127.0.0.1:3080');
});

test('file read failure has no path or error disclosure and is not cached', async () => {
  const handler = createRouteHandler(admitted, { readFile() { throw new Error('C:\\private\\secret'); } });
  const res = await request(handler, '/m/app.js');
  assert.equal(res.status, 500);
  assert.equal(res.body.length, 0);
  assertHeaders(res, '127.0.0.1:3080');
});

test('health is authenticated, contains no runtime/session details, and reads no files', async () => {
  const handler = createRouteHandler(admitted, { readFile() { assert.fail('health must not read files'); } });
  const res = await request(handler, '/m/health');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, surface: 'dsh-local-pwa' });
  assertHeaders(res, '127.0.0.1:3080');
});

test('CSP WebSocket allowances use only the admitted bare Host authority', async () => {
  const handler = createRouteHandler(admitted);
  for (const host of ['localhost:3080', '192.0.2.10:3080', 'host.example.test', '[::1]:3080', 'LOCALHOST:3080', 'localhost:80', 'localhost:443']) {
    const res = await request(handler, '/m/health', 'GET', { host });
    assert.equal(res.status, 200, host);
    assertHeaders(res, host.toLowerCase());
  }
});

test('malformed Host cannot inject CSP even if a stub admits it', async () => {
  const handler = createRouteHandler(admitted, { readFile() { assert.fail('malformed Host must not read'); } });
  for (const host of [undefined, ['localhost'], 'localhost; connect-src *', 'localhost/path', 'user@localhost', ' localhost', 'localhost:', 'localhost:99999', '0x7f000001:3080', 'localhost:03080', 'localhost\r\nx-header: attack']) {
    const res = await request(handler, '/m', 'GET', { host });
    assert.equal(res.status, 403, String(host));
    assert.equal(res.body.length, 0);
    assertHeaders(res);
  }
});

test('registration is scoped to injected services and disposal removes only /m', () => {
  const routes = new Map([['/api', { existing: true }]]);
  const disposers = [];
  const scope = {
    connection: admitted,
    webServer: {
      register(route) {
        assert.equal(route.kind, 'prefix');
        assert.equal(route.path, '/m');
        assert.equal(routes.has(route.path), false);
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    effect(factory, description) {
      assert.equal(description, 'dsh-local-pwa: /m route');
      const dispose = factory();
      disposers.push(dispose);
      return dispose;
    },
  };
  const ctx = { inject(names, callback) { assert.deepEqual(names, ['webServer', 'connection']); callback(scope); } };
  apply(ctx);
  assert.deepEqual([...routes.keys()], ['/api', '/m']);
  assert.equal(disposers.length, 1);
  disposers[0]();
  assert.deepEqual([...routes.keys()], ['/api']);
});

test('missing connection service fails closed at registration', () => {
  assert.throws(() => createRouteHandler({}), /requestRejection is required/);
});

test('package has no dependencies, client extension, or lifecycle execution', async () => {
  const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.main, 'index.js');
  assert.equal(pkg.exports, './index.js');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.dsh, undefined);
  assert.deepEqual(Object.keys(pkg.scripts), ['test']);
  assert.ok(pkg.files.includes('web/app.js'));
  assert.ok(pkg.files.includes('LICENSE'));
  for (const file of pkg.files) {
    assert.doesNotMatch(file, /^(?:lib|client|vendor)\//);
    assert.doesNotMatch(file, /prototype-harness\.html$/);
    await access(new URL(file, import.meta.url));
  }
});

async function chatLinkHarness({ openResult = null, openError } = {}) {
  const source = await readFile(new URL('./web/app.js', import.meta.url), 'utf8');
  const startMarker = "$('#chat-scroll').addEventListener('click', (e) => {";
  const endMarker = "    const cp = e.target.closest && e.target.closest('.code-copy')";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'the real chat link branch must be present');
  assert.equal(source.indexOf(startMarker, start + 1), -1, 'the extracted handler must be unique');
  const linkBranch = source.slice(start + startMarker.length, end);
  const opened = [];
  const copied = [];
  const notices = [];
  let prevented = 0;
  // Execute only the actual link branch, with inert browser dependencies. The
  // rest of the app (network, sessions, storage, startup) is never evaluated.
  const click = runInNewContext(`(e) => {${linkBranch}\n}`, {
    URL,
    location: { href: 'https://harness.example.test/m/' },
    window: {
      open(...args) {
        opened.push(args);
        if (openError) throw openError;
        return openResult;
      },
    },
    vibrate() {},
    copyText(text, done) { copied.push(text); done(true); },
    toast(text) { notices.push(text); },
  }, { timeout: 1000, filename: 'vendored-chat-link-handler.js' });
  return {
    opened, copied, notices,
    get prevented() { return prevented; },
    click(href) {
      click({
        target: { closest(selector) { return selector === 'a[href]' ? { href } : null; } },
        preventDefault() { prevented++; },
      });
    },
  };
}

test('real chat link handler opens HTTP(S) with noopener,noreferrer and clears opener', async () => {
  for (const [href, expected] of [
    ['http://example.test/path', 'http://example.test/path'],
    ['https://example.test/path?q=1#fragment', 'https://example.test/path?q=1#fragment'],
    ['HTTPS://EXAMPLE.TEST/path', 'https://example.test/path'],
    ['/safe-local-path', 'https://harness.example.test/safe-local-path'],
  ]) {
    const popup = { opener: { authenticatedWindow: true } };
    const harness = await chatLinkHarness({ openResult: popup });
    harness.click(href);
    assert.deepEqual(harness.opened, [[expected, '_blank', 'noopener,noreferrer']]);
    assert.equal(popup.opener, null, href);
    assert.equal(harness.prevented, 1);
    assert.deepEqual(harness.copied, []);
    assert.deepEqual(harness.notices, []);
  }
});

test('real chat link handler prevents non-HTTP(S) navigation without open or copy', async () => {
  for (const href of [
    'javascript:alert(document.cookie)', 'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'blob:https://example.test/id',
    'file:///C:/private.txt', 'ftp://example.test/private',
    'mailto:someone@example.test', 'tel:123456', 'about:blank',
  ]) {
    const harness = await chatLinkHarness();
    harness.click(href);
    assert.equal(harness.prevented, 1, href);
    assert.deepEqual(harness.opened, [], href);
    assert.deepEqual(harness.copied, [], href);
    assert.deepEqual(harness.notices, [], href);
  }
});

test('real chat link handler treats a null open result as success without duplicate open or copy', async () => {
  const harness = await chatLinkHarness({ openResult: null });
  harness.click('https://example.test/open-once');
  assert.deepEqual(harness.opened, [['https://example.test/open-once', '_blank', 'noopener,noreferrer']]);
  assert.equal(harness.prevented, 1);
  assert.deepEqual(harness.copied, []);
  assert.deepEqual(harness.notices, []);
});

test('real chat link handler copies once only when window.open throws', async () => {
  const harness = await chatLinkHarness({ openError: new Error('popup failure') });
  harness.click('https://example.test/fallback');
  assert.deepEqual(harness.opened, [['https://example.test/fallback', '_blank', 'noopener,noreferrer']]);
  assert.deepEqual(harness.copied, ['https://example.test/fallback']);
  assert.deepEqual(harness.notices, ['リンクをコピーしました。ブラウザーで開いてください。']);
});

test('installed runtime Host/Origin fence and auth delegation govern mobile routes', async (t) => {
  // Import the installed library only. No upstream app/client script, server,
  // credential provider, GPU worker, or Connection constructor is executed.
  const packageRoot = process.env.DSH_RUNTIME_PACKAGE_ROOT;
  if (!packageRoot) {
    // The wrapper has no runtime dependency: its contract is also covered by
    // the stubbed route tests. This additional check uses a caller's installed
    // Connection package and must never guess a private workstation path.
    t.skip('optional installed-runtime check; set DSH_RUNTIME_PACKAGE_ROOT to the Connection package root');
    return;
  }
  const moduleUrl = pathToFileURL(resolve(packageRoot, 'lib/index.js'));
  await access(moduleUrl);
  const { HostConnectionService } = await import(moduleUrl.href);
  let authChecks = 0;
  const connection = Object.create(HostConnectionService.prototype);
  connection.trustedHosts = ['host.example.test'];
  connection.browserAuth = {
    isAuthenticated(req) { authChecks++; return req.headers.cookie === 'test-session=valid'; },
  };
  const handler = createRouteHandler(connection);
  for (const path of assetPaths) {
    assert.equal((await request(handler, path)).status, 401, path);
    assert.equal((await request(handler, path, 'GET', { cookie: 'test-session=valid' })).status, 200, path);
    for (const headers of [
      { origin: 'https://foreign.example' },
      { 'sec-fetch-site': 'cross-site' },
      { host: 'foreign.example' },
      { origin: 'http://127.0.0.1:9999' },
    ]) {
      const before = authChecks;
      const res = await request(handler, path, 'GET', { cookie: 'test-session=valid', ...headers });
      assert.equal(res.status, 403, path);
      assert.equal(res.body.length, 0);
      assert.equal(authChecks, before, 'the runtime trust fence must reject before cookie auth');
      assertHeaders(res);
    }
  }
  const sameOrigin = await request(handler, '/m/health', 'GET', {
    host: 'host.example.test', origin: 'https://host.example.test', cookie: 'test-session=valid',
  });
  assert.equal(sameOrigin.status, 200);
  assertHeaders(sameOrigin, 'host.example.test');
  assert.equal((await request(handler, '/m/health?token=unused')).status, 401, 'query token is never accepted by mobile routes');
});

test('installed WebServer matches only the /m namespace and disposal preserves other routes', async (t) => {
  const packageRoot = process.env.DSH_RUNTIME_PACKAGE_ROOT;
  if (!packageRoot) {
    t.skip('optional installed-runtime routing check; set DSH_RUNTIME_PACKAGE_ROOT to the Connection package root');
    return;
  }
  const runtimeRequire = createRequire(resolve(packageRoot, 'package.json'));
  const moduleUrl = pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-host-webserver'));
  const { WebServer } = await import(moduleUrl.href);
  // Exercise the installed register/match/disposal methods without constructing
  // the service or starting its HTTP listener.
  const server = Object.create(WebServer.prototype);
  server.exact = new Map();
  server.prefixes = new Map();
  for (const path of ['/models', '/mcp', '/api']) {
    server.register({ kind: 'prefix', path, handler() {} });
  }
  const outsidePaths = [
    '/models', '/models/list', '/mcp', '/mcp/tools', '/api', '/api/session',
    '/metrics', '/mobile', '/m-app.js', '/my-plugin', '/M',
  ];
  const originalMatches = outsidePaths.map((path) => server.match(path));
  const disposers = [];
  const scope = {
    webServer: server,
    connection: admitted,
    effect(factory) { disposers.push(factory()); },
  };
  apply({ inject(names, callback) { assert.deepEqual(names, ['webServer', 'connection']); callback(scope); } });
  const mobile = server.match('/m');
  assert.equal(mobile.path, '/m');
  assert.equal(mobile.kind, 'prefix');
  for (const path of [...assetPaths, '/m/unknown']) {
    assert.equal(server.match(path), mobile, path);
  }
  for (let index = 0; index < outsidePaths.length; index++) {
    assert.equal(server.match(outsidePaths[index]), originalMatches[index], outsidePaths[index]);
  }
  assert.equal((await request(mobile.handler, '/m/unknown')).status, 404);
  assert.equal(disposers.length, 1);
  disposers[0]();
  for (const path of assetPaths) {
    assert.equal(server.match(path), undefined, `disposed ${path}`);
  }
  for (let index = 0; index < outsidePaths.length; index++) {
    assert.equal(server.match(outsidePaths[index]), originalMatches[index], `preserved ${outsidePaths[index]}`);
  }
});
