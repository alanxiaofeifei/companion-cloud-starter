import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemo } from '../src/demo.mjs';
const secret = 'synthetic-webhook-secret-for-testing';
const policy = () => ({
  tenantId: 'demo', privateUsers: ['101'], groups: {
    '-201': ['101']
  }
});
const req = (id = 1) => ({
  method: 'POST', path: '/telegram/webhook', headers: {
    'x-telegram-bot-api-secret-token': secret
  }, body: Buffer.from(JSON.stringify({
    update_id: id, message: {
      message_id: 1, chat: {
        id: 101, type: 'private'
      }, from: {
        id: 101, is_bot: false
      }, text: 'Hello from a synthetic user'
    }
  }))
});
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
test('provider failure retains pending work for local retry', async () => {
  let fail = true;
  const d = createDemo({
    secret, policy: policy(), provider: {
      async runTurn(turn) {
        assert.ok(Object.isFrozen(turn.principal));
        if (fail)
          throw Error('Synthetic transient error');
        return {
          text: 'recovered'
        };
      }
    }
  });
  await d.ingress(req());
  await assert.rejects(d.drain());
  assert.equal(d.outputs().length, 0);
  fail = false;
  assert.equal((await d.drain())[0].text, 'recovered');
});
