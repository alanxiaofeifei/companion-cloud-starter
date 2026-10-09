import http from 'node:http';
import { createDemo } from './demo.mjs';
// Fixed synthetic identities and fixture secret; never configure a real webhook here.
const secret = 'synthetic-webhook-secret-for-testing';
const demo = createDemo({
  secret, policy: {
    tenantId: 'demo', privateUsers: ['101'], groups: {
      '-201': ['101', '102']
    }
  }
});
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200);
      res.end('synthetic demo');
      return;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) {
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(chunk);
    }
    const result = await demo.ingress({
      method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks)
    });
    try {
      const responses = result.status === 200 && result.body?.accepted ? await demo.drain() : [];
      res.writeHead(result.status, {
        'content-type': 'application/json'
      });
      res.end(JSON.stringify({
        ...result.body, responses
      }));
    }
    catch {
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(503);
        res.end('{"error":"synthetic_processing_failed"}');
      }
    }
  }
  catch {
    if (!res.destroyed && !res.writableEnded) {
      res.writeHead(400);
      res.end('{"error":"invalid_request_stream"}');
    }
  }
});
// Bind loopback only: this demo must not be exposed as a real bot.
server.listen(Number(process.env.PORT || 8081), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
