/** Runtime port used by processSession (Hermes bridge remains unimplemented):
 * runTurn(turn, {signal, deadlineMs, memoryMarkdown})
 *   -> Promise<{text: string, memoryMarkdown: string}>
 * text is <=4096 JS code units; Markdown is <=65536 UTF-8 bytes.
 * turnId is stable; principal is server-verified and frozen. The supplied memory
 * belongs only to sessionKey. Provider results are proposals, never durable proof.
 * The ledger atomically commits reply + memory at one revision before PREPARED.
 * MemoryState is volatile; only a durable transact adapter can promise durability.
 * AbortSignal is cooperative: timeout/error may leave effects and is quarantined.
 */
export class HermesRuntime {
  async runTurn() {
    throw new Error('Hermes integration is not implemented or validated');
  }
}
