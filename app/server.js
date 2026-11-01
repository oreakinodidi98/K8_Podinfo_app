import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHTTPServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
].map(([route, [file, type]]) => [
  route,
  { body: readFileSync(new URL(`./public/${file}`, import.meta.url)), type },
]));

const identityFields = {
  podName: 'POD_NAME',
  podUID: 'POD_UID',
  namespace: 'POD_NAMESPACE',
  podIP: 'POD_IP',
  serviceAccount: 'POD_SERVICE_ACCOUNT',
  nodeName: 'NODE_NAME',
  nodeIP: 'NODE_IP',
};

const resourceFields = {
  cpuRequestMillicores: 'CPU_REQUEST_MILLICORES',
  cpuLimitMillicores: 'CPU_LIMIT_MILLICORES',
  memoryRequestBytes: 'MEMORY_REQUEST_BYTES',
  memoryLimitBytes: 'MEMORY_LIMIT_BYTES',
};

export function readMetadata(env) {
  const metadata = {};
  for (const [field, variable] of Object.entries(identityFields)) {
    metadata[field] = env[variable] || null;
  }
  for (const [field, variable] of Object.entries(resourceFields)) {
    const value = env[variable];
    if (value !== undefined && value !== '' && !/^(0|[1-9]\d*)$/.test(value)) {
      throw new Error(`${variable} must be a non-negative integer in the documented unit.`);
    }
    metadata[field] = value === undefined || value === '' ? null : value;
  }
  return Object.freeze(metadata);
}

export function readPort(env) {
  const value = env.PORT ?? '8080';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return Number(value);
}

export function createApp(env = process.env) {
  const metadata = readMetadata(env);
  const port = readPort(env);
  return createHTTPServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");

    const send = (status, type, body) => {
      response.writeHead(status, {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(body),
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      send(405, 'text/plain; charset=utf-8', 'Method not allowed\n');
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      send(400, 'text/plain; charset=utf-8', 'Invalid request URL\n');
      return;
    }

    if (pathname === '/healthz') {
      send(200, 'application/json; charset=utf-8', '{"status":"ok"}\n');
    } else if (pathname === '/api/info') {
      send(200, 'application/json; charset=utf-8', JSON.stringify({
        ...metadata,
        containerPort: port,
        requestID: randomUUID(),
        requestTime: new Date().toISOString(),
      }));
    } else if (assets.has(pathname)) {
      const asset = assets.get(pathname);
      send(200, asset.type, asset.body);
    } else {
      send(404, 'text/plain; charset=utf-8', 'Not found\n');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp();
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('error', (error) => {
    console.error('HTTP server failed:', error);
    process.exitCode = 1;
  });
  server.listen(readPort(process.env), '0.0.0.0', () => {
    console.log(`Pod information app listening on port ${readPort(process.env)}`);
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('Shutting down HTTP server');
    const deadline = setTimeout(() => {
      console.error('HTTP shutdown exceeded 10 seconds; closing remaining connections');
      server.closeAllConnections();
      process.exitCode = 1;
    }, 10000);
    deadline.unref();
    server.close((error) => {
      clearTimeout(deadline);
      if (error) {
        console.error('HTTP shutdown failed:', error);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
