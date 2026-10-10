import { createIngress } from './ingress.mjs';
import { MemoryInbox } from './storage.mjs';
import { MemoryState, SessionLedger } from './state.mjs';
import { processSession } from './worker.mjs';
/** Synthetic deterministic provider. No external model or tools; preserves memory. */
export class SyntheticProvider {
  async runTurn(turn, { memoryMarkdown }) {
    return { text: `Synthetic reply: ${turn.text}`.slice(0, 4096), memoryMarkdown };
  }
}
export function currentlyAuthorized(principal, policy) {
  if (principal.tenantId !== policy.tenantId)
    return false;
  if (principal.role === 'private-member')
    return principal.chatId === principal.userId && policy.privateUsers.includes(principal.userId);
  return principal.role === 'group-member' && !!policy.groups[principal.chatId]?.includes(principal.userId);
}
/** In-process queue and sender; the SAME fenced ledger/worker used by recovery tests. */
export function createDemo({ secret, policy, provider = new SyntheticProvider(), timeoutMs = 5000 }) {
  const inbox = new MemoryInbox(), store = new MemoryState(), ledger = new SessionLedger(store);
  const sessions = new Set(), outputs = [];
  let rescanNeeded = false;
  const queue = {
    async enqueue(id) {
      const turn = await inbox.get(id);
      if (!turn)
        throw Error('Missing admitted turn');
      await ledger.admit({ ...turn, turnId: id });
      sessions.add(turn.sessionKey);
      rescanNeeded = true;
    }
  };
  const ingress = createIngress({ secret, policy, inbox, queue });
  const sender = {
    async send({ turnId, principal, text }) {
      const turn = await inbox.get(turnId);
      outputs.push({ turnId, sessionKey: turn.sessionKey, chatId: principal.chatId, text });
      return { kind: 'sent' };
    }
  };
  let draining = null;
  async function processPending() {
    do {
      // Enqueue during an await retains a wake even for an already visited session.
      // Only enqueue requests another pass; idle/quarantine never schedules itself.
      rescanNeeded = false;
      for (const sessionKey of sessions) {
        // At most 100 turns per session; stop at idle, contention or quarantine.
        for (let i = 0; i < 100; i++) {
          const { status } = await processSession({
            ledger, sessionKey, owner: 'synthetic-demo', provider, sender, timeoutMs,
            authorize: principal => currentlyAuthorized(principal, policy)
          });
          if (['IDLE', 'BUSY', 'QUARANTINED'].includes(status))
            break;
        }
      }
    } while (rescanNeeded);
    return structuredClone(outputs);
  }
  return {
    ingress, ledger, store, outputs: () => structuredClone(outputs),
    drain() {
      draining ??= processPending().finally(() => { draining = null; });
      return draining;
    }
  };
}
