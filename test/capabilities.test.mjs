import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {admitWeb, selectPhoto, createImageValidator, IMAGE_MAX_BYTES} from '../src/capabilities.mjs';

// These bytes and the injected decoder are synthetic contract fixtures, not real images.
const bytes = Buffer.from('synthetic image transport fixture');
const envelope = (data = bytes, mime = 'image/png') => ({mime, base64: data.toString('base64'), byteLength: data.length, sha256: createHash('sha256').update(data).digest('hex')});
const metadata = {mime: 'image/png', width: 10, height: 20};
const photo = (fields = {}) => ({file_id: 'synthetic-b', file_unique_id: 'synthetic-unique', width: 10, height: 20, file_size: 100, ...fields});
const invalidImage = error => error.message === 'unsupported_or_invalid_image';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

test('web admission accepts only supported current-message command forms', () => {
  for (const text of ['/web public astronomy', '/web@SyntheticBot public astronomy', 'search the web for public astronomy', 'please search online for public astronomy', '联网搜索 public astronomy', '请上网搜索 public astronomy', 'hãy tìm trên web public astronomy'])
    assert.deepEqual(admitWeb(text), {kind: 'query', query: 'public astronomy'});
  for (const text of ['Can you browse?', 'Earlier: /web public astronomy', '"/web public astronomy"', 'Tell me about the web', 'Search now'])
    assert.equal(admitWeb(text).kind, 'none');
});
test('web admission refuses unsafe, multiline, empty, and oversized requests', () => {
  for (const text of ['/web', '/web\n', '/web one\ntwo', '/web\npublic topic', 'search the web for\npublic topic', '\n/web public topic', '/web public topic\r', '/web https://example.com/', '/web my account', '/web 密码', '/web 12345678', '/web x@y', '/web `quoted`', '/web ' + 'x'.repeat(513), 'x'.repeat(4097), null])
    assert.equal(admitWeb(text).kind, 'refused');
  assert.equal(admitWeb('/web ' + 'x'.repeat(512)).kind, 'query');
});
test('photo selection is deterministic and copies only current-message metadata', () => {
  const variants = [photo(), photo({file_id: 'synthetic-a', ignored: 'discard'}), photo({width: 2, height: 2})];
  const original = structuredClone(variants), selected = selectPhoto(variants);
  assert.equal(selected.file_id, 'synthetic-a'); assert.ok(Object.isFrozen(selected));
  assert.equal('ignored' in selected, false); assert.deepEqual(variants, original);
  variants[1].width = 999; assert.equal(selected.width, 10);
});
test('photo metadata rejects nonintegers, missing identifiers, and unsafe sizes', () => {
  for (const fields of [{width: 0}, {height: -1}, {width: 1.5}, {height: Infinity}, {width: 2049}, {file_size: 0}, {file_size: -1}, {file_size: IMAGE_MAX_BYTES + 1}, {file_id: ''}, {file_unique_id: ''}])
    assert.equal(selectPhoto([photo(fields)]), undefined);
  assert.equal(selectPhoto(null), undefined); assert.equal(selectPhoto(Array(101).fill(photo())), undefined);
  assert.equal(selectPhoto([null, {}, photo({file_size: undefined, width: 2048, height: 2048})]).width, 2048);
});
test('image validation fails closed without a trusted full-byte decoder', () => {
  for (const value of [undefined, {}, {decodeImage: true}]) assert.throws(() => createImageValidator(value), invalidImage);
});
test('canonical image envelope reaches injected decoder with fixed limits', async () => {
  let calls = 0;
  const validator = createImageValidator({decodeImage: async (value, limits) => {
    calls++; assert.deepEqual(value, bytes); assert.ok(Object.isFrozen(limits));
    assert.equal(limits.maxBytes, IMAGE_MAX_BYTES); assert.equal(limits.maxDimension, 2048); assert.equal(limits.maxPixels, 4194304);
    return metadata;
  }});
  const result = await validator.validate(envelope());
  assert.equal(calls, 1); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.payload));
  assert.deepEqual(result.payload, envelope()); assert.equal(result.width, 10);
});
test('invalid image envelopes never call the decoder', async () => {
  let calls = 0;
  const validator = createImageValidator({decodeImage: async () => { calls++; return metadata; }});
  for (const value of [null, {}, {...envelope(), extra: true}, {...envelope(), mime: 'image/gif'}, {...envelope(), byteLength: 0}, {...envelope(), byteLength: 1.5}, {...envelope(), sha256: 'a'.repeat(64)}, {...envelope(), base64: 'AA==='}, {...envelope(), base64: envelope().base64 + '\n'}, envelope(Buffer.alloc(IMAGE_MAX_BYTES + 1)), envelope(Buffer.alloc(0))])
    await assert.rejects(validator.validate(value), invalidImage);
  assert.equal(calls, 0);
});
test('image validation checks full-decoder result type and dimensions', async () => {
  for (const actual of [null, {}, {...metadata, mime: 'image/jpeg'}, {...metadata, width: 0}, {...metadata, height: 2049}, {...metadata, width: 1.5}, {...metadata, height: Infinity}, {...metadata, extra: true}]) {
    const validator = createImageValidator({decodeImage: async () => actual});
    await assert.rejects(validator.validate(envelope()), invalidImage);
  }
  const jpeg = createImageValidator({decodeImage: async () => ({mime: 'image/jpeg', width: 2048, height: 2048})});
  assert.equal((await jpeg.validate(envelope(bytes, 'image/jpeg'))).mime, 'image/jpeg');
});
test('caller envelope mutation during decoding cannot change the validated payload', async () => {
  const gate = deferred();
  const validator = createImageValidator({decodeImage: async () => { await gate.promise; return metadata; }});
  const value = envelope(), pending = validator.validate(value); value.base64 = 'AAAA'; value.mime = 'image/jpeg';
  gate.resolve(); assert.deepEqual((await pending).payload, envelope());
});
test('decoder mutation and exception messages do not escape the image boundary', async () => {
  const mutate = createImageValidator({decodeImage: async value => { value[0] ^= 1; return metadata; }});
  await assert.rejects(mutate.validate(envelope()), invalidImage);
  const throwing = createImageValidator({decodeImage: async () => { throw new Error('SYNTHETIC_PRIVATE_CANARY'); }});
  await assert.rejects(throwing.validate(envelope()), error => invalidImage(error) && !String(error).includes('CANARY'));
});
test('canceled and expired image inputs do not invoke the decoder', async () => {
  let calls = 0;
  const validator = createImageValidator({decodeImage: async () => { calls++; return metadata; }});
  const controller = new AbortController(); controller.abort();
  for (const options of [{signal: controller.signal}, {deadlineAt: Date.now() - 1}, {deadlineAt: NaN}, {signal: {aborted: false}}])
    await assert.rejects(validator.validate(envelope(), options), invalidImage);
  assert.equal(calls, 0);
});
test('cancellation retains active decoder slot until the underlying work settles', async () => {
  const firstGate = deferred(); let calls = 0;
  const validator = createImageValidator({decodeImage: async () => { if (++calls === 1) await firstGate.promise; return metadata; }});
  const controller = new AbortController();
  const first = validator.validate(envelope(), {signal: controller.signal});
  const firstRejected = assert.rejects(first, invalidImage); controller.abort(); await firstRejected;
  const second = validator.validate(envelope());
  await assert.rejects(validator.validate(envelope()), invalidImage); assert.equal(calls, 1);
  firstGate.resolve(); await second; assert.equal(calls, 2);
});
test('queued cancellation frees only the queue, not the active slot', async () => {
  const gate = deferred(); let calls = 0;
  const validator = createImageValidator({decodeImage: async () => { if (++calls === 1) await gate.promise; return metadata; }});
  const first = validator.validate(envelope()), controller = new AbortController();
  const queued = validator.validate(envelope(), {signal: controller.signal});
  const rejection = assert.rejects(queued, invalidImage); controller.abort(); await rejection;
  const replacement = validator.validate(envelope()); assert.equal(calls, 1);
  gate.resolve(); await Promise.all([first, replacement]); assert.equal(calls, 2);
});
test('deadline expires promptly while unfinished decoding retains the slot', async () => {
  const gate = deferred(); let calls = 0;
  const validator = createImageValidator({decodeImage: async () => { if (++calls === 1) await gate.promise; return metadata; }});
  await assert.rejects(validator.validate(envelope(), {deadlineAt: Date.now() + 15}), invalidImage);
  const next = validator.validate(envelope()); assert.equal(calls, 1);
  gate.resolve(); await next; assert.equal(calls, 2);
});
