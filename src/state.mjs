import { isDeepStrictEqual } from 'node:util';
export const validKey = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw Error('Invalid state key');
  return value;
};
export class LostLease extends Error {
}
/** Port: transact(key, pureCallback) atomically reads/updates ONE session record.
* Callback returns {state,result}, can be retried, and must never cause effects.
* A production implementation must be durable and linearizable per key.
*/
export class MemoryState {
  #values = new Map();
  #tail = Promise.resolve();
  async transact(key, fn) {
    validKey(key);
    const run = this.#tail.then(() => {
      const { state, result } = fn(structuredClone(this.#values.get(key)));
      if (state !== undefined)
        this.#values.set(key, structuredClone(state));
      return structuredClone(result);
    });
    this.#tail = run.catch(() => {
    });
    return run;
  }
  async export(key) {
    return this.transact(key, state => ({
      state, result: state
    }));
  }
  async restore(key, state) {
    return this.transact(key, current => {
      if (current !== undefined)
        throw Error('Refuse overwrite');
      return {
        state, result: true
      };
    });
  }
}
export class FirestoreState {
  constructor(db, collection = 'sessions') {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(collection))
      throw Error('Invalid collection');
    this.db = db;
    this.collection = collection;
  }
  async transact(key, fn) {
    const ref = this.db.collection(this.collection).doc(validKey(key));
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref), { state, result } = fn(snapshot.exists ? snapshot.data() : undefined);
      if (state !== undefined)
        tx.set(ref, state);
      return result;
    });
  }
}
/** Compact reference ledger: bounded to 100 turns per session. Production must
* partition/prune with terminal tombstones, not silently forget dedup history.
*/
export class SessionLedger {
  constructor(store, { now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
  }
  async admit(turn) {
    validKey(turn.sessionKey);
    validKey(turn.turnId);
    return this.store.transact(turn.sessionKey, state => {
      state ??= {
        version: 1, epoch: 0, lease: null, memoryMarkdown: '', turns: {}, order: []
      };
      const old = state.turns[turn.turnId];
      if (old) {
        if (!isDeepStrictEqual(old.turn, turn))
          throw Error('Conflicting turn');
        return {
          state, result: false
        };
      }
      if (state.order.length >= 100)
        throw Error('Session capacity reached; archival policy required');
      if (typeof turn.text !== 'string' || turn.text.length > 4096 || !turn.principal || typeof turn.principal !== 'object')
        throw Error('Invalid admitted turn');
      state.turns[turn.turnId] = {
        turn: structuredClone(turn), status: 'PENDING'
      };
      state.order.push(turn.turnId);
      if (Buffer.byteLength(JSON.stringify(state)) > 850000)
        throw Error('Session byte capacity reached');
      return {
        state, result: true
      };
    });
  }
  async acquire(sessionKey, owner, ttlMs = 30000) {
    if (typeof owner !== 'string' || !owner || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300000)
      throw Error('Invalid lease');
    return this.store.transact(sessionKey, state => {
      const now = this.now();
      if (!state)
        throw Error('Unknown session');
      if (state.lease && state.lease.expiresAt > now)
        return {
          state, result: null
        };
      state.epoch++;
      state.lease = {
        owner, epoch: state.epoch, expiresAt: now + ttlMs
      };
      return {
        state, result: {
          sessionKey, ...state.lease
        }
      };
    });
  }
  async fenced(lease, fn) {
    return this.store.transact(lease.sessionKey, state => {
      const now = this.now();
      if (!state || state.lease?.owner !== lease.owner || state.lease?.epoch !== lease.epoch || state.lease.expiresAt <= now)
        throw new LostLease('Lease expired or superseded');
      return {
        state, result: fn(state)
      };
    });
  }
  async renew(lease, ttlMs = 30000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300000)
      throw Error('Invalid lease duration');
    return this.fenced(lease, state => {
      state.lease.expiresAt = this.now() + ttlMs;
      return {
        sessionKey: lease.sessionKey, ...state.lease
      };
    });
  }
  async release(lease) {
    return this.fenced(lease, state => {
      state.lease = null;
      return true;
    });
  }
  async next(lease) {
    return this.fenced(lease, state => {
      // Quarantine halts the session so later context cannot skip an uncertain turn.
      for (const id of state.order) {
        const r = state.turns[id];
        if (['SENT', 'CANCELLED', 'FAILED'].includes(r.status))
          continue;
        return {
          record: r, memoryMarkdown: state.memoryMarkdown
        };
      }
      return null;
    });
  }
  async transition(lease, id, from, to, patch = {}) {
    return this.fenced(lease, state => {
      const r = state.turns[id];
      if (!r || r.status !== from)
        throw Error('Unexpected transition');
      const allowed = {
        PENDING: ['RUNNING', 'CANCELLED'], RUNNING: ['PREPARED', 'QUARANTINED'], PREPARED: ['SENDING', 'CANCELLED'], SENDING: ['SENT', 'FAILED', 'QUARANTINED']
      };
      if (!allowed[from]?.includes(to))
        throw Error('Forbidden transition');
      if (to === 'PREPARED') {
        if (typeof patch.reply !== 'string' || patch.reply.length > 4096 || typeof patch.memoryMarkdown !== 'string' || Buffer.byteLength(patch.memoryMarkdown) > 65536)
          throw Error('Invalid checkpoint');
        state.memoryMarkdown = patch.memoryMarkdown;
        r.reply = patch.reply;
      }
      if (typeof patch.reason === 'string')
        r.reason = patch.reason.slice(0, 120);
      r.status = to;
      return r;
    });
  }
}
