import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MemoryState, SessionLedger, LostLease, FirestoreState } from '../src/state.mjs';
import { processSession } from '../src/worker.mjs';
import { FileSnapshots } from '../src/snapshot.mjs';
const key = 'c'.repeat(64), id = 'd'.repeat(64);
const turn = (turnId = id) => ({
  turnId, sessionKey: key, principal: {
    tenantId: 'demo', userId: '101', chatId: '101', role: 'private-member'
  }, text: 'Synthetic preference', updateId: '1'
});
async function scratchDirectory() {
  const root = new URL('../.scratch/public-release/', import.meta.url);
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root.pathname, 'snapshot-'));
}
async function setup() {
  const store = new MemoryState(), ledger = new SessionLedger(store);
  await ledger.admit(turn());
  let calls = 0, sends = 0;
  return {
    store, ledger, sessionKey: key, owner: 'test-worker', authorize: async () => true, provider: {
      async runTurn() {
        calls++;
        return {
          text: 'Remembered', memoryMarkdown: '# Memory\nSynthetic preference: tea\n'
        };
      }
    }, sender: {
      async send() {
        sends++;
        return {
          kind: 'sent'
        };
      }
    }, counts: () => ({
      calls, sends
    })
  };
}
test('worker checkpoints memory and idempotently skips completed delivery', async () => {
  const d = await setup();
  assert.equal((await processSession(d)).status, 'SENT');
  assert.equal((await processSession(d)).status, 'IDLE');
  assert.deepEqual(d.counts(), {
    calls: 1, sends: 1
  });
  assert.match((await d.store.export(key)).memoryMarkdown, /tea/);
});
test('recovery after checkpoint does not invoke provider twice', async () => {
  const d = await setup();
  await assert.rejects(processSession({
    ...d, crash: p => {
      if (p === 'after_checkpoint')
        throw Error('crash');
    }
  }));
  assert.equal((await processSession(d)).status, 'SENT');
  assert.deepEqual(d.counts(), {
    calls: 1, sends: 1
  });
});
for (const point of ['after_run_started', 'after_provider_before_checkpoint', 'after_send_started', 'after_send_before_record']) {
  test(`crash at ${point} quarantines uncertain effects without replay`, async () => {
    const d = await setup();
    await assert.rejects(processSession({
      ...d, crash: p => {
        if (p === point)
          throw Error('crash');
      }
    }));
    const before = d.counts();
    assert.equal((await processSession(d)).status, 'QUARANTINED');
    assert.deepEqual(d.counts(), before);
  });
}
test('crash after recorded send remains terminal without resend', async () => {
  const d = await setup();
  await assert.rejects(processSession({
    ...d, crash: p => {
      if (p === 'after_send_record')
        throw Error('crash');
    }
  }));
  assert.equal((await processSession(d)).status, 'IDLE');
  assert.equal(d.counts().sends, 1);
});
test('expired and superseded leases fence stale writers', async () => {
  let now = 0;
  const store = new MemoryState(), ledger = new SessionLedger(store, {
    now: () => now
  });
  await ledger.admit(turn());
  const old = await ledger.acquire(key, 'old', 10);
  assert.equal(await ledger.acquire(key, 'other', 10), null);
  now = 11;
  const fresh = await ledger.acquire(key, 'new', 10);
  assert.ok(fresh.epoch > old.epoch);
  await assert.rejects(ledger.transition(old, id, 'PENDING', 'RUNNING'), LostLease);
  assert.equal((await ledger.transition(fresh, id, 'PENDING', 'RUNNING')).status, 'RUNNING');
});
test('concurrent acquisition grants exactly one holder', async () => {
  const d = await setup();
  const leases = await Promise.all(Array.from({
    length: 10
  }, (_, i) => d.ledger.acquire(key, String(i))));
  assert.equal(leases.filter(Boolean).length, 1);
});
test('revoked identity cancels before provider and before delivery', async () => {
  let d = await setup();
  assert.equal((await processSession({
    ...d, authorize: async () => false
  })).status, 'CANCELLED');
  assert.deepEqual(d.counts(), {
    calls: 0, sends: 0
  });
  d = await setup();
  let checks = 0;
  assert.equal((await processSession({
    ...d, authorize: async () => ++checks === 1
  })).status, 'CANCELLED');
  assert.deepEqual(d.counts(), {
    calls: 1, sends: 0
  });
});
test('provider and send timeouts quarantine; abort signal is issued', async () => {
  let d = await setup(), aborted = false;
  assert.equal((await processSession({
    ...d, timeoutMs: 5, provider: {
      runTurn(_t, { signal }) {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise(() => {
        });
      }
    }
  })).status, 'QUARANTINED');
  assert.ok(aborted);
  d = await setup();
  assert.equal((await processSession({
    ...d, timeoutMs: 5, sender: {
      send: () => new Promise(() => {
      })
    }
  })).status, 'QUARANTINED');
});
test('definite send failure is terminal and unknown send blocks later turns', async () => {
  let d = await setup();
  assert.equal((await processSession({
    ...d, sender: {
      send: async () => ({
        kind: 'definite_fail'
      })
    }
  })).status, 'FAILED');
  assert.equal((await processSession(d)).status, 'IDLE');
  d = await setup();
  await d.ledger.admit({
    ...turn('e'.repeat(64)), updateId: '2'
  });
  assert.equal((await processSession({
    ...d, sender: {
      send: async () => ({
        kind: 'ambiguous'
      })
    }
  })).status, 'QUARANTINED');
  assert.equal((await processSession(d)).status, 'QUARANTINED');
  assert.equal(d.counts().calls, 1);
});
test('conflicting turns and illegal transitions cannot overwrite state', async () => {
  const d = await setup();
  await assert.rejects(d.ledger.admit({
    ...turn(), text: 'different'
  }), /Conflicting/);
  const lease = await d.ledger.acquire(key, 'test');
  await assert.rejects(d.ledger.transition(lease, id, 'PENDING', 'SENT'), /Forbidden/);
});
test('native filesystem snapshot roundtrip survives a fresh Node process', async () => {
  const directory = await scratchDirectory();
  try {
    const d = await setup();
    await processSession(d);
    const snapshots = new FileSnapshots(directory);
    await snapshots.save(key, await d.store.export(key));
    const moduleUrl = new URL('../src/snapshot.mjs', import.meta.url).href;
    const script = `import {FileSnapshots} from ${JSON.stringify(moduleUrl)};const s=await new FileSnapshots(process.argv[1]).load(process.argv[2]);process.stdout.write(JSON.stringify(s));`;
    const restored = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, directory, key], {
      encoding: 'utf8'
    }));
    assert.match(restored.memoryMarkdown, /tea/);
    assert.equal(restored.turns[id].status, 'SENT');
    const fresh = new MemoryState();
    await fresh.restore(key, restored);
    assert.equal((await processSession({
      ...d, ledger: new SessionLedger(fresh)
    })).status, 'IDLE');
    assert.deepEqual(d.counts(), {
      calls: 1, sends: 1
    });
  }
  finally {
    await rm(directory, {
      recursive: true, force: true
    });
  }
});
test('snapshot corruption and wrong scope are rejected', async () => {
  const directory = await scratchDirectory();
  try {
    const d = await setup(), snapshots = new FileSnapshots(directory);
    await snapshots.save(key, await d.store.export(key));
    const file = join(directory, key + '.json'), e = JSON.parse(await readFile(file, 'utf8'));
    e.payload += ' ';
    await writeFile(file, JSON.stringify(e));
    await assert.rejects(snapshots.load(key), /checksum/);
    await assert.rejects(snapshots.load('../escape'), /state key/);
    await snapshots.save(key, await d.store.export(key));
    await writeFile(join(directory, 'a'.repeat(64) + '.json'), await readFile(file));
    await assert.rejects(snapshots.load('a'.repeat(64)), /schema/);
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    const data = JSON.parse(envelope.payload);
    data.state.turns[id].status = 'PREPARED';
    data.state.turns[id].reply = 'synthetic';
    data.state.turns[id].revision = 999;
    envelope.payload = JSON.stringify(data);
    envelope.sha256 = createHash('sha256').update(envelope.payload).digest('hex');
    await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(snapshots.load(key), /checkpoint/);
  }
  finally {
    await rm(directory, {
      recursive: true, force: true
    });
  }
});
test('Firestore state port uses atomic transaction callback with SDK fake', async () => {
  let value;
  const db = {
    collection: () => ({
      doc: key => key
    }), runTransaction: fn => fn({
      get: async () => ({
        exists: value !== undefined, data: () => structuredClone(value)
      }), set: (_r, s) => {
        value = structuredClone(s);
      }
    })
  };
  const ledger = new SessionLedger(new FirestoreState(db));
  await ledger.admit(turn());
  assert.ok(await ledger.acquire(key, 'worker'));
  assert.equal(await ledger.acquire(key, 'other'), null);
});
test('disk-restored PREPARED checkpoint sends once without rerunning provider', async () => {
  const directory = await scratchDirectory();
  try {
    const d = await setup();
    await assert.rejects(processSession({
      ...d, crash: p => {
        if (p === 'after_checkpoint')
          throw Error('crash');
      }
    }));
    const snapshots = new FileSnapshots(directory);
    await snapshots.save(key, await d.store.export(key));
    const fresh = new MemoryState();
    await fresh.restore(key, await snapshots.load(key));
    assert.equal((await processSession({
      ...d, ledger: new SessionLedger(fresh)
    })).status, 'SENT');
    assert.deepEqual(d.counts(), {
      calls: 1, sends: 1
    });
  }
  finally {
    await rm(directory, {
      recursive: true, force: true
    });
  }
});

