import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const directory = await mkdtemp(join(tmpdir(), 'companion-snapshot-'));
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
  const directory = await mkdtemp(join(tmpdir(), 'companion-snapshot-'));
  try {
    const d = await setup(), snapshots = new FileSnapshots(directory);
    await snapshots.save(key, await d.store.export(key));
    const file = join(directory, key + '.json'), e = JSON.parse(await readFile(file, 'utf8'));
    e.payload += ' ';
    await writeFile(file, JSON.stringify(e));
    await assert.rejects(snapshots.load(key), /checksum/);
    await assert.rejects(snapshots.load('../escape'), /state key/);
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
  const directory = await mkdtemp(join(tmpdir(), 'companion-snapshot-'));
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
