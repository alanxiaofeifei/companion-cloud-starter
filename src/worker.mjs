import { LostLease, CapacityExceeded } from './state.mjs';
/** Crash hooks run outside provider catches to simulate process loss exactly. */
export async function processSession({ ledger, sessionKey, owner, provider, sender, authorize, timeoutMs = 10000, crash = () => {
} }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw Error('Invalid timeout');
  const lease = await ledger.acquire(sessionKey, owner, timeoutMs * 3 + 1000);
  if (!lease)
    return {
      status: 'BUSY'
    };
  const timed = async (fn) => {
    const controller = new AbortController();
    let timer;
    const work = Promise.resolve().then(() => fn(controller.signal));
    work.catch(() => {
    });
    try {
      return await Promise.race([work, new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Error('Outcome unknown after timeout'));
          }, timeoutMs);
        })]);
    }
    finally {
      clearTimeout(timer);
    }
  };
  try {
    const next = await ledger.next(lease);
    if (!next)
      return {
        status: 'IDLE'
      };
    let r = next.record;
    const id = r.turn.turnId;
    if (r.status === 'QUARANTINED')
      return {
        status: r.status
      };
    if (['RUNNING', 'SENDING'].includes(r.status)) {
      await ledger.transition(lease, id, r.status, 'QUARANTINED', {
        reason: 'interrupted_external_effect'
      });
      return {
        status: 'QUARANTINED'
      };
    }
    if (!await authorize(r.turn.principal)) {
      await ledger.transition(lease, id, r.status, 'CANCELLED');
      return {
        status: 'CANCELLED'
      };
    }
    if (r.status === 'PENDING') {
      await ledger.transition(lease, id, 'PENDING', 'RUNNING');
      crash('after_run_started');
      let result;
      try {
        const turn = structuredClone(r.turn);
        Object.freeze(turn.principal);
        Object.freeze(turn);
        result = await timed(signal => provider.runTurn(turn, {
          signal, deadlineMs: Date.now() + timeoutMs, memoryMarkdown: next.memoryMarkdown
        }));
        if (typeof result?.text !== 'string' || result.text.length > 4096 || typeof result?.memoryMarkdown !== 'string' || Buffer.byteLength(result.memoryMarkdown) > 65536)
          throw Error('Invalid provider result');
      }
      catch {
        await ledger.transition(lease, id, 'RUNNING', 'QUARANTINED', {
          reason: 'provider_outcome_unknown'
        });
        return {
          status: 'QUARANTINED'
        };
      }
      crash('after_provider_before_checkpoint');
      try {
        r = await ledger.transition(lease, id, 'RUNNING', 'PREPARED', {
          reply: result.text, memoryMarkdown: result.memoryMarkdown
        });
      }
      catch (error) {
        if (!(error instanceof CapacityExceeded))
          throw error;
        await ledger.transition(lease, id, 'RUNNING', 'QUARANTINED', {
          reason: 'checkpoint_capacity_exceeded'
        });
        return { status: 'QUARANTINED' };
      }
      crash('after_checkpoint');
    }
    // Check current authorization again immediately before starting delivery.
    if (!await authorize(r.turn.principal)) {
      await ledger.transition(lease, id, 'PREPARED', 'CANCELLED');
      return {
        status: 'CANCELLED'
      };
    }
    await ledger.transition(lease, id, 'PREPARED', 'SENDING');
    crash('after_send_started');
    let outcome;
    try {
      outcome = await timed(signal => sender.send({
        turnId: id, principal: r.turn.principal, text: r.reply
      }, {
        signal
      }));
    }
    catch {
      outcome = {
        kind: 'ambiguous'
      };
    }
    crash('after_send_before_record');
    const status = outcome?.kind === 'sent' ? 'SENT' : outcome?.kind === 'definite_fail' ? 'FAILED' : 'QUARANTINED';
    await ledger.transition(lease, id, 'SENDING', status, {
      reason: status === 'QUARANTINED' ? 'delivery_outcome_unknown' : ''
    });
    crash('after_send_record');
    return {
      status
    };
  }
  finally {
    // Simulated crash releases the in-memory lease; persisted state still marks the
    // interrupted effect. Real process death leaves lease held until expiry.
    try {
      await ledger.release(lease);
    }
    catch (e) {
      if (!(e instanceof LostLease))
        throw e;
    }
  }
}