for (const phase of ['provider', 'sender']) {
  test(`${phase} ignoring abort can finish late; quarantine still blocks replay and later turns`, async () => {
    const d = await setup();
    await d.ledger.admit({...turn('e'.repeat(64)), updateId: '2'});
    let effects = 0, aborted = false;
    let finish;
    const late = new Promise(resolve => { finish = resolve; });
    const operation = async (_request, {signal}) => {
      signal.addEventListener('abort', () => { aborted = true; });
      await late;
      effects++;
      return phase === 'provider' ? {text: 'late', memoryMarkdown: 'late memory'} : {kind: 'sent'};
    };
    const options = phase === 'provider' ? {provider: {runTurn: operation}} : {sender: {send: operation}};
    assert.equal((await processSession({...d, ...options, timeoutMs: 5})).status, 'QUARANTINED');
    assert.ok(aborted);
    finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(effects, 1);
    assert.equal((await processSession(d)).status, 'QUARANTINED');
    assert.equal((await d.store.export(key)).turns['e'.repeat(64)].status, 'PENDING');
  });
}
test('admission turn and UTF-8 byte caps preserve existing records and duplicate tombstones', async () => {
  const d = await setup();
  for (let n = 1; n < 100; n++) await d.ledger.admit(turn(n.toString(16).padStart(64, '0')));
  assert.equal(await d.ledger.admit(turn()), false);
  await assert.rejects(d.ledger.admit(turn('f'.repeat(64))), /capacity/);
  const store = new MemoryState(), ledger = new SessionLedger(store);
  let admitted = 0;
  for (let n = 1; n <= 100; n++) {
    try { await ledger.admit({...turn(n.toString(16).padStart(64, '0')), text: '界'.repeat(4096)}); admitted++; }
    catch (e) { assert.match(e.message, /byte capacity/); break; }
  }
  assert.ok(admitted < 100);
  assert.equal((await store.export(key)).order.length, admitted);
});
for (const growth of ['reply', 'Markdown']) {
  test(`${growth} checkpoint growth hits total byte boundary atomically and quarantines without delivery`, async () => {
    const d = await setup();
    // Reach the content budget using bounded Unicode turns; leave <16 KiB free.
    for (let n = 1; Buffer.byteLength(JSON.stringify(await d.store.export(key))) < 834000; n++) {
      await d.ledger.admit({...turn(n.toString(16).padStart(64, '0')), text: '界'.repeat(4096)});
    }
    const before = await d.store.export(key);
    let seedMemory = '';
    const provider = {runTurn: async () => ({
      text: growth === 'reply' ? '😀'.repeat(2048) : 'ok',
      memoryMarkdown: growth === 'Markdown' ? 'm'.repeat(65536) : seedMemory
    })};
    // JS code units cap makes the emoji reply 8192 UTF-8 bytes. Fill remaining
    // room explicitly with a prior scope memory so either growth crosses budget.
    if (growth === 'reply') {
      const lease = await d.ledger.acquire(key, 'seed');
      await d.ledger.transition(lease, id, 'PENDING', 'RUNNING');
      seedMemory = 'm'.repeat(849000 - Buffer.byteLength(JSON.stringify(await d.store.export(key))) - 2000);
      await d.ledger.transition(lease, id, 'RUNNING', 'PREPARED', {reply: '', memoryMarkdown: seedMemory});
      await d.ledger.transition(lease, id, 'PREPARED', 'CANCELLED');
      await d.ledger.release(lease);
    }
    const result = await processSession({...d, provider});
    assert.equal(result.status, 'QUARANTINED');
    const state = await d.store.export(key);
    assert.equal(state.revision, growth === 'reply' ? 1 : before.revision);
    assert.equal(state.memoryMarkdown, growth === 'reply' ? seedMemory : before.memoryMarkdown);
    assert.equal(d.counts().sends, 0);
    assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 850000);
  });
}
for (const status of ['PREPARED', 'SENT']) {
  test(`${status} disk checkpoint executes recovery in a fresh Node process with matching revision`, async () => {
    const directory = await scratchDirectory();
    try {
      const d = await setup();
      if (status === 'PREPARED') await assert.rejects(processSession({...d, crash: p => {
        if (p === 'after_checkpoint') throw Error('synthetic interruption');
      }}));
      else await processSession(d);
      await new FileSnapshots(directory).save(key, await d.store.export(key));
      const url = name => new URL(`../src/${name}.mjs`, import.meta.url).href;
      const script = `import {FileSnapshots} from ${JSON.stringify(url('snapshot'))};
        import {MemoryState,SessionLedger} from ${JSON.stringify(url('state'))};
        import {processSession} from ${JSON.stringify(url('worker'))};
        const store=new MemoryState(); const state=await new FileSnapshots(process.argv[1]).load(process.argv[2]);
        await store.restore(process.argv[2],state); let calls=0,sends=0;
        const result=await processSession({ledger:new SessionLedger(store),sessionKey:process.argv[2],owner:'new-process',
          authorize:async()=>true,provider:{runTurn:async()=>{calls++;throw Error('must not rerun')}},
          sender:{send:async()=>{sends++;return {kind:'sent'}}}});
        const final=await store.export(process.argv[2]);
        process.stdout.write(JSON.stringify({status:result.status,calls,sends,revision:final.revision,
          recordRevision:final.turns[process.argv[3]].revision,memoryMatches:final.memoryMarkdown===state.memoryMarkdown}));`;
      const evidence = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, directory, key, id], {encoding: 'utf8'}));
      assert.deepEqual(evidence, {status: status === 'PREPARED' ? 'SENT' : 'IDLE', calls: 0,
        sends: status === 'PREPARED' ? 1 : 0, revision: 1, recordRevision: 1, memoryMatches: true});
    } finally { await rm(directory, {recursive: true, force: true}); }
  });
}

test('provider durable claim cannot bypass a failed checkpoint commit', async () => {
  const d = await setup();
  let rejectCheckpoint = true;
  const store = {transact: (key, fn) => d.store.transact(key, state => {
    const result = fn(state);
    if (rejectCheckpoint && result.state.turns[id].status === 'PREPARED')
      throw Error('synthetic commit refusal');
    return result;
  })};
  const options = {...d, ledger: new SessionLedger(store), provider: {runTurn: async () => ({
    text: 'proposal', memoryMarkdown: 'proposal memory', durable: true
  })}};
  await assert.rejects(processSession(options), /commit refusal/);
  const state = await d.store.export(key);
  assert.equal(state.revision, 0);
  assert.equal(state.memoryMarkdown, '');
  assert.equal(state.turns[id].status, 'RUNNING');
  rejectCheckpoint = false;
  assert.equal((await processSession(options)).status, 'QUARANTINED');
  assert.equal(d.counts().sends, 0);
});
