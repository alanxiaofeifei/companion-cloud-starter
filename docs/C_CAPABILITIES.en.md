# C capability reference: images, public web, and citations

[中文](C_CAPABILITIES.zh-CN.md) | [English](C_CAPABILITIES.en.md)

This optional, dependency-free reference preserves reusable boundaries for current-message images and public-web answers. It does not connect the starter to a model, browser, image decoder, Telegram, or a cloud gateway. Importing these modules does not change `npm start`, the synthetic demo, the worker, or its memory behavior. No deployment, successful live search, or end-to-end chat experience is implied.

## What is included

- `src/capabilities.mjs`: explicit current-message search admission, photo-metadata selection, and a strict image-envelope validator that requires a trusted full-byte decoder.
- `src/web-sources.mjs`: a fixed-turn completed-event adapter, bounded source collection, server-rendered citations, and independent output/metadata consistency checks.
- Two synthetic test suites. Their injected image decoder is deliberately fake; passing those tests does not establish real PNG/JPEG decoding or provider integration.

Run locally with Node 22 or newer, without installing anything:

```sh
node --test test/capabilities.test.mjs test/web-sources.test.mjs
npm run check
```

Tests use standard-library primitives and synthetic fixtures. The repository's complete check includes its existing local HTTP/recovery tests. There is no new external network transport, model call, runtime installer, or cloud command.

## Current-message admission

`admitWeb(text)` returns `{kind: 'query', query}`, `{kind: 'none'}`, or `{kind: 'refused'}`. Supported examples include `/web public astronomy`, `search the web for public astronomy`, and `联网搜索 公开天文知识`. The predicate is anchored to a single current message. It rejects CR/LF, empty or oversized requests, and several obvious credential/private-context patterns.

This heuristic cannot detect every private fact. An integrating application must authorize external transmission independently and must not append private history, memory, profile material, files, or hidden context to a public-search request. Natural-language requests outside the accepted forms do not activate search. A model saying it can or cannot browse is not runtime evidence; follow-up questions and conversational continuity require separate routing and testing.

## Image adapter contract

`selectPhoto(variants)` selects the largest eligible current-message photo, breaking equal-area ties by file ID. It returns a frozen metadata copy and discards unknown fields. Metadata is not a download authorization or an image-validation result.

Bounds: at most 100 variants; positive integral dimensions up to 2048 on either side and 4,194,304 pixels; declared size at most 1 MiB when supplied. IDs are opaque bounded strings, not URLs or local paths.

`createImageValidator({decodeImage})` requires an application-owned decoder callback. Omitting it fails closed. `validate(envelope, {signal, deadlineAt})` accepts exactly:

```js
{
  mime: 'image/png', // or image/jpeg
  base64: '<canonical base64 of the exact bytes>',
  byteLength: 123, // exact positive byte count, at most 1 MiB
  sha256: '<lowercase SHA-256 of those bytes>'
}
```

The example is a schema illustration, not valid image data. Canonical base64, exact length, and SHA-256 establish envelope consistency only. They do not prove that bytes form an image. The callback must fully decode those exact bytes, reject truncation and unsupported features, respect the provided byte/pixel/dimension limits, and return exactly `{mime, width, height}`. Header inspection or caller-supplied “validated” objects are insufficient. The wrapper checks the returned type/dimensions and rejects callback mutation of its byte copy.

The callback is trusted application code, never code supplied by a request or model. No decoder is distributed here and no format is accepted without calling it. A real adapter must additionally fence authorization before download/model dispatch, use an approved fixed transport, reject redirects as appropriate, cap streamed bytes, compare platform metadata with decoded dimensions, and keep credentials and file URLs out of logs.

There is one active decode and at most one queued decode per validator instance, with a maximum five-second wrapper deadline. Cancellation returns promptly but retains the active slot until the underlying callback settles. A callback that never settles blocks that instance. Cancellation is cooperative; this is not a native-memory/process sandbox. Use a singleton per worker and a genuinely bounded decoder or isolated decoding process in an actual integration.

## Completed sources and citation rendering

Construct one `TurnWebSources({threadId, turnId})` for server-known, nonempty identifiers. The application must authenticate its provider transport and bind events before passing them here. The following is an application adapter contract, not a declaration of a provider's native wire format:

