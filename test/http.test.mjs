import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createDemoServer, demoSecret } from '../src/demo-server.mjs';
const headers = { 'x-telegram-bot-api-secret-token': demoSecret };
const update = (n = 1, user = 101) => JSON.stringify({ update_id: n, message: {
  message_id: 1, chat: { id: user, type: 'private' },
  from: { id: user, is_bot: false }, text: 'Synthetic HTTP input'
}});
async function fixture(t, options = {}) {
  const d = createDemoServer(options);
  d.server.listen(0, '127.0.0.1');
  await once(d.server, 'listening');
  t.after(() => new Promise(resolve => {
    d.server.close(resolve);
    d.server.closeAllConnections();
  }));
  return { ...d, port: d.server.address().port };
}
function request(port, { method = 'POST', path = '/telegram/webhook', auth = headers,
  chunks = [update()], end = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: auth, agent: false }, res => {
      const bytes = [];
      res.on('data', chunk => bytes.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(bytes)) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    if (end) req.end();
    else req.flushHeaders();
  });
}
test('loopback HTTP uses trusted ingress and ledger; concurrent duplicates deliver once', async t => {
  const {port, demo} = await fixture(t);
  const replies = await Promise.all([request(port), request(port), request(port)]);
  assert.ok(replies.every(r => r.status === 200 && r.body.accepted));
  assert.equal(demo.outputs().length, 1);
  const changed = update().replace('Synthetic HTTP input', 'Different payload');
  assert.equal((await request(port, { chunks: [changed] })).status, 409);
  const unknown = update(2).replace('"id":101', '"id":999');
  assert.equal((await request(port, { chunks: [unknown] })).body.accepted, false);
});
test('loopback HTTP drain finishes newly admitted work in an already visited session', async t => {
  let reachedB, unblockB, reachedDrain;
  const enteredB = new Promise(resolve => { reachedB = resolve; });
  const releaseB = new Promise(resolve => { unblockB = resolve; });
  const enteredDrain = new Promise(resolve => { reachedDrain = resolve; });
  const calls = [];
  const {port, demo} = await fixture(t, {
    policy: {tenantId: 'demo', privateUsers: ['101', '102'], groups: {}},
    provider: {
      async runTurn(turn, {memoryMarkdown}) {
        calls.push(turn.turnId);
        if (turn.principal.userId === '102') { reachedB(); await releaseB; }
        return {text: 'Synthetic HTTP reply', memoryMarkdown};
      }
    }
  });
  const ingress = n => demo.ingress({method: 'POST', path: '/telegram/webhook',
    headers, body: Buffer.from(update(n, n === 2 ? 102 : 101))});
  await ingress(1);
  await ingress(2);
  const first = demo.drain();
  let third;
  try {
    await enteredB;
    assert.equal(demo.outputs().length, 1);
    const drain = demo.drain.bind(demo);
    // Signal after the HTTP handler has admitted A2 and obtained its drain Promise.
    demo.drain = () => { const pending = drain(); reachedDrain(); return pending; };
    third = request(port, {chunks: [update(3)]});
    await enteredDrain;
  } finally { unblockB(); }
  const [output, response] = await Promise.all([first, third]);
  assert.equal(response.status, 200);
  assert.equal(response.body.accepted, true);
  assert.equal(output.length, 3);
  assert.equal(response.body.responses.length, 3);
  const state = await demo.store.export(demo.outputs()[0].sessionKey);
  assert.deepEqual(state.order.map(id => state.turns[id].status), ['SENT', 'SENT']);
  await request(port, {chunks: [update(3)]});
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls).size, 3);
  assert.equal(new Set(demo.outputs().map(output => output.turnId)).size, 3);
});
test('method/path/secret gates respond without waiting for body, even misleading large lengths', async t => {
  const {port} = await fixture(t);
  for (const opts of [
    {method: 'PUT', expected: 404}, {path: '/other', expected: 404}, {auth: {}, expected: 401}
  ]) {
    const auth = {...(opts.auth ?? headers), 'content-length': '999999'};
    const r = await request(port, {...opts, auth, chunks: [], end: false});
    assert.equal(r.status, opts.expected);
  }
});
test('streamed 64 KiB boundary, invalid JSON and chunked overflow', async t => {
  const {port, demo} = await fixture(t);
  const body = update();
  const atLimit = body + ' '.repeat(65536 - Buffer.byteLength(body));
  assert.equal((await request(port, {chunks: [atLimit.slice(0, 30000), atLimit.slice(30000)]})).status, 200);
  assert.equal((await request(port, {chunks: ['{ broken json']})).status, 400);
  assert.equal((await request(port, {chunks: [' '.repeat(32768), ' '.repeat(32768), 'x']})).status, 413);
  assert.equal(demo.outputs().length, 1);
  assert.equal((await request(port, {chunks: [update(2)]})).status, 200);
});
test('partial body timeout and client abort settle safely; subsequent requests work', async t => {
  const {port, demo} = await fixture(t, {bodyTimeoutMs: 30});
  assert.equal((await request(port, {chunks: ['{'], end: false})).status, 408);
  const req = http.request({host: '127.0.0.1', port, method: 'POST', path: '/telegram/webhook', headers});
  req.on('error', () => {});
  req.write('{');
  await once(req, 'socket');
  // The server receives a partial request then the peer closes the stream.
  await new Promise(resolve => setTimeout(resolve, 10));
  const closed = new Promise(resolve => req.once('close', resolve));
  req.destroy();
  await closed;
  assert.equal((await request(port)).status, 200);
  assert.equal(demo.outputs().length, 1);
});
test('HTTP provider timeout admits but does not deliver or rerun quarantined work', async t => {
  let calls = 0;
  const {port, demo} = await fixture(t, {timeoutMs: 5, provider: {
    runTurn() { calls++; return new Promise(() => {}); }
  }});
  assert.equal((await request(port)).body.accepted, true);
  await request(port, {chunks: [update(2)]});
  assert.equal(calls, 1);
  assert.deepEqual(demo.outputs(), []);
});

test('default smoke entrypoint stays health-only and rejects operational work', async () => {
  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const child = spawn(process.execPath, [new URL('../src/server.mjs', import.meta.url).pathname], {
    env: {PORT: String(port)}, stdio: 'ignore'
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    let health;
    for (let n = 0; n < 50; n++) {
      try { health = await request(port, {method: 'GET', path: '/healthz', chunks: []}); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.equal(health?.status, 200);
    assert.equal(health.body.mode, 'scaffold');
    const result = await request(port);
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'production_wiring_not_implemented');
  } finally { child.kill('SIGTERM'); await exited; }
});
