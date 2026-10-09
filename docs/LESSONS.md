# Reusable engineering lessons

- Extract trust boundaries and contracts before copying the whole application. A clean, small template is easier to review than a private-history fork.
- Keep the familiar Telegram experience and the model runtime separate. Replacing inference must not silently replace identity checks or private/group boundaries.
- Measure native functionality separately from simulated adapters. A passing text response does not establish web, vision, persistence, queue delivery or fallback readiness.
- Natural memory correction can work while over-memory remains a risk. Validate corrections across fresh processes and distinguish a one-off preference from a durable preference.
- Background memory review requires a lifecycle that survives request completion and scale-to-zero. A successful foreground turn does not certify a background review.
- Immutable snapshots need generation, checksum, consistent SQLite backup and a committed restoration pointer. Keeping a file in object storage is not a complete restore design.
- Compare like-for-like measurements. Image bytes, main-process RSS, process-tree memory and container working set are different quantities; cold and warm latency boundaries differ.
- Recovery needs explicit uncertainty. A remote send can succeed even if its response disappears; neither retries nor deterministic queue names create exactly-once delivery.
- Keep release notes useful without carrying private evidence into public artifacts. Publish synthetic cases and precise limitations, not raw conversations, personal configurations or account usage snapshots.
- Do not bypass TLS verification or blocked credential access to make a demo pass. A blocked optional integration should remain an honest blocker.

These are generalized design lessons, not a benchmark report or claim that this scaffold has production validation.
