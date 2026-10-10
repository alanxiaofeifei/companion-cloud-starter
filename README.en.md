# Companion Cloud Starter

[中文版](README.md) | [English](README.en.md)

Want an AI chat assistant that can receive messages anytime, without buying a dedicated Mac mini or keeping your personal laptop on around the clock? This project explores an on-demand cloud path, with a lightweight starter distilled from work on cloud-hosted chatbots.

- **What you want to build:** An AI chat assistant that can receive messages 24/7, start processing on demand, and scale its running instances to zero when idle to reduce resource use.
- **What this project provides:** Basic code for receiving messages, keeping conversations separate, tracking progress, preparing replies, and handling failures, plus a simulated example you can run locally.
- **What you still need to add:** Real AI, Telegram, cloud storage, and a task queue, followed by deployment and verification. Adding an account is not enough to start chatting yet.

“Receive messages anytime, work on demand, rest when idle” describes the intended use and deployment direction. **The public repository currently contains an experimental reliability starter with no third-party dependencies and an offline demo. The full cloud chat service is not connected yet.**

**Cost and latency:** Total cost depends on usage, free-tier allowances and conditions, model APIs, storage, and other services. There is no guarantee of lower costs than buying hardware or of zero cost. On-demand startup can also mean waiting for a cold start.

**Privacy boundaries:** A dedicated cloud project and least-privilege access can help keep the bot separate from personal files and accounts when deployed. Cloud hosting is not inherently safer than running locally; provider data flows, data-handling terms, and enterprise compliance requirements still need review.

**Roadmap:** A reusable Cloud Run deployment approach, aiming for a single command, and a step-by-step guide are planned. They are not available yet, and the repository does not yet provide a complete AI bot ready to deploy and use.

## What does it do, in plain language?

Think of it as the message-handling foundation behind a chat assistant. The AI produces a reply. This foundation keeps track of who sent the message, which conversation it belongs to, how far processing got, and whether a reply has already been sent.

The basic flow is:

```text
Receive a message → Check permission → Record progress → Prepare a reply → Send it
                                                    If the outcome is uncertain → Pause for review
```

For example, when you send “Hello”:

1. The entry point checks the request and sender against its configuration.
2. It puts the message in the right conversation, records progress, and recognizes duplicates.
3. It generates a reply and commits that reply together with the conversation's Markdown memory text.
4. It checks permission again before sending, then records the result.
5. If a timeout or interruption leaves it unclear whether an action ran or a reply was sent, it pauses that conversation for review rather than blindly repeating the action.

In the current demo, the “AI” only produces `Synthetic reply: Hello`, and sending means adding it to an in-memory list on your computer. This lets you understand and test the flow without contacting a real AI service or Telegram.

## How can it receive messages all day and still rest when idle?

