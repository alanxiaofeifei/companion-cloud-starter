import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
class GatewayError extends Error {
  constructor(code, reason) { super('Web capability rejected.'); this.code = code; this.reason = reason; }
}
const record = v => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Transport provenance only: this never asserts that a source supports an answer's claims. */

export const SOURCE_LIMITS = Object.freeze({ records: 64, metadataBytes: 32768, citations: 32 });
export const SOURCE_FOOTER = '\n\nSources (observed search results; claim support unverified):\n';
export const sourceRef = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
export const sourceTitle = (v) => typeof v === 'string' && v.trim().length > 0 && Array.from(v).length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(v);
export function sourceUrl(v) {
  if (typeof v !== 'string' || v.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(v)) return false;
  try {
    const u = new URL(v);
    const decoded = decodeURIComponent(v);
    const credentialKey = /^(?:authorization|access_token|refresh_token|id_token|api_key|password|client_secret|cookie|set-cookie|token)$/iu;
    if ([...u.searchParams.keys()].some(k => credentialKey.test(k)) || /\b(?:authorization|access_token|refresh_token|id_token|api_key|password|client_secret|cookie|set-cookie|token)\s*[:=]|\bBearer\s+/iu.test(decoded) || /[\u0000-\u001f\u007f]|\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9._-]{8,})|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/u.test(decoded)) return false;
    return u.href === v && u.protocol === 'https:' && !u.username && !u.password && !u.port
      && u.hostname.length <= 253 && u.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label))
      && /^[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(u.hostname) && !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(u.hostname);
  } catch { return false; }
}
/** Plain-text clients may auto-link bare hosts; model bodies cannot create those links either. */
export function hasBareLinkCandidate(text) {
  const dns = /(?:^|[^\p{L}\p{N}_-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}]{2,63}(?=$|[^\p{L}\p{N}_-])/iu;
  const ipv4 = /(?:^|[^\p{L}\p{N}.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?=$|[^\p{L}\p{N}.])/iu;
  const ipv6 = /(?:^|[\s[(])((?:[a-f0-9]{0,4}:){2,}[a-f0-9:.]{0,39})(?=$|[\s\])/])/giu;
  if (dns.test(text) || ipv4.test(text)) return true;
  for (const match of text.matchAll(ipv6)) {
    const candidate = match[1];
    // Exempt only an entire strict clock, never other conservative link candidates.
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(candidate) || isIP(candidate) === 6) return true;
  }
  return false;
}

const invalid = (reason) => { throw new GatewayError('output_invalid', reason); };

/** Internal source map; callers enter through the fixed-turn wrapper below. */
class NativeSourceMap {
  #sources = new Map();
  #complete = true;
  #firstIncompleteReason;
  #citations = [];

  incomplete(reason) {
    this.#complete = false;
    this.#firstIncompleteReason ??= reason;
  }

