# Fenced worker and recovery examples

## Implemented reusable core

`src/state.mjs` supplies a `SessionLedger` over the atomic `transact(sessionKey, callback)` port. `MemoryState` serializes transactions locally; `FirestoreState` maps one session record to an official-client transaction. The latter is exercised through an SDK fake, not a cloud database or emulator.

`src/worker.mjs` provides the actual provider/checkpoint/delivery state machine. Supply a runtime `provider.runTurn`, a `sender.send` and authoritative `authorize` function. Caller admission must originate from the trusted ingress; the ledger is not a public authentication API.

The state transitions are:

- PENDING -> RUNNING -> PREPARED -> SENDING -> SENT
- PENDING/PREPARED -> CANCELLED when membership is revoked
- RUNNING/SENDING -> QUARANTINED after uncertainty or interrupted work
- SENDING -> FAILED only after the sender positively reports a definite failure

Every state transition checks the session lease's owner, monotonically increasing epoch and expiry inside the transaction callback. Only one current holder can write. Lease renewal is available; the sample worker instead bounds provider and sender phases within its lease budget. Timeout races return promptly and send an abort signal, but remote cancellation is cooperative, so timeout outcomes remain unknown.

## Checkpoint and delivery rules

After inference, reply text and returned Markdown memory are committed in the same transaction before PREPARED. Recovery at PREPARED reuses that checkpoint without invoking the provider again. A worker marks SENDING before making the external call. Interrupted SENDING is quarantined on re-entry, even if the crash occurred before the actual send; this intentionally prefers a visible unresolved record over accidental duplicate delivery.

Interrupted RUNNING is also quarantined. The provider could have made tool effects or incurred charges before its result vanished. The smaller `demo.mjs` example retries its synthetic side-effect-free provider; that is not the generic production-safe policy.

SENT, FAILED and CANCELLED are terminal. A quarantined turn blocks later turns in the session to avoid silently skipping uncertain context. Operator reconciliation and creating a separately authorized new turn are required; no automatic force-resend or quarantine-clear API is provided.

This code does not claim exactly-once remote effects. Epoch fencing protects storage writes; a remote Telegram endpoint does not understand those epochs and cannot cancel a stale in-flight send.

## Scope, capacity and ordering

A session key isolates tenant/chat/topic. Admission order is the transaction's append order, not Telegram update chronology. The example caps a session at 100 admitted turns and checks an admission byte limit; it deliberately refuses new work rather than deleting deduplication tombstones. Production must partition records and design archival/tombstone retention while respecting Firestore's document limits. Runtime response/checkpoint growth and SDK encoding overhead still need real database tests.

The ledger stores runtime personal data. Do not dump it into public logs, examples or repositories. Limit provider access and supply each call only its scope's memory.

## Native filesystem checkpoint

`src/snapshot.mjs` implements `FileSnapshots`: Node's own filesystem API, restrictive file modes, temporary-file write + fsync + atomic rename + directory fsync, a SHA-256 envelope, schema/scope checks and a 1 MiB bound. It snapshots the ledger and Markdown memory together.

This is a **single trusted writer, local filesystem** checkpoint. It is not a distributed store, automatic per-transition persistence, Hermes's native database format, or proof of Cloud Run persistence. The operator must stop the source worker before restoring; load clears the old lease and must never be used while another worker is active. SHA-256 detects corruption, not a malicious writer who can recompute the checksum. The directory must be trusted and inaccessible to untrusted tenants; this adapter is not a hostile-symlink sandbox.

One test writes a real snapshot, starts a separate Node process to load it, restores a fresh ledger, and verifies memory plus terminal dedup survive. Other tests corrupt the payload and reject invalid scope keys. Live SQLite backup and Hermes Markdown synchronization remain separate future integrations.

## Deterministic verification

`test/recovery.test.mjs` injects crashes after RUNNING, after provider result, after checkpoint, before send, after send but before recording, and after terminal recording. These are deterministic exceptions, not OS process kills; their cleanup releases the test lease, while actual death requires waiting for lease expiry. Tests also cover concurrent acquisition, epoch supersession, revocation before inference/delivery, timeouts, unknown sends and terminal replay.

No queue, Telegram, Google Cloud or real model is contacted. The fresh-process filesystem restoration test is real local persistence; it must not be described as cloud restart verification.
