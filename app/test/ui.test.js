import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const info = {
  podName: 'sample-123',
  podUID: 'uid-123',
  namespace: 'default',
  podIP: '10.244.0.7',
  serviceAccount: 'default',
  nodeName: 'node-1',
  nodeIP: '10.240.0.5',
  cpuRequestMillicores: '100',
  cpuLimitMillicores: '500',
  memoryRequestBytes: '33554432',
  memoryLimitBytes: '134217728',
  containerPort: 8080,
  requestTime: '2026-10-19T12:00:00.000Z',
  requestID: 'request-123',
};

function startUI(fetch) {
  const elements = [...html.matchAll(/data-field="([^"]+)"(?: data-unit="([^"]+)")?/g)]
    .map((match) => ({
      dataset: { field: match[1], unit: match[2] },
      textContent: 'Loading...',
      set innerHTML(_) { throw new Error('Metadata must not be inserted as HTML'); },
    }));
  const callbacks = {};
  const refresh = { disabled: false, addEventListener: (name, fn) => { callbacks[name] = fn; } };
  const auto = { checked: true };
  const status = { dataset: {}, textContent: '' };
  const errors = [];
  let interval;
  let milliseconds;
  runInNewContext(source, {
    document: {
      querySelectorAll: () => elements,
      getElementById: (id) => ({ status, refresh, 'auto-refresh': auto })[id],
    },
    fetch,
    AbortSignal,
    setInterval: (fn, delay) => { interval = fn; milliseconds = delay; },
    console: { error: (...args) => errors.push(args) },
  });
  return { elements, callbacks, refresh, auto, status, errors, tick: () => interval(), milliseconds };
}

function success(data = info) {
  return Promise.resolve({ ok: true, json: async () => data });
}

test('UI renders every identity, request and resource field with the correct units', async () => {
  const ui = startUI(() => success());
  await setImmediate();
  const rendered = Object.fromEntries(ui.elements.map((element) =>
    [element.dataset.field, element.textContent]));
  assert.deepEqual(rendered, {
    nodeIP: '10.240.0.5', nodeName: 'node-1', podIP: '10.244.0.7',
    podName: 'sample-123', podUID: 'uid-123', namespace: 'default',
    serviceAccount: 'default', containerPort: '8080',
    cpuRequestMillicores: '100 mCPU', cpuLimitMillicores: '500 mCPU',
    memoryRequestBytes: '33554432 bytes', memoryLimitBytes: '134217728 bytes',
    requestTime: '2026-10-19T12:00:00.000Z', requestID: 'request-123',
  });
  assert.equal(ui.status.dataset.state, 'ready');
  assert.equal(ui.refresh.disabled, false);
});

test('UI preserves untrusted text literally and never inserts metadata as HTML', async () => {
  const value = '<img src=x onerror=alert(1)>&"\u000c';
  const ui = startUI(() => success({ ...info, podName: value }));
  await setImmediate();
  const names = ui.elements.filter((element) => element.dataset.field === 'podName');
  assert.equal(names.length, 2);
  assert.ok(names.every((element) => element.textContent === value));
  assert.equal(ui.errors.length, 0);
});

test('UI explicitly shows absent metadata while preserving zero resource values', async () => {
  const ui = startUI(() => success({
    ...info, nodeName: null, podName: '', cpuRequestMillicores: '0', memoryLimitBytes: null,
  }));
  await setImmediate();
  assert.equal(ui.status.dataset.state, 'missing');
  assert.match(ui.status.textContent, /Downward API manifest/);
  assert.equal(ui.elements.find((el) => el.dataset.field === 'podName').textContent, 'Not supplied');
  assert.equal(ui.elements.find((el) => el.dataset.field === 'memoryLimitBytes').textContent, 'Not supplied');
  assert.equal(ui.elements.find((el) => el.dataset.field === 'cpuRequestMillicores').textContent, '0 mCPU');
});

test('UI warns when either Pod or node identity is missing', async (t) => {
  for (const field of ['podName', 'nodeName']) {
    await t.test(field, async () => {
      const ui = startUI(() => success({ ...info, [field]: null }));
      await setImmediate();
      assert.equal(ui.status.dataset.state, 'missing');
      assert.match(ui.status.textContent, /Downward API manifest/);
      assert.equal(ui.elements.find((el) => el.dataset.field === field).textContent, 'Not supplied');
    });
  }
});

test('UI refreshes manually and periodically and honors the automatic refresh toggle', async () => {
  let calls = 0;
  const ui = startUI(() => { calls++; return success({ ...info, requestID: `request-${calls}` }); });
  await setImmediate();
  assert.equal(calls, 1);
  assert.equal(ui.milliseconds, 5000);
  ui.tick();
  await setImmediate();
  assert.equal(calls, 2);
  ui.auto.checked = false;
  ui.tick();
  await setImmediate();
  assert.equal(calls, 2);
  await ui.callbacks.click();
  assert.equal(calls, 3);
  assert.equal(ui.elements.find((el) => el.dataset.field === 'requestID').textContent, 'request-3');
});

test('UI prevents overlapping requests and restores the refresh button afterward', async () => {
  let complete;
  let calls = 0;
  const ui = startUI(() => { calls++; return new Promise((resolve) => { complete = resolve; }); });
  assert.equal(ui.refresh.disabled, true);
  await ui.callbacks.click();
  ui.tick();
  assert.equal(calls, 1);
  complete(await success());
  await setImmediate();
  assert.equal(ui.refresh.disabled, false);
  assert.equal(ui.status.dataset.state, 'ready');
});

test('UI surfaces HTTP, network, timeout and malformed response failures and recovers', async (t) => {
  const cases = [
    ['http-error', () => Promise.resolve({ ok: false, status: 503 }), 'HTTP 503'],
    ['network-error', () => Promise.reject(new Error('Network unavailable')), 'Network unavailable'],
    ['timeout', () => Promise.reject(new Error('Request timed out')), 'Request timed out'],
    ['bad-json', () => Promise.resolve({ ok: true, json: async () => { throw new Error('Invalid JSON'); } }), 'Invalid JSON'],
    ['null-response', () => success(null), 'Invalid server response'],
    ['wrong-shape', () => success({ podName: 'misleading' }), 'Invalid server response'],
  ];
  for (const [name, failure, expected] of cases) {
    await t.test(name, async () => {
      let fail = false;
      const ui = startUI(() => fail ? failure() : success());
      await setImmediate();
      assert.equal(ui.status.dataset.state, 'ready');
      assert.equal(ui.elements.find((el) => el.dataset.field === 'podName').textContent, 'sample-123');
      fail = true;
      await ui.callbacks.click();
      assert.equal(ui.status.dataset.state, 'error');
      assert.ok(ui.status.textContent.includes(expected));
      assert.ok(ui.elements.every((element) => element.textContent === 'Unavailable'));
      assert.equal(ui.refresh.disabled, false);
      assert.equal(ui.errors.length, 1);
      fail = false;
      await ui.callbacks.click();
      assert.equal(ui.status.dataset.state, 'ready');
      assert.equal(ui.elements.find((el) => el.dataset.field === 'podName').textContent, 'sample-123');
    });
  }
});

test('UI fetches only the metadata endpoint with no caching and a timeout signal', async () => {
  let options;
  let path;
  startUI((url, init) => { path = url; options = init; return success(); });
  await setImmediate();
  assert.equal(path, '/api/info');
  assert.equal(options.cache, 'no-store');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
});
