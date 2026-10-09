# Companion Cloud Template

A small, original reference scaffold for a Telegram companion's **trusted ingress and storage boundary**. It is deliberately not a ready-to-deploy assistant. The default HTTP server exposes a smoke health endpoint and refuses all operational requests.

## Included

- Secret-authenticated Telegram ingress with exact sender/chat allowlists; payload names and claimed roles confer no authority.
- Tenant, chat and topic isolation; private chat IDs must match the authenticated sender.
- Atomic inbox interface, deterministic queue identities and retryable admission after queue failure.
- Injectable Firestore inbox/session transaction and GCS immutable snapshot adapters.
- Fenced session-worker state machine with checkpoint reuse, durable-store port, terminal deduplication and quarantine of unknown effects.
- Atomic local filesystem snapshots tested across a fresh Node process, carrying Markdown memory and ledger state together.
- Dependency-free synthetic tests covering trust, isolation, duplicates, retry and blob integrity.
- A deliberately throwing Hermes runtime placeholder and a proposed cancellation/checkpoint contract.
- Architecture, operating instructions and extraction lessons; placeholder-only Cloud Run configuration.

## Local verification

Requires Node.js 22 or newer. No credentials, network, SDK installation or model subscription are needed.

```sh
npm test
npm run check
npm start
# In another terminal: curl http://127.0.0.1:8080/healthz
# Any operational endpoint returns 503, by design.
```

## Runnable local synthetic flow

```sh
npm run demo
# In another terminal:
curl -s http://127.0.0.1:8081/telegram/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: synthetic-webhook-secret-for-testing' \
  -d '{"update_id":1,"message":{"message_id":1,"chat":{"id":101,"type":"private"},"from":{"id":101,"is_bot":false},"text":"Hello"}}'
```

This runs webhook -> in-memory inbox -> local queue -> worker -> deterministic synthetic provider -> local response array. It listens only on loopback and cannot send Telegram messages. Its fixed secret and IDs are test fixtures, never real configuration. All state disappears at process exit. Cancellation signals are passed to the provider but this demo does not enforce hard execution deadlines; this simple demo omits the more complete ledger available separately in `src/state.mjs` and `src/worker.mjs`; neither example sends real messages.

The tests do not contact Telegram, Google Cloud or model providers. No live durability, IAM, model correctness, delivery, failover or Hermes functionality is certified.

## Adapting this scaffold

Supply a validated operator policy and a long random webhook secret to `createIngress`. Never put either into source control. The HTTP transport must enforce the 64 KiB limit while streaming, authenticate before parsing, and never log bodies or secret headers. `src/server.mjs` is only a smoke target, not this transport.

The `queue.enqueue(id, {inboxId})` port must durably create a task with that stable ID; a confirmed already-existing task may count as success. Other errors must throw. A worker must reread the authoritative inbox and reauthorize membership before executing. The reusable state machine in `src/worker.mjs` covers the next execution stages; see [recovery](docs/RECOVERY.md). This repository intentionally has no fake-success queue or fake-success model.

To use Google Cloud, select and pin the official `@google-cloud/firestore` and `@google-cloud/storage` SDK versions, install and audit them, and inject their clients. These dependencies are not installed, locked or integration-tested here. Use workload identity, never committed service-account keys. The GCS upload adapter currently returns a digest only: restoration manifests require verified upload generation metadata before being usable.

Read [architecture](docs/ARCHITECTURE.md), [runbook](docs/RUNBOOK.md), [lessons](docs/LESSONS.md) and [Chinese engineering notes](docs/ENGINEERING_NOTES.zh-CN.md).

## Publication and licensing

This directory was written fresh; no private repository history, profiles, conversations, knowledge packs, tokens or upstream runtime implementation are included. All test identities are synthetic. This is a local publication candidate, not a published release. See [NOTICE](NOTICE). The original code is MIT licensed.
