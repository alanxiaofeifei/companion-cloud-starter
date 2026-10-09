/** Runtime port (proposed, NOT an implemented bridge):
* runTurn({turnId, sessionKey, principal, text, updateId}, {signal, deadlineMs})
*   -> Promise<{text, checkpoint:{version, durable:true}}>
* turnId is a stable idempotency key, not proof that a provider is idempotent.
* principal/session are immutable server-verified inputs, never model output.
* The worker must reauthorize on dequeue, serialize each session, enforce fenced
* leases and deadline cancellation, and durably acknowledge memory/effects before
* success. A runtime's assertion durable:true must be verified by its adapter.
* A generic fenced worker is provided separately; native Hermes persistence and
* a real outbound sender are not implemented.
*/
export class HermesRuntime {
  async runTurn() {
    throw new Error('Hermes integration is not implemented or validated');
  }
}
