import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemo } from '../src/demo.mjs';
import { route } from '../src/ingress.mjs';
const secret = 'synthetic-webhook-secret-for-testing';
const policy = () => ({
  tenantId: 'demo', privateUsers: ['101'], groups: {
    '-201': ['101']
  }
});
const req = (id = 1, user = 101) => ({
  method: 'POST', path: '/telegram/webhook', headers: {
    'x-telegram-bot-api-secret-token': secret
  }, body: Buffer.from(JSON.stringify({
    update_id: id, message: {
      message_id: 1, chat: {
        id: user, type: 'private'
      }, from: {
        id: user, is_bot: false
      }, text: 'Hello from a synthetic user'
    }
  }))
});
function latch() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function statuses(d, p, request) {
  const state = await d.store.export(route(JSON.parse(request.body), p).sessionKey);
  return state.order.map(id => state.turns[id].status);
}
test('synthetic end-to-end admission, queue, worker, provider, response', async () => {
  const d = createDemo({
    secret, policy: policy()
  });
  assert.equal((await d.ingress(req())).status, 200);
  const output = await d.drain();
  assert.equal(output.length, 1);
  assert.equal(output[0].text, 'Synthetic reply: Hello from a synthetic user');
  await d.ingress(req());
  await d.drain();
  assert.equal(d.outputs().length, 1);
});
test('queued membership revocation suppresses processing', async () => {
  const p = policy(), d = createDemo({
    secret, policy: p
  });
  await d.ingress(req());
  p.privateUsers = [];
  assert.deepEqual(await d.drain(), []);
});
test('concurrent demo drain does not duplicate local delivery', async () => {
  const d = createDemo({
    secret, policy: policy()
  });
  await d.ingress(req());
  await Promise.all([d.drain(), d.drain(), d.drain()]);
  assert.equal(d.outputs().length, 1);
});
test('active demo drain retains a wake for an already visited session', async () => {
  const p = policy();
  p.privateUsers.push('102');
  const enteredB = latch(), releaseB = latch(), calls = [];
  const d = createDemo({secret, policy: p, provider: {
    async runTurn(turn, {memoryMarkdown}) {
      calls.push(turn.turnId);
      if (turn.principal.userId === '102') {
        enteredB.resolve();
        await releaseB.promise;
      }
      return {text: 'Synthetic reply', memoryMarkdown};
    }
  }});
  await d.ingress(req(1));
  await d.ingress(req(2, 102));
  const first = d.drain();
  let overlapping;
  try {
    await enteredB.promise;
    assert.deepEqual(await statuses(d, p, req(1)), ['SENT']);
    assert.equal(d.outputs().length, 1);
    await d.ingress(req(3));
    overlapping = d.drain();
  } finally { releaseB.resolve(); }
  const completed = await Promise.all([first, overlapping].map(async drain => {
    const output = await drain;
    assert.deepEqual(await statuses(d, p, req(3)), ['SENT', 'SENT']);
    return output;
  }));
  assert.ok(completed.every(output => output.length === 3));
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls).size, 3);
  assert.equal(new Set(d.outputs().map(output => output.turnId)).size, 3);
  for (const request of [req(1), req(2, 102), req(3)]) await d.ingress(request);
  await d.drain();
  assert.equal(calls.length, 3);
  assert.equal(d.outputs().length, 3);
});
test('active demo drain stops at quarantine and processes new work in another session', async () => {
  const p = policy();
  p.privateUsers.push('102', '103');
  const enteredB = latch(), releaseB = latch(), calls = [];
  const d = createDemo({secret, policy: p, provider: {
    async runTurn(turn, {memoryMarkdown}) {
      calls.push(turn.principal.userId);
      if (turn.principal.userId === '101') throw Error('Synthetic unknown outcome');
      if (turn.principal.userId === '102') {
        enteredB.resolve();
        await releaseB.promise;
      }
      return {text: 'Synthetic reply', memoryMarkdown};
    }
  }});
  const quarantineKey = route(JSON.parse(req().body), p).sessionKey;
  const acquire = d.ledger.acquire.bind(d.ledger);
  let quarantineVisits = 0;
  d.ledger.acquire = (...args) => {
    if (args[0] === quarantineKey) {
      quarantineVisits++;
      assert.ok(quarantineVisits <= 2, 'quarantine must stop without a rescan loop');
    }
    return acquire(...args);
  };
  await d.ingress(req(1));
  await d.ingress(req(2, 102));
  const first = d.drain();
  let overlapping;
  try {
    await enteredB.promise;
    assert.deepEqual(await statuses(d, p, req()), ['QUARANTINED']);
    await d.ingress(req(3));
    await d.ingress(req(4, 103));
    overlapping = d.drain();
  } finally { releaseB.resolve(); }
  await Promise.all([first, overlapping]);
  assert.deepEqual(await statuses(d, p, req(3)), ['QUARANTINED', 'PENDING']);
  assert.deepEqual(await statuses(d, p, req(4, 103)), ['SENT']);
  assert.deepEqual(calls, ['101', '102', '103']);
  assert.equal(d.outputs().length, 2);
});
test('provider failure quarantines instead of automatic local retry', async () => {
  let calls = 0;
  const d = createDemo({ secret, policy: policy(), provider: {
    async runTurn(turn) {
      calls++;
      assert.ok(Object.isFrozen(turn.principal));
      throw Error('Synthetic transient error');
    }
  }});
  await d.ingress(req());
  assert.deepEqual(await d.drain(), []);
  await d.ingress(req(2));
  assert.deepEqual(await d.drain(), []);
  assert.equal(calls, 1);
});
test('demo reauthorizes after provider and uses unified memory contract', async () => {
  const p = policy();
  const d = createDemo({ secret, policy: p, provider: {
    async runTurn(_turn, {memoryMarkdown}) {
      assert.equal(memoryMarkdown, '');
      p.privateUsers = [];
      return { text: 'synthetic', memoryMarkdown: '# Synthetic memory', durable: true };
    }
  }});
  await d.ingress(req());
  assert.deepEqual(await d.drain(), []);
});

test('actual demo worker keeps private and group/topic Markdown in separate scopes', async () => {
  const memories = [];
  const d = createDemo({secret, policy: policy(), provider: {
    async runTurn(turn, {memoryMarkdown}) {
      memories.push({chat: turn.principal.chatId, topic: turn.principal.topicId, memoryMarkdown});
      return {text: 'scoped', memoryMarkdown: `scope:${turn.principal.chatId}:${turn.principal.topicId}`};
    }
  }});
  const admit = async (n, chat, topic) => {
    const r = req(n), body = JSON.parse(r.body);
    if (chat !== 101) body.message.chat = {id: chat, type: 'supergroup'};
    if (topic) body.message.message_thread_id = topic;
    r.body = Buffer.from(JSON.stringify(body));
    assert.equal((await d.ingress(r)).body.accepted, true);
    await d.drain();
  };
  await admit(1, 101);
  await admit(2, -201, 1);
  await admit(3, -201, 2);
  await admit(4, -201, 1);
  await admit(5, 101);
  assert.deepEqual(memories.map(m => m.memoryMarkdown), ['', '', '', 'scope:-201:1', 'scope:101:null']);
  assert.equal(new Set(d.outputs().map(o => o.sessionKey)).size, 3);
});
