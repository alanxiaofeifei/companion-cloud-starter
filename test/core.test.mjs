import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { route, secretMatches, createIngress } from '../src/ingress.mjs';
import { MemoryInbox, FirestoreInbox, GcsSnapshots } from '../src/storage.mjs';
import { HermesRuntime } from '../src/runtime.mjs';
const secret = 'synthetic-webhook-secret-for-testing';
const policy = {
  tenantId: 'example', privateUsers: ['101'], groups: {
    '-201': ['101', '102']
  }
};
const update = () => ({
  update_id: 1, message: {
    message_id: 2, chat: {
      id: 101, type: 'private'
    }, from: {
      id: 101, is_bot: false
    }, text: 'Synthetic hello'
  }
});
const request = u => ({
  method: 'POST', path: '/telegram/webhook', headers: {
    'x-telegram-bot-api-secret-token': secret
  }, body: Buffer.from(JSON.stringify(u))
});
test('secrets fail closed', () => {
  assert.ok(secretMatches(secret, secret));
  for (const s of ['', undefined, [], secret + 'x'])
    assert.equal(secretMatches(s, secret), false);
  assert.equal(secretMatches('', ''), false);
});
test('trusted principal ignores attacker role and names', () => {
  const u = update();
  u.message.from.role = 'owner';
  u.message.from.username = 'administrator';
  assert.equal(route(u, policy).principal.role, 'private-member');
});
test('reject unknown users, mismatched DM, bots, anonymous, channels, malformed IDs', () => {
  for (const mutate of [u => u.message.from.id = 102, u => u.message.chat.id = 102, u => u.message.from.is_bot = true, u => u.message.sender_chat = {
      id: 101
    }, u => u.message.chat.type = 'channel', u => u.update_id = -1, u => u.message.from.id = '101', u => u.message.from.id = Number.MAX_SAFE_INTEGER + 1, u => u.message.message_thread_id = 0, u => u.message.text = '']) {
    const u = update();
    mutate(u);
    assert.equal(route(u, policy), null);
  }
});
test('group membership and isolated tenant/chat/topic scopes', () => {
  const u = update(), dm = route(u, policy);
  u.message.chat = {
    id: -201, type: 'supergroup'
  };
  const group = route(u, policy);
  assert.ok(group);
  assert.notEqual(dm.sessionKey, group.sessionKey);
  u.message.message_thread_id = 9;
  assert.notEqual(route(u, policy).sessionKey, group.sessionKey);
  assert.notEqual(route(u, {
    ...policy, tenantId: 'other'
  }).sessionKey, route(u, policy).sessionKey);
  u.message.from.id = 103;
  assert.equal(route(u, policy), null);
  u.message.from.id = 101;
  u.message.chat.id = -202;
  assert.equal(route(u, policy), null);
});
test('admission survives queue failure and retry uses same ID', async () => {
  const inbox = new MemoryInbox(), ids = [];
  let fail = true;
  const handle = createIngress({
    secret, policy, inbox, queue: {
      async enqueue(id) {
        ids.push(id);
        if (fail)
          throw Error();
      }
    }
  });
  assert.equal((await handle(request(update()))).status, 503);
  fail = false;
  const r = await handle(request(update()));
  assert.equal(r.status, 200);
  assert.equal(r.body.duplicate, true);
  assert.equal(ids[0], ids[1]);
});
test('duplicates, content conflicts, malformed bodies, unauthorized payloads', async () => {
  let queued = 0;
  const handle = createIngress({
    secret, policy, inbox: new MemoryInbox(), queue: {
      async enqueue() {
        queued++;
      }
    }
  });
  const req = request(update());
  assert.equal((await handle(req)).body.duplicate, false);
  assert.equal((await handle(req)).body.duplicate, true);
  const changed = update();
  changed.message.text = 'changed';
  assert.equal((await handle(request(changed))).status, 409);
  assert.equal((await handle({
    ...req, body: Buffer.from('{')
  })).status, 400);
  assert.equal((await handle({
    ...req, body: Buffer.alloc(65537)
  })).status, 413);
  assert.equal((await handle({
    ...req, headers: {}
  })).status, 401);
  const bad = update();
  bad.message.from.id = 900;
  assert.equal((await handle(request(bad))).body.accepted, false);
  assert.equal(queued, 2);
});
test('atomic memory admission and defensive copying', async () => {
  const db = new MemoryInbox(), id = 'a'.repeat(64), v = {
    text: 'synthetic'
  };
  const r = await Promise.all(Array.from({
    length: 20
  }, () => db.createOnce(id, v)));
  assert.equal(r.filter(x => x.created).length, 1);
  v.text = 'mutated';
  assert.equal((await db.createOnce(id, v)).value.text, 'synthetic');
});
test('Firestore adapter transaction contract with synthetic SDK fake', async () => {
  let stored;
  const db = {
    collection: () => ({
      doc: id => id
    }), runTransaction: fn => fn({
      get: async () => ({
        exists: !!stored, data: () => stored
      }), create: (_ref, value) => {
        stored = value;
      }
    })
  };
  const inbox = new FirestoreInbox(db);
  assert.equal((await inbox.createOnce('b'.repeat(64), {
    text: 'test'
  })).created, true);
  assert.equal((await inbox.createOnce('b'.repeat(64), {
    text: 'test'
  })).created, false);
});
test('GCS pin, checksum, immutable create and traversal restrictions', async () => {
  const bytes = Buffer.from('synthetic snapshot'), sha256 = createHash('sha256').update(bytes).digest('hex');
  let options;
  const bucket = {
    file: (_object, opt) => {
      options = opt;
      return {
        getMetadata: async () => [{
            generation: '7', size: String(bytes.length)
          }], download: async () => [bytes], save: async (_b, o) => {
          assert.equal(o.preconditionOpts.ifGenerationMatch, 0);
        }
      };
    }
  };
  const snapshots = new GcsSnapshots(bucket);
  assert.deepEqual(await snapshots.read({
    object: 'scope/snapshot.sqlite', generation: '7', sha256
  }), bytes);
  assert.deepEqual(options, {
    generation: '7'
  });
  await assert.rejects(snapshots.read({
    object: 'scope/snapshot.sqlite', generation: '8', sha256
  }));
  await assert.rejects(snapshots.read({
    object: 'scope/snapshot.sqlite', generation: '7', sha256: '0'.repeat(64)
  }));
  await assert.rejects(snapshots.create('../outside', bytes));
  assert.equal((await snapshots.create('scope/snapshot.sqlite', bytes)).sha256, sha256);
});
test('Hermes cannot silently pretend to work', async () => {
  await assert.rejects(new HermesRuntime().runTurn(), /not implemented/);
});
test('duplicate comparison tolerates reordered persisted Firestore maps', async () => {
  let saved;
  const reverse = o => o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, reverse(v)])) : o;
  const inbox = {
    async createOnce(_id, value) {
      if (!saved) {
        saved = reverse(value);
        return {
          created: true, value: saved
        };
      }
      return {
        created: false, value: saved
      };
    }
  };
  const h = createIngress({
    secret, policy, inbox, queue: {
      async enqueue() {
      }
    }
  });
  assert.equal((await h(request(update()))).status, 200);
  assert.equal((await h(request(update()))).body.duplicate, true);
});
test('storage failure is retryable and never reaches queue', async () => {
  const h = createIngress({
    secret, policy, inbox: {
      async createOnce() {
        throw Error();
      }
    }, queue: {
      async enqueue() {
        assert.fail('must not enqueue');
      }
    }
  });
  assert.equal((await h(request(update()))).status, 503);
});
test('pinned object rejects excessive metadata before downloading', async () => {
  const snapshots = new GcsSnapshots({
    file: () => ({
      getMetadata: async () => [{
          generation: '1', size: '999999999'
        }], download: async () => assert.fail('must not download')
    })
  });
  await assert.rejects(snapshots.read({
    object: 'scope/file', generation: '1', sha256: 'a'.repeat(64)
  }), /metadata mismatch/);
});
