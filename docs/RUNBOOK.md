# Operator runbook

## Before any publication

1. Review every file and the complete git history; a fresh history is preferable to rewriting a private repository.
2. Confirm all identifiers are placeholders or synthetic fixtures. Run a secret scanner and manually inspect URLs, examples, logs and test outputs. Automated scanning alone cannot establish privacy.
3. Verify the included MIT license and maintainer-approved attribution for this original code. If distributing upstream code, add its exact applicable notices and license; no upstream runtime source is currently included.
4. Run `npm run check`. Independently review authorization, duplicate and error paths. Never put command transcripts containing credentials into the release.

## Before any cloud deployment

The supplied service YAML is an illustrative **smoke scaffold only**, not a production service. Fill placeholders locally. Image building, pushing, IAM changes, secrets, webhook registration and deployment are separate operator actions; no script here performs them.

- Use an isolated test project and separately approved test bot, not a production bot.
- Pin the image digest and base image digest; audit the runtime and any SDK dependencies.
- Use a dedicated workload identity with narrowly scoped Firestore/GCS/queue permissions. Do not attach owner/admin roles or mount personal developer credential directories.
- Separate public ingress from IAM-protected worker. Ingress needs a webhook secret, not the bot token or runtime credentials. Worker validates queue OIDC issuer, audience and service-account identity.
- Keep the bot token, webhook secret and provider credentials in Secret Manager, with separately authorized access. Never pass them in checked-in YAML or shell transcripts.
- Implement bounded streaming request handling, rate limits, ingress-to-queue durability and reconciliation, the included session fencing/timeout worker connected to durable adapters, and structured non-content logs.
- Ensure model/tool network and filesystem privileges are minimal. Put each tenant in a boundary that actually constrains tools; prompt instructions alone cannot provide isolation.

## Acceptance matrix

Local unit tests are the only implemented validation. Required future checks:

- Firestore emulator: simultaneous admission contention, callback retries, failure before/after commit, map key reordering.
- GCS test bucket: generation pinning, checksum failure, forbidden reads, create precondition conflict, bounded object size.
- Queue: duplicate task, delayed retry, authorization revocation before delivery, dead-letter policy, outbox reconciliation.
- Worker/runtime: cross-session isolation, process kill during inference/checkpoint, lease expiry, stale worker fencing, tool cancellation, restore across instances.
- Telegram test bot: text, unsupported media, group/topic routing, typing/reaction acknowledgment, actual complete delivery and ambiguous-send handling.
- Deployment: request timeout, shutdown, cold start, quota, IAM, overlapping revisions, rollback and backup restoration.

Record exact versions, synthetic fixtures, measured boundaries and pass/fail/not-run separately. Never describe fakes or emulator results as production verification.

## Backups, retention and deletion

Retention durations are policy decisions. No TTL, lifecycle, monthly archive or deletion schedule is implemented. First agree data scope and retention, build immutable backups, verify restore, then apply approved lifecycle settings. Soft deletion, object generations and duplicate snapshots can preserve data beyond an apparent application deletion. Destructive permanent deletion needs separate explicit authorization.

## Incident handling and rollback

Stop new processing or remove the test webhook if identity, scope or credentials are suspect. Preserve minimal metadata without raw chat bodies. Revoke exposed credentials through approved processes. Quarantine ambiguous outbound sends, compare durable state to provider observations, and avoid replaying pending work blindly. Roll back by immutable image digest only after confirming schema compatibility. Restore to an isolated location and verify a manifest before moving the active pointer. No automated rollback or recovery scripts are provided.