  observe(results, itemSha256) {
    if (!/^[a-f0-9]{64}$/.test(itemSha256)) throw new GatewayError('tool_activity_blocked', 'web_shape_or_limit');
    if (!Array.isArray(results)) { this.incomplete('citation_metadata_shape'); return; }
    for (const value of results) {
      // The adapter contract supports only the bounded flat text-result subset.
      // Unknown extra fields are neither interpreted nor copied; caller already bounded the full JSON.
      if (!record(value)) { this.incomplete('citation_row_shape'); continue; }
      if (value.type !== 'text_result') { this.incomplete('citation_row_type'); continue; }
      if (!sourceRef(value.ref_id)) { this.incomplete('citation_ref_invalid'); continue; }
      if (!sourceUrl(value.url)) { this.incomplete('citation_url_invalid'); continue; }
      if (!sourceTitle(value.title)) { this.incomplete('citation_title_invalid'); continue; }
      const next = { refId: value.ref_id, url: value.url, title: value.title, itemSha256 };
      const prior = this.#sources.get(next.refId);
      if (prior) {
        if (prior.url !== next.url || prior.title !== next.title) throw new GatewayError('tool_activity_blocked', 'web_shape_or_limit');
        continue;
      }
      if (this.#sources.size >= SOURCE_LIMITS.records) { this.incomplete('citation_source_limit'); continue; }
      const all = [...this.#sources.values(), next];
      if (Buffer.byteLength(JSON.stringify({ ...this.snapshot(), sources: all })) > SOURCE_LIMITS.metadataBytes) { this.incomplete('citation_source_metadata_limit'); continue; }
      this.#sources.set(next.refId, next);
    }
  }

  snapshot() {
    return { version: 'public-web-results/v1', transport: 'completed_same_turn', metadataComplete: this.#complete && this.#sources.size > 0,
      sources: [...this.#sources.values()].map(s => ({ ...s })), citations: this.#citations.map(c => ({ ...c })) };
  }

  render(text, maxChars) {
    if (typeof text !== 'string' || !text.trim() || text.length > 200000 || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 200000) return invalid('citation_final_text_limit');
    if (!this.#complete) return invalid(this.#firstIncompleteReason ?? 'citation_metadata_incomplete');
    if (this.#sources.size === 0) return invalid('citation_sources_absent');
    if (/[\uE200-\uE202]|\b(?:https?|ftp|file|mailto|javascript|data|tel):|\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\]\s*\(|\[\d+\]/iu.test(text)) return invalid('citation_raw_syntax');
    const citations = new Map();
    let count = 0;
    const rendered = text.replace(/\[\[source:([A-Za-z0-9_.:-]{1,128})\]\]/gu, (_marker, refId) => {
      if (++count > SOURCE_LIMITS.citations) return invalid('citation_count_limit');
      const source = this.#sources.get(refId);
      if (!source) return invalid('citation_unknown_ref');
      let citation = citations.get(refId);
      if (!citation) { citation = { ordinal: citations.size + 1, refId, itemSha256: source.itemSha256 }; citations.set(refId, citation); }
      return `[${citation.ordinal}]`;
    });
    if (!count) return invalid('citation_missing_marker');
    if (hasBareLinkCandidate(rendered)) return invalid('citation_bare_link');
    if (/\[\[|\]\]|\[source:/iu.test(rendered)) return invalid('citation_malformed_marker');
    const footer = [...citations.values()].map(c => { const s = this.#sources.get(c.refId); return `[${c.ordinal}] ${s.url}`; }).join('\n');
    const final = rendered + SOURCE_FOOTER + footer;
    if (final.length > maxChars) return invalid('citation_final_text_limit');
    const evidence = { ...this.snapshot(), citations: [...citations.values()] };
    if (Buffer.byteLength(JSON.stringify(evidence)) > SOURCE_LIMITS.metadataBytes) return invalid('citation_metadata_limit');
    this.#citations = evidence.citations;
    return final;
  }
}

const exact = (v, fields) => record(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
/** Pure consistency validation. Serialized metadata alone does not establish transport provenance. */
export function validRenderedWebEvidence(value, text, maxChars = 6144) {
  try {
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 200000) return false;
    if (!exact(value, ['policy', 'completedSearches', 'sourceAttribution', 'nativeSources']) || value.policy !== 'public-web-v1' || value.sourceAttribution !== 'unverified' || !Number.isInteger(value.completedSearches) || Number(value.completedSearches) < 1 || Number(value.completedSearches) > 4) return false;
    const n = value.nativeSources;
    if (!exact(n, ['version', 'transport', 'metadataComplete', 'sources', 'citations']) || n.version !== 'public-web-results/v1' || n.transport !== 'completed_same_turn' || n.metadataComplete !== true || !Array.isArray(n.sources) || n.sources.length < 1 || n.sources.length > 64 || !Array.isArray(n.citations) || n.citations.length < 1 || n.citations.length > 32 || Buffer.byteLength(JSON.stringify(n)) > 32768) return false;
    const sources = new Map();
    for (const s of n.sources) {
      if (!exact(s, ['refId', 'url', 'title', 'itemSha256']) || !sourceRef(s.refId) || !sourceUrl(s.url) || !sourceTitle(s.title) || typeof s.itemSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(s.itemSha256) || sources.has(s.refId)) return false;
      sources.set(s.refId, s);
    }
    const refs = new Set (); const urls = [];
    for (const [index, c] of n.citations.entries()) {
      if (!exact(c, ['ordinal', 'refId', 'itemSha256']) || c.ordinal !== index + 1 || !sourceRef(c.refId) || refs.has(c.refId) || sources.get(c.refId)?.itemSha256 !== c.itemSha256) return false;
      refs.add(c.refId); urls.push(`[${index + 1}] ${sources.get(c.refId) .url}`);
    }
    const footer = SOURCE_FOOTER + urls.join('\n');
    if (typeof text !== 'string' || text.length > maxChars || !text.endsWith(footer)) return false;
    const body = text.slice(0, -footer.length);
    if (!body.trim() || hasBareLinkCandidate(body) || /[\uE200-\uE202]|\b[a-z][a-z0-9+.-]*:\/\/|\b(?:https?|ftp|file|mailto|javascript|data|tel):|\bwww\.|\]\s*\(|\[\[|\]\]|\[source:/iu.test(body)) return false;
    const seen = new Set (); let count = 0;
    for (const m of body.matchAll(/\[(\d+)\]/gu)) {
      const i = Number(m[1]);
      if (++count > 32 || String(i) !== m[1] || i < 1 || i > n.citations.length) return false;
      if (!seen.has(i)) { if (i !== seen.size + 1) return false; seen.add(i); }
    }
    return seen.size === n.citations.length;
  } catch { return false; }
}

/** Fixed-turn adapter seam, not authentication. Supply only authenticated transport events.
 * Input JSON: {threadId, turnId, status:'completed', item:{id,type:'webSearch',action,results}}.
 * action is 'search', 'openPage', or 'findInPage'; no network operation is performed here.
 */
export class TurnWebSources {
  #threadId; #turnId; #native = new NativeSourceMap(); #items = new Map(); #searches = 0; #blocked = false;
  constructor({threadId, turnId} = {}) {
    if (!sourceRef(threadId) || !sourceRef(turnId)) throw new GatewayError('tool_activity_blocked', 'web_binding_invalid');
    this.#threadId = threadId; this.#turnId = turnId;
  }
  observeCompleted(event) {
    try {
      boundEventJson(event);
      if (this.#blocked || !exact(event, ['threadId', 'turnId', 'status', 'item']) || event.threadId !== this.#threadId || event.turnId !== this.#turnId || event.status !== 'completed') throw new Error();
      const item = event.item;
      if (!exact(item, ['id', 'type', 'action', 'results']) || !sourceRef(item.id) || item.type !== 'webSearch' || !['search', 'openPage', 'findInPage'].includes(item.action)) throw new Error();
      const fingerprint = createHash('sha256').update(JSON.stringify(item)).digest('hex');
      if (this.#items.has(item.id)) {
        if (this.#items.get(item.id) !== fingerprint) throw new Error();
        return;
      }
      if (this.#items.size >= 4) throw new Error();
      this.#native.observe(item.results, fingerprint);
      this.#items.set(item.id, fingerprint);
      if (item.action === 'search') this.#searches++;
    } catch {
      this.#blocked = true;
      throw new GatewayError('tool_activity_blocked', 'web_shape_or_binding');
    }
  }
  snapshot() {
    return {policy: 'public-web-v1', completedSearches: this.#searches, sourceAttribution: 'unverified', nativeSources: this.#native.snapshot()};
  }
  render(text, maxChars = 4096) {
    if (this.#blocked) throw new GatewayError('tool_activity_blocked', 'web_shape_or_binding');
    if (!this.#searches) throw new GatewayError('output_invalid', 'citation_sources_absent');
    const rendered = this.#native.render(text, maxChars);
    const evidence = this.snapshot();
    if (!validRenderedWebEvidence(evidence, rendered, maxChars)) throw new GatewayError('output_invalid', 'citation_metadata_incomplete');
    return {text: rendered, evidence};
  }
}
// Bound depth, node count, and bytes before interpreting unknown result fields.
function boundEventJson(value) {
  let nodes = 0;
  const visit = (v, depth) => {
    if (++nodes > 16000 || depth > 12) throw new Error();
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'string') { if (v.length > 65536) throw new Error(); return; }
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error(); return; }
    if (!v || typeof v !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(v))) throw new Error();
    for (const [key, child] of Object.entries(v)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error();
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw new Error();
}
