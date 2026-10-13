import test from 'node:test';
import assert from 'node:assert/strict';
import {TurnWebSources, validRenderedWebEvidence, hasBareLinkCandidate, sourceUrl, SOURCE_LIMITS, SOURCE_FOOTER} from '../src/web-sources.mjs';
const row = (fields = {}) => ({type: 'text_result', ref_id: 'ref-a', url: 'https://example.com/', title: 'Synthetic source', ...fields});
const event = (fields = {}) => ({threadId: 'synthetic-thread', turnId: 'synthetic-turn', status: 'completed', item: {id: 'synthetic-item', type: 'webSearch', action: 'search', results: [row()]}, ...fields});
const empty = () => new TurnWebSources({threadId: 'synthetic-thread', turnId: 'synthetic-turn'});
const ready = (rows = [row()]) => { const map = empty(); map.observeCompleted(event({item: {...event().item, results: rows}})); return map; };
const reason = wanted => error => error.message === 'Web capability rejected.' && error.reason === wanted;
const body = 'At 12:30:00 UTC [[source:ref-a]]';

test('fixed-turn completed source renders server-owned links with explicit uncertainty', () => {
  const map = ready(), result = map.render(body);
  assert.equal(result.text, 'At 12:30:00 UTC [1]' + SOURCE_FOOTER + '[1] https://example.com/');
  assert.equal(validRenderedWebEvidence(result.evidence, result.text), true);
  assert.equal(result.evidence.sourceAttribution, 'unverified');
  assert.equal(result.evidence.nativeSources.transport, 'completed_same_turn');
  assert.equal(result.evidence.nativeSources.version, 'public-web-results/v1');
  assert.equal(result.evidence.nativeSources.citations[0].itemSha256, result.evidence.nativeSources.sources[0].itemSha256);
});
test('missing, malformed, and foreign turn bindings fail closed', () => {
  for (const binding of [undefined, {}, {threadId: '', turnId: 't'}, {threadId: 't', turnId: 'x'.repeat(129)}]) assert.throws(() => new TurnWebSources(binding));
  for (const change of [{threadId: 'other'}, {turnId: 'other'}, {status: 'started'}, {extra: true}, {item: null}]) {
    const map = ready(); assert.throws(() => map.observeCompleted(event(change)), reason('web_shape_or_binding'));
    assert.throws(() => map.render(body), reason('web_shape_or_binding'));
  }
});
test('completed-item replay deduplicates, conflicts block the turn, and four is the ceiling', () => {
  const map = ready(); map.observeCompleted(event()); assert.equal(map.snapshot().completedSearches, 1);
  for (let i = 1; i < 4; i++) map.observeCompleted(event({item: {...event().item, id: `synthetic-item-${i}`}}));
  assert.equal(map.snapshot().completedSearches, 4); assert.ok(map.render(body));
  assert.throws(() => map.observeCompleted(event({item: {...event().item, id: 'synthetic-item-5'}})), reason('web_shape_or_binding'));
  const conflict = ready(); assert.throws(() => conflict.observeCompleted(event({item: {...event().item, results: [row({title: 'Changed'})]}})), reason('web_shape_or_binding'));
});
test('opening or finding a page alone does not count as a completed search', () => {
  const map = empty(); map.observeCompleted(event({item: {...event().item, action: 'openPage'}}));
  assert.equal(map.snapshot().completedSearches, 0); assert.throws(() => map.render(body), reason('citation_sources_absent'));
  map.observeCompleted(event({item: {...event().item, id: 'synthetic-search'}})); assert.ok(map.render(body));
});
test('opaque extra result fields are ignored and never copied to evidence', () => {
  const map = ready([row({ignored: {text: 'SYNTHETIC_CONTENT_CANARY'}})]), result = map.render(body);
  assert.equal(JSON.stringify(result).includes('CANARY'), false);
  assert.equal(Object.keys(result.evidence.nativeSources.sources[0]).length, 4);
});
test('malformed uncited result poisons metadata and cannot be repaired with a later valid item', () => {
  for (const [bad, expected] of [[null, 'citation_row_shape'], [row({type: 'other'}), 'citation_row_type'], [row({ref_id: ''}), 'citation_ref_invalid'], [row({url: 'http://example.com/'}), 'citation_url_invalid'], [row({title: ''}), 'citation_title_invalid']]) {
    const map = ready([row(), bad]); assert.equal(map.snapshot().nativeSources.metadataComplete, false);
    map.observeCompleted(event({item: {...event().item, id: 'later'}})); assert.throws(() => map.render(body), reason(expected));
  }
  assert.throws(() => ready(null).render(body), reason('citation_metadata_shape'));
  assert.throws(() => ready([]).render(body), reason('citation_sources_absent'));
});
test('duplicate source bindings retain first identity, conflicting bindings block', () => {
  const map = ready(), first = map.snapshot().nativeSources.sources[0].itemSha256;
  map.observeCompleted(event({item: {...event().item, id: 'second'}}));
  assert.equal(map.snapshot().nativeSources.sources.length, 1); assert.equal(map.snapshot().nativeSources.sources[0].itemSha256, first);
  assert.throws(() => map.observeCompleted(event({item: {...event().item, id: 'third', results: [row({url: 'https://example.org/'})]}})), reason('web_shape_or_binding'));
});
test('source URL policy rejects credentials, local addresses, noncanonical and malformed URLs', () => {
  for (const url of ['http://example.com/', 'https://user:pass@example.com/', 'https://localhost/', 'https://a.internal/', 'https://127.0.0.1/', 'https://[::1]/', 'https://example.com:8443/', 'https://EXAMPLE.com/', 'https://example.com', 'https://example.com/%ZZ', 'https://example.com/?token=synthetic', 'https://example.com/%0A', 'javascript:example', 'https://example.com/' + 'x'.repeat(2048)]) assert.equal(sourceUrl(url), false, url);
  assert.equal(sourceUrl('https://example.com/path?q=public#section'), true);
  assert.equal(sourceUrl('https://example.org/'), true);
});
test('source titles enforce codepoint and control limits without entering footer', () => {
  assert.ok(ready([row({title: '🐈'.repeat(256)})]).render(body));
  for (const title of ['', ' ', 'x\ny', 'x'.repeat(257), null]) assert.throws(() => ready([row({title})]).render(body), reason('citation_title_invalid'));
  assert.equal(ready([row({title: 'SYNTHETIC_TITLE_CANARY'})]).render(body).text.includes('CANARY'), false);
});
test('source record and metadata byte budgets are preserved', () => {
  assert.ok(Object.isFrozen(SOURCE_LIMITS));
  const rows = Array.from({length: 64}, (_, i) => row({ref_id: `r${i}`}));
  assert.ok(ready(rows).render('A [[source:r0]]'));
  assert.throws(() => ready([...rows, row({ref_id: 'r64'})]).render('A [[source:r0]]'), reason('citation_source_limit'));
  const large = Array.from({length: 32}, (_, i) => row({ref_id: `r${i}`, url: `https://example.com/${'x'.repeat(1200)}/${i}`, title: 'x'.repeat(256)}));
  assert.throws(() => ready(large).render('A [[source:r0]]'), reason('citation_source_metadata_limit'));
});
test('event depth, byte size, shapes, and prototype keys are bounded', () => {
  const nested = {}; let cursor = nested; for (let i = 0; i < 14; i++) cursor = cursor.child = {};
  for (const results of [[row({extra: 'x'.repeat(65537)})], [row({extra: nested})], [row({extra: Infinity})], [row({extra: () => 'no'})], [JSON.parse('{"__proto__":{}}')]]) {
    const map = empty(); assert.throws(() => map.observeCompleted(event({item: {...event().item, results}})), reason('web_shape_or_binding'));
  }
  for (const item of [{...event().item, action: 'shell'}, {...event().item, type: 'other'}, {...event().item, id: ''}, {...event().item, extra: true}])
    assert.throws(() => empty().observeCompleted(event({item})), reason('web_shape_or_binding'));
});
test('unknown references and model-authored link syntax are rejected', () => {
  for (const text of ['A [[source:missing]]', 'A [[source:ref-a]', 'A [source:ref-a]', 'A [1]', 'A https://example.com/ [[source:ref-a]]', 'A example.com [[source:ref-a]]', 'A [link](https://example.com/) [[source:ref-a]]', 'A \uE200ref\uE201 [[source:ref-a]]']) assert.throws(() => ready().render(text));
  assert.throws(() => ready().render('No markers'), reason('citation_missing_marker'));
});
test('citation ordinals follow first appearance and repeated references reuse ordinals', () => {
  const map = ready([row(), row({ref_id: 'ref-b', url: 'https://example.org/'})]);
  const result = map.render('B [[source:ref-b]] A [[source:ref-a]] B [[source:ref-b]]');
  assert.ok(result.text.startsWith('B [1] A [2] B [1]'));
  assert.deepEqual(result.evidence.nativeSources.citations.map(c => c.refId), ['ref-b', 'ref-a']);
  assert.ok(validRenderedWebEvidence(result.evidence, result.text));
});
test('citation occurrence and final output budgets include the server footer', () => {
  assert.ok(ready().render('[[source:ref-a]]'.repeat(32)));
  assert.throws(() => ready().render('[[source:ref-a]]'.repeat(33)), reason('citation_count_limit'));
  const result = ready().render(body);
  assert.equal(ready().render(body, result.text.length).text, result.text);
  assert.throws(() => ready().render(body, result.text.length - 1), reason('citation_final_text_limit'));
  for (const limit of [0, NaN, Infinity, -1, 200001]) assert.throws(() => ready().render(body, limit), reason('citation_final_text_limit'));
  assert.throws(() => ready().render('x'.repeat(200001)), reason('citation_final_text_limit'));
});
test('failed rendering does not commit partial citation metadata', () => {
  const map = ready(); assert.throws(() => map.render('[[source:ref-a]] [[source:missing]]'));
  assert.deepEqual(map.snapshot().nativeSources.citations, []); assert.ok(map.render(body));
});
test('snapshot and result mutations cannot alter the internal source map', () => {
  const map = ready(), snapshot = map.snapshot(); snapshot.nativeSources.sources[0].url = 'https://example.org/';
  const first = map.render(body); first.evidence.nativeSources.sources.length = 0;
  assert.equal(map.render(body).text.endsWith('https://example.com/'), true);
});
test('evidence consistency rejects forged fields, ordinals, hashes and footer changes', () => {
  const valid = ready().render(body);
  for (const mutate of [e => { e.extra = true; }, e => { e.completedSearches = 0; }, e => { e.completedSearches = 5; }, e => { e.sourceAttribution = 'verified'; }, e => { e.nativeSources.metadataComplete = false; }, e => { e.nativeSources.sources[0].extra = true; }, e => { e.nativeSources.citations[0].itemSha256 = 'b'.repeat(64); }, e => { e.nativeSources.citations[0].ordinal = 2; }, e => { e.nativeSources.sources.push(e.nativeSources.sources[0]); }, e => { e.nativeSources.citations.push(e.nativeSources.citations[0]); }]) {
    const evidence = structuredClone(valid.evidence); mutate(evidence); assert.equal(validRenderedWebEvidence(evidence, valid.text), false);
  }
  for (const text of [valid.text + '\n', valid.text.replace('[1]', '[01]'), valid.text.replace('[1]', '[2]'), valid.text.replace('https://example.com/', 'https://example.org/'), valid.text.replace('At', 'example.com At')]) assert.equal(validRenderedWebEvidence(valid.evidence, text), false);
  assert.equal(validRenderedWebEvidence(valid.evidence, valid.text, NaN), false);
});
test('clock exemption accepts every strict clock but never an adjacent IPv6 literal', () => {
  for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m++) for (let s = 0; s < 60; s++) {
    const clock = [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
    assert.equal(hasBareLinkCandidate(clock), false);
    assert.equal(hasBareLinkCandidate(`${clock} 2001:db8::1`), true);
  }
});
test('conservative bare-link rules retain DNS, IPv4, IPv6 and non-clock rejection', () => {
  for (const token of ['example.com', 'Node.js', 'README.md', '192.0.2.1', '::1', '::', '[2001:db8::1]:443', '2001:db8::1.', '::ffff:192.0.2.1', '24:00:00', '23:60:00', '12:30:60', '1:02:03', '12:30:00.', '2026:10:13']) {
    assert.equal(hasBareLinkCandidate(token), true, token);
    assert.throws(() => ready().render(`At 12:30:00 ${token} [[source:ref-a]]`), reason('citation_bare_link'));
  }
});
test('rejections carry finite reason codes without copying input content', () => {
  const map = ready();
  assert.throws(() => map.render('SYNTHETIC_PRIVATE_CANARY [[source:unknown]]'), error => {
    assert.match(error.reason, /^[a-z0-9_]{1,48}$/); assert.equal(String(error).includes('CANARY'), false); return true;
  });
});
