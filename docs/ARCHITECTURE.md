# Architecture and boundaries

## Trust flow

Telegram -> bounded HTTP transport -> secret check -> structural validation -> exact allowlist -> immutable inbox record -> durable queue -> separately authenticated worker -> isolated runtime -> checkpoint -> outbound ledger -> Telegram.

Ingress, reference storage adapters and the proposed runtime port are implemented. A separate runnable loopback-only demo includes an ephemeral queue, synthetic worker/provider and local response array. Production HTTP/queue/provider/sender wiring is future work. The separate reusable fenced worker, transactional session ledger and local filesystem checkpoint are implemented; see RECOVERY.md for exact limits. The smoke server's 200 health response does not mean any of those exist.

## Identity and isolation

A tenant corresponds to one bot/update-ID namespace. Do not share a tenant across independent bots. `update_id` deduplication is scoped to that tenant. Operator policy lists exact decimal Telegram IDs as strings. Private conversations require sender ID = chat ID; group membership requires both the exact group and the exact sender to be configured. Bots and anonymous `sender_chat` updates are rejected. Group participants intentionally share the group's topic conversation, never a participant's private conversation.

The hashed session key covers tenant, chat type, chat ID and optional topic ID. Hashing is namespacing, not anonymization or access control. Firestore records still contain personal data at runtime. Use separate accounts/buckets/projects when stronger isolation is needed. Knowledge and historical archives are absent; add them only with independent scope enforcement before reads.

The current template accepts text `message` updates only. Edited posts, callbacks, channels, media and unknown shapes receive `accepted:false`. Production must choose how to tell authorized users unsupported content was not processed, without turning unknown-user rejection into a disclosure.

## Durability and retries

`createOnce` atomically stores the first value or returns the existing value. Duplicate webhook deliveries enqueue the same deterministic task identity so that a queue outage after admission can repair itself. A changed update reusing the same ID receives 409 and must not overwrite state. Comparison is structural, independent of Firestore map ordering.

Telegram retries alone do not guarantee recovery forever. A production implementation needs a transactional dispatch-intent/outbox state and bounded reconciliation. Queue dedup retention is finite; the worker needs its own durable terminal record. Re-enqueueing must not rerun a finished turn. Queue identity never makes Telegram sends exactly-once.

The worker must acquire a fenced lease, serialize each session, reauthorize against current policy, fetch only that scope, and record inference/checkpoint/send outcomes. A timeout during a Telegram send can mean the message was delivered; quarantine uncertain results for operator reconciliation instead of blindly resending. The generic state machine is implemented in worker.mjs/state.mjs, with synthetic tests and local snapshots. Its production adapters and cloud wiring remain unverified.

## Persistence

Firestore owns admission and eventual coordination metadata. GCS owns immutable versioned snapshots. Reads require exact object generation and expected SHA-256 plus size validation. Uploads are create-only with `ifGenerationMatch:0`; a caller cannot overwrite an existing snapshot silently. The current upload method returns a digest, not a restoration manifest. Extend it to capture the verified upload generation before setting a Firestore pointer, and test pointer/backup crash ordering.

For SQLite, use its online backup API or a quiesced consistent checkpoint; a copy of a live main database file may omit WAL state. Never host a live SQLite database on GCS FUSE. Markdown memory and the database must be represented by one consistent manifest with an explicit revision; do not independently restore mismatched versions.

Cloud Run filesystems and instances are disposable. Background work after a webhook response is not a durable execution mechanism. Use an authenticated queue request or a job with a bounded lifecycle; persist before acknowledging completion. Cloud Run concurrency=1 and max-instances=1 are not substitutes for distributed fencing across rollout overlap.

## Hermes contract

Proposed request: `turnId`, `sessionKey`, immutable verified `principal`, `text`, `updateId`, plus `AbortSignal` and absolute deadline. Proposed result: text and a durable checkpoint acknowledgment. The concrete adapter must verify what that acknowledgment means and track tool effects. Model text cannot assign identities, change routing or report its own privileges.

The Hermes runtime always throws. Native SQLite/Markdown lifecycle, tool allowlists, cancellation, cross-tenant isolation, vision, file tooling, background reviews, and production recovery are all unimplemented here. A simple text-only model provider is not a drop-in Hermes runtime.
