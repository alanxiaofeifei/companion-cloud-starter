import { createIngress, route } from './ingress.mjs';
import { MemoryInbox } from './storage.mjs';
/** Synthetic deterministic provider. No external model or tool access. */
export class SyntheticProvider {
  async runTurn(turn) {
    return {
      text: `Synthetic reply: ${turn.text}`, checkpoint: {
        version: 'demo', durable: false
      }
    };
  }
}
/** In-process only: deliberately not a distributed lease/queue/durable worker. */
export function createDemo({ secret, policy, provider = new SyntheticProvider() }) {
  const inbox = new MemoryInbox(), pending = new Map(), complete = new Set(), outputs = [];
  const queue = {
    async enqueue(id, value) {
      if (!complete.has(id))
        pending.set(id, value);
    }
  };
  const ingress = createIngress({
    secret, policy, inbox, queue
  });
  let draining = null;
  async function processPending() {
    for (const [id] of pending) {
      const turn = await inbox.get(id);
      if (!turn)
        throw new Error('Missing admitted turn');
      // Re-evaluate current policy at execution, including revoked membership.
      const p = turn.principal;
      const reconstructed = {
        update_id: Number(turn.updateId), message: {
          message_id: Number(turn.messageId),
          from: {
            id: Number(p.userId), is_bot: false
          }, chat: {
            id: Number(p.chatId), type: p.role === 'private-member' ? 'private' : 'supergroup'
          },
          ...(p.topicId === null ? {} : {
            message_thread_id: Number(p.topicId)
          }), text: turn.text
        }
      };
      if (!route(reconstructed, policy)) {
        pending.delete(id);
        complete.add(id);
        continue;
      }
      const request = structuredClone({
        ...turn, turnId: id
      });
      Object.freeze(request.principal);
      Object.freeze(request);
      const result = await provider.runTurn(request, {
        signal: AbortSignal.timeout(5000), deadlineMs: Date.now() + 5000
      });
      if (typeof result?.text !== 'string' || result.text.length > 4096)
        throw new Error('Invalid synthetic response');
      // The only delivery target is a local array. Never calls Telegram.
      outputs.push({
        turnId: id, sessionKey: turn.sessionKey, chatId: p.chatId, text: result.text
      });
      pending.delete(id);
      complete.add(id);
    }
    return structuredClone(outputs);
  }
  return {
    ingress, outputs: () => structuredClone(outputs), drain() {
      if (!draining)
        draining = processPending().finally(() => {
          draining = null;
        });
      return draining;
    }
  };
}