The intended setup lets the chat platform call a cloud endpoint when a message arrives, which starts processing on demand. When idle, the cloud platform can reduce running instances to zero. This is **scale-to-zero: keeping no running instances when there are no requests**. Cloud Run supports this deployment pattern; see its [official autoscaling documentation](https://docs.cloud.google.com/run/docs/about-instance-autoscaling).

This can reduce idle computing resource use. Starting an instance again takes time, called a cold start, so receiving messages around the clock does not mean every reply is instant. The platform decides when to scale down. Zero running instances also does not mean zero total cost for AI, storage, queues, and other services.

These are goals for a future deployment. The repository's Cloud Run configuration is still an illustrative placeholder. Real 24/7 reception, automatic wake-up, and cloud recovery have not been verified, and there is no high-availability or response-time guarantee.

## What can you use today?

- **Run now:** A local simulated flow with no external services, automated tests, and a single-writer file snapshot tool.
- **Learn from and adapt:** Message intake, conversation isolation, duplicate handling, committing replies and memory together, recovery, and pausing uncertain work.
- **Still to build:** Real AI and Telegram messaging, persistent cloud storage, reliable task wake-up, identity and permission configuration, and full verification after deployment.

The two startup commands serve different purposes:

| Command | Actual behavior |
| --- | --- |
| `npm start` | Starts a smoke-check service: health checks return 200; all business requests return 503. This confirms the program can start. |
| `npm run demo` | Starts a local simulation: intake checks → in-memory inbox/queue → conversation processing → simulated reply → local list. |

It is useful for developers learning how a lightweight chat assistant can run on demand and handle failures. To get a working chatbot, you still need to connect the real services listed above.

## Run it offline in five minutes

Use Node 22 or newer. Run these commands in the repository directory. No `npm install` or real token (account access key) is needed; the code uses only the Node standard library.

```sh
npm test
npm run check
npm run demo
```

`npm test` runs the tests. `npm run check` runs all tests and checks JavaScript syntax in `src/` and `test/`. `npm run demo` starts the simulated service.

In another terminal, send this made-up message. The request only reaches your own computer:

```sh
curl -s http://127.0.0.1:8081/telegram/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: synthetic-webhook-secret-for-testing' \
  -d '{"update_id":1,"message":{"message_id":1,"chat":{"id":101,"type":"private"},"from":{"id":101,"is_bot":false},"text":"Hello"}}'
```

The response includes `accepted:true`, `duplicate:false`, and `responses`. The simulated reply is `Synthetic reply: Hello`.

- Repeat the same request and you get `duplicate:true`; the local list still contains only one reply.
- Keep the same ID but change the text and you get 409, a content conflict.
- `accepted:true` only means admission and enqueue succeeded. It is not a delivery receipt. Revoked permission or quarantined work can leave an accepted message without a reply.
- `responses` is the process's accumulated list of simulated replies, not a record of real Telegram delivery.

The demo listens only on `127.0.0.1`, makes no model or tool calls, and loses its state when it exits. File snapshots require a separate, explicit call; **they do not automatically save the demo's data**. The demo and recovery tests use the same message-processing code.

## What has been verified?

Local verification used Node 24.19.0. In the [GitHub Actions run](https://github.com/alanxiaofeifei/companion-cloud-starter/actions/runs/38040623502) for published commit `7aa6798a7e8754cd8edf70552e341783eed6b4a6`, both Node 22 and Node 24 passed 55 tests and syntax checks for 15 files. These results establish that the offline checks passed for that exact commit, not that real cloud integration is complete.

You can also run specific checks:

```sh
node --test test/http.test.mjs
node --test test/recovery.test.mjs
node --test test/privacy.test.mjs test/release.test.mjs
```

Recovery tests write real files and start new Node processes to verify that:

- Saved `PREPARED` state (reply ready) can continue to sending without calling the reply generator again.
- Saved `SENT` state (send result recorded) does not send again.
- Interrupted processing or sending, calls that continue after a timeout, capacity limits, scope mismatches, and corrupt snapshots are rejected or quarantined under the relevant rules.

File recovery requires the old writer to be stopped first. Other failure points are simulated by throwing exceptions. OS-level forced termination, power loss, and real cloud restarts have not been tested. Real models, Telegram, cloud SDKs, IAM (cloud identity and permissions), and the complete user chat flow remain unverified.

## Boundaries developers should know

### Intake, permissions, and conversations

Before reading the body, the HTTP entry point checks the method, path, and webhook secret (a value carried by the request to check the channel). A matching secret only shows that the request holds that value. It cannot by itself prove the request came from Telegram, or grant a chat member permission.

After those checks pass, the body is read as a stream with a 64 KiB limit. Invalid JSON, oversized bodies, aborted requests, and body-read timeouts are handled. Some body data may already have been read when the limit is exceeded; it is not then parsed as a normal message.

Private chats, groups, and group topics have separate conversation scopes according to configuration. Current permission is checked again before execution and before sending. Scope isolation (keeping conversation data separate) is not a file or network sandbox for tools.

### Replies, memory, and recovery

`runTurn(turn, {signal, deadlineMs, memoryMarkdown})` returns `{text, memoryMarkdown}`. The provider (reply generator) proposes a reply and memory text. The ledger (processing-progress record) commits both atomically at one revision (version), then enters `PREPARED`.

`MemoryState` only guarantees this joint commit within the running process; it does not survive exit. A provider's own `durable:true` claim is not proof of storage either. Durable saving needs a real persistent transaction adapter or an explicitly completed file snapshot.

Recovery relies on confirmed saved progress: `PREPARED` reuses the reply; `SENT` does not resend. Uncertain execution or delivery enters `QUARANTINED` (paused for review), blocking later work in the same conversation. There is currently no automatic way to clear quarantine. This is not a guarantee of zero loss or zero duplicates.

Memory currently means passing, committing, and restoring Markdown text within a conversation scope. Full product features such as extracting long-term preferences or correcting old memories are not implemented.

### Capacity and services still to connect

- The ledger holds at most 100 turns (message-processing records) per conversation. Its JSON UTF-8 hard limit is 850000 bytes. Admission and reply checkpoints have a budget of 848976 bytes, leaving room for state management. Growth beyond the limit is rejected. Deduplication records are not automatically deleted, and there is no archive system.
- Firestore/GCS are injectable interfaces tested with SDK fakes (simulated SDKs). No real SDK is installed. GCS object creation currently returns only a digest, so it cannot yet establish a trusted recovery pointer (a record selecting a committed backup).
- Real AI, Telegram, IAM, queues, OAuth, Secret Manager, and cloud persistence are not connected or verified. `HermesRuntime` still explicitly throws a “not implemented” error. The repository does not distribute Hermes code, schemas, fixtures, or instruction text.

## Read more

The detailed documents below are currently in Chinese.

- [Architecture](docs/ARCHITECTURE.md): how the parts connect and where permissions are checked
- [Recovery](docs/RECOVERY.md): progress, failures, and file snapshots
- [Runbook](docs/RUNBOOK.md): local checks, cloud responsibilities, verified official behavior, and remaining validation
- [Engineering trade-offs](docs/LESSONS.md): why these choices were made
- [Detailed Chinese engineering notes](docs/ENGINEERING_NOTES.zh-CN.md): problems, designs, and test evidence

## Origin and license

This is a small original implementation in the [public experimental reference repository](https://github.com/alanxiaofeifei/companion-cloud-starter). All public examples are synthetic. They contain no private chat history, identity records, real cloud configuration, or operational records.

It is MIT-licensed and retains the public maintainer attribution in [LICENSE](LICENSE) and [NOTICE](NOTICE). No new upstream materials are included, and no official integration endorsement from the named platforms or projects is implied.
