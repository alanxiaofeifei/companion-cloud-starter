import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createDemo } from './demo.mjs';
import { ingressGate } from './ingress.mjs';
export const demoSecret = 'synthetic-webhook-secret-for-testing';
export const demoPolicy = () => ({
  tenantId: 'demo', privateUsers: ['101'], groups: { '-201': ['101', '102'] }
});
/** One bounded body read; deadline includes slow/chunked streams, not just inactivity. */
function readBody(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false;
    const finish = (error, body) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('aborted', aborted);
      req.removeListener('error', failed);
      req.removeListener('close', closed);
      if (error) { req.once('error', () => {}); req.pause(); reject(error); }
      else resolve(body);
    };
    const data = chunk => {
      size += chunk.length;
      if (size > 65536) finish({ status: 413 });
      else chunks.push(chunk);
    };
    const end = () => finish(null, Buffer.concat(chunks, size));
    const aborted = () => finish({ status: 400 });
    const failed = () => finish({ status: 400 });
    const closed = () => { if (!req.complete) aborted(); };
    const timer = setTimeout(() => finish({ status: 408 }), timeoutMs);
    req.on('data', data);
    req.once('end', end);
    req.once('aborted', aborted);
    req.once('error', failed);
    req.once('close', closed);
  });
}
/** Exported for loopback tests; no listener is started on import. */
export function createDemoServer({ secret = demoSecret, policy = demoPolicy(), provider,
  timeoutMs = 5000, bodyTimeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > 60000)
    throw Error('Invalid body timeout');
  const demo = createDemo({ secret, policy, provider, timeoutMs });
  const server = http.createServer(async (req, res) => {
    const respond = (status, body = {}, close = false) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json', ...(close ? { connection: 'close' } : {}) });
      if (close) res.once('finish', () => req.destroy());
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/healthz') {
      respond(200, { mode: 'synthetic' }, true);
      return;
    }
    const rejected = ingressGate({ method: req.method, path: req.url, headers: req.headers }, secret);
    if (rejected) {
      respond(rejected.status, {}, true);
      return;
    }
    let body;
    try { body = await readBody(req, bodyTimeoutMs); }
    catch (error) { respond(error.status ?? 400, { error: 'invalid_request_stream' }, true); return; }
    try {
      const result = await demo.ingress({ method: req.method, path: req.url, headers: req.headers, body });
      const responses = result.body?.accepted ? await demo.drain() : [];
      // accepted is admission only; an empty response can mean quarantine/cancellation.
      respond(result.status, { ...result.body, responses });
    }
    catch { respond(503, { error: 'synthetic_processing_failed' }, true); }
  });
  return { server, demo };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = createDemoServer();
  server.listen(Number(process.env.PORT || 8081), '127.0.0.1');
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
