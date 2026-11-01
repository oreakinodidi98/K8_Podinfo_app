import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createApp, readMetadata, readPort } from '../server.js';

const environment = {
  POD_NAME: 'sample-dep-abc-123',
  POD_UID: '8d87a930-2161-4c76-a6c6-a34ee8952201',
  POD_NAMESPACE: 'training',
  POD_IP: '10.244.0.7',
  POD_SERVICE_ACCOUNT: 'default',
  NODE_NAME: 'aks-nodepool1-vmss000001',
  NODE_IP: '10.240.0.5',
  CPU_REQUEST_MILLICORES: '100',
  CPU_LIMIT_MILLICORES: '500',
  MEMORY_REQUEST_BYTES: '33554432',
  MEMORY_LIMIT_BYTES: '134217728',
};

const expectedMetadata = {
  podName: 'sample-dep-abc-123',
  podUID: '8d87a930-2161-4c76-a6c6-a34ee8952201',
  namespace: 'training',
  podIP: '10.244.0.7',
  serviceAccount: 'default',
  nodeName: 'aks-nodepool1-vmss000001',
  nodeIP: '10.240.0.5',
  cpuRequestMillicores: '100',
  cpuLimitMillicores: '500',
  memoryRequestBytes: '33554432',
  memoryLimitBytes: '134217728',
};

async function listen(t, env = environment) {
  const server = createApp(env);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('readMetadata maps all pod, node and resource fields with exact units', () => {
  assert.deepEqual(readMetadata(environment), expectedMetadata);
});

test('readMetadata distinguishes missing metadata from zero resource values', () => {
  const metadata = readMetadata({
    CPU_REQUEST_MILLICORES: '0',
    MEMORY_LIMIT_BYTES: '0',
    NODE_NAME: '',
  });
  assert.deepEqual(metadata, {
    podName: null, podUID: null, namespace: null, podIP: null,
    serviceAccount: null, nodeName: null, nodeIP: null,
    cpuRequestMillicores: '0', cpuLimitMillicores: null,
    memoryRequestBytes: null, memoryLimitBytes: '0',
  });
});

test('readMetadata preserves IPv6 and large byte values without precision loss', () => {
  assert.equal(readMetadata({ NODE_IP: 'fd00::5' }).nodeIP, 'fd00::5');
  assert.equal(readMetadata({ MEMORY_LIMIT_BYTES: '9007199254740993' }).memoryLimitBytes,
    '9007199254740993');
});

test('readMetadata rejects invalid resource quantities instead of inventing values', async (t) => {
  for (const [name, value] of [
    ['negative', '-1'], ['fractional', '0.5'], ['unit-suffix', '128Mi'],
    ['whitespace', ' 100'], ['not-number', 'NaN'], ['leading-zero', '0100'],
  ]) {
    await t.test(name, () => {
      assert.throws(() => readMetadata({ CPU_REQUEST_MILLICORES: value }),
        /CPU_REQUEST_MILLICORES must be a non-negative integer/);
    });
  }
});

test('readPort accepts default, minimum, normal and maximum port', () => {
  assert.equal(readPort({}), 8080);
  assert.equal(readPort({ PORT: '1' }), 1);
  assert.equal(readPort({ PORT: '9090' }), 9090);
  assert.equal(readPort({ PORT: '65535' }), 65535);
});

test('readPort rejects empty, malformed and out-of-range ports', async (t) => {
  for (const [name, value] of [
    ['empty', ''], ['zero', '0'], ['above-maximum', '65536'],
    ['negative', '-1'], ['fractional', '8080.5'], ['suffix', '8080x'],
    ['whitespace', ' 8080'],
  ]) {
    await t.test(name, () => {
      assert.throws(() => readPort({ PORT: value }), /PORT must be an integer between 1 and 65535/);
    });
  }
});

test('GET api returns exact metadata, fresh request identity and UTC time', async (t) => {
  const base = await listen(t);
  const before = Date.now();
  const response = await fetch(`${base}/api/info`);
  const first = await response.json();
  const second = await (await fetch(`${base}/api/info`)).json();
  const after = Date.now();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const { requestID, requestTime, ...metadata } = first;
  assert.deepEqual(metadata, { ...expectedMetadata, containerPort: 8080 });
  assert.match(requestID, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(requestID, second.requestID);
  assert.match(requestTime, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.ok(Date.parse(requestTime) >= before && Date.parse(requestTime) <= after);
});

test('GET api reports missing values and never exposes unrelated environment variables', async (t) => {
  const base = await listen(t, { INTERNAL_TEST_VALUE: 'must-not-appear', PORT: '9090' });
  const response = await fetch(`${base}/api/info`);
  const body = await response.text();
  const info = JSON.parse(body);
  assert.equal(info.podName, null);
  assert.equal(info.cpuLimitMillicores, null);
  assert.equal(info.containerPort, 9090);
  assert.ok(!body.includes('must-not-appear'));
  assert.ok(!body.includes('INTERNAL_TEST_VALUE'));
  assert.equal(Object.keys(info).length, 14);
});

test('GET api preserves untrusted metadata as data rather than HTML', async (t) => {
  const value = '<img src=x onerror=alert(1)>&"\u000c';
  const base = await listen(t, { ...environment, POD_NAME: value });
  const info = await (await fetch(`${base}/api/info`)).json();
  assert.equal(info.podName, value);
  const page = await (await fetch(base)).text();
  assert.ok(!page.includes(value));
});

test('GET health returns the probe contract without metadata', async (t) => {
  const base = await listen(t, {});
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('GET serves the self-contained UI and applies browser safety headers', async (t) => {
  const base = await listen(t);
  for (const [path, type, marker] of [
    ['/', 'text/html', '<h1>Inside this Pod</h1>'],
    ['/app.js', 'text/javascript', "fetch('/api/info'"],
    ['/styles.css', 'text/css', '@media (max-width: 700px)'],
  ]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const body = await response.text();
    assert.ok(body.includes(marker), path);
    assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(body));
  }
});

test('HEAD returns headers with no response body for every public route', async (t) => {
  const base = await listen(t);
  for (const path of ['/', '/app.js', '/styles.css', '/api/info', '/healthz']) {
    const response = await fetch(`${base}${path}`, { method: 'HEAD' });
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), '', path);
    assert.ok(Number(response.headers.get('content-length')) > 0, path);
  }
});

test('Unknown routes and filesystem traversal do not expose app files', async (t) => {
  const base = await listen(t);
  for (const path of ['/missing', '/server.js', '/package.json', '/%2e%2e/server.js']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), 'Not found\n');
  }
  assert.equal((await fetch(`${base}/api/info?refresh=1`)).status, 200);
});

test('Unsupported HTTP methods return 405 with the allowed methods', async (t) => {
  const base = await listen(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await fetch(`${base}/api/info`, { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.equal(await response.text(), 'Method not allowed\n');
  }
});

test('Malformed request targets return an explicit 400 response', async (t) => {
  const base = await listen(t);
  const result = await new Promise((resolve, reject) => {
    const req = request(`${base}/`, { path: 'http://[' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.deepEqual(result, { status: 400, body: 'Invalid request URL\n' });
});

test('Invalid startup configuration exits with a visible error', () => {
  const child = spawnSync(process.execPath, ['server.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, PORT: 'invalid' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /PORT must be an integer between 1 and 65535/);
});