```js
import {TurnWebSources, validRenderedWebEvidence} from '../src/web-sources.mjs';

const sources = new TurnWebSources({threadId: 'synthetic-thread', turnId: 'synthetic-turn'});
sources.observeCompleted({
  threadId: 'synthetic-thread', turnId: 'synthetic-turn', status: 'completed',
  item: {
    id: 'synthetic-item', type: 'webSearch', action: 'search',
    results: [{type: 'text_result', ref_id: 'ref-a', url: 'https://example.com/', title: 'Synthetic source'}]
  }
});
const answer = sources.render('A synthetic statement [[source:ref-a]]', 4096);
if (!validRenderedWebEvidence(answer.evidence, answer.text, 4096)) throw new Error('reject');
```

Run an equivalent example from a module in `docs/`, or adjust the import for your location. All values above are fictional fixtures. The code makes no request. Merely matching JSON fields cannot establish provenance: an untrusted caller can forge them. Do not expose `observeCompleted` as a public HTTP acceptance endpoint.

Each completed item is fingerprinted. Replays with identical content are deduplicated; conflicting IDs, foreign/incomplete events, malformed event shapes, and over-budget input block that collector. At most four distinct items are admitted. At least one completed `search` is required; `openPage`/`findInPage` observations alone do not qualify. These action names only describe observations and do not perform operations.

Only the flat `text_result` subset is decoded. Unknown extra row fields are bounded then discarded. Missing/invalid source metadata poisons completeness even if the model did not cite that row. Limits remain 64 source records, 32 citation occurrences, 32 KiB serialized source/citation metadata, 256 title codepoints, and 2048 URL characters. Events are bounded to 64 KiB, depth 12, and 16,000 nodes before interpretation.

The model supplies `[[source:ref-a]]` markers, never final URLs. The server numbers references by first appearance and appends the authoritative source URL list. Unknown references, malformed markers, pre-numbered citations, model-authored URLs, and conservative bare-link candidates are rejected. Exact `HH:MM:SS` clocks remain valid prose; IPv6 literals and clock-like strings outside that strict form remain blocked. Conservative DNS detection can reject ordinary dotted names such as filenames; this is an intentional fail-closed limitation.

Source URL checks are syntactic: canonical HTTPS with a DNS-shaped public name, no userinfo, custom port, obvious credential material, IP literal, or listed local suffix. They do not perform DNS resolution, prevent DNS rebinding/redirect attacks, assess page safety, detect all private data, or establish that a claim is supported. The footer explicitly says claim support is unverified. Titles are metadata and do not enter the rendered footer.

`validRenderedWebEvidence` checks internal consistency, limits, reference binding, and the exact footer. It cannot authenticate serialized evidence or verify source content. Validate at each application boundary without turning consistency metadata into an authentication token or an operational proof.

## Integration and operations checklist

1. Keep capabilities disabled until an authorized provider/transport/decoder adapter exists. Configure deployment-specific values outside source control; this reference needs no account settings.
2. Admit only the current request. Separate image analysis from public-search turns and do not let image text or web content authorize additional tools.
3. Fence permissions before effects and again before sending. Do not use a model's capability claim as a routing decision.
4. Authenticate, bind, and bound completed provider events. Unknown provider result shapes must fail closed until reviewed; never synthesize citations from model text.
5. Store only the minimum necessary diagnostics. Use fixed rejection codes, not request bodies, image bytes, provider stderr, account details, or credential-bearing URLs.
6. Test a real image, a supported explicit web command, an unsupported natural-language command, a follow-up, unsafe metadata, cancellation, and retry ambiguity in the actual destination. Verify the returned source metadata and the delivered message separately.
7. If any layer is missing or rejects the result, report the limitation honestly. Do not relabel transport presence, isolation checks, or offline test success as successful browsing or user-chat acceptance.
8. Roll back this optional reference by removing its imports/adapters. It is not wired into the starter and does not change existing state formats or deployment behavior.

## Deliberate extraction adaptations

The public slice uses JavaScript modules and standard-library dependencies only. It adds input-type/CRLF guards, bounded photo metadata copies, a mandatory injected-decoder seam, private source-map fields, an explicit fixed-turn adapter, event budgets, and validated output-length parameters. It renames the generic metadata version to `public-web-results/v1`. The core admission patterns, source URL/reference/title predicates, citation mapping rules, conservative link filter, strict-clock exemption, and source/citation budgets are retained. No private configuration, operator history, runtime receipts, provider implementation, or successful integration claim is part of this reference.
