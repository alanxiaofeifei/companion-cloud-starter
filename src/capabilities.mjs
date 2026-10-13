import { createHash } from 'node:crypto';

/** Anchored single-line syntax only: quoted examples, history and vague questions never activate search. */
export function admitWeb(text) {
  if (typeof text !== 'string' || text.length > 4096 || /[\r\n]/u.test(text)) return { kind: 'refused' };
  const t = text.trim();
  const match = /^(?:\/web(?:@[A-Za-z0-9_]+)?\s+|(?:please )?(?:search the web for|search online for)[:：]?\s+|(?:请)?(?:联网搜索|上网搜索)[:：]?\s*|(?:hãy )?(?:tìm kiếm trên mạng|tìm trên web)[:：]?\s+)([^\r\n]+)$/iu.exec(t);
  if (!match) return /^\/web(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(t) ? { kind: "refused" } : { kind: "none" };
  const query = match[1].trim();
  // Conservative input heuristic; it cannot identify every private fact. No application private context is attached.
  // eslint-disable-next-line no-control-regex
  if (!query || query.length > 512 || /[\u0000-\u001f\u007f"“”`<>]/u.test(query) || /(?:https?:|@|\b(?:token|password|secret|credential|private|our chat|my (?:account|family|address))\b|密钥|密码|私聊|聊天记录|我们|我家|mật khẩu|tin nhắn riêng)/iu.test(query) || /\d{8,}/u.test(query)) return { kind: "refused" };
  return { kind: "query", query };
}
/** Select bounded current-message metadata only; this does not fetch or validate image bytes. */
export function selectPhoto(variants) {
  if (!Array.isArray(variants) || variants.length > 100) return undefined;
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
  const safe = variants.filter(v => v && typeof v === 'object' && !Array.isArray(v)
    && id(v.file_id) && id(v.file_unique_id)
    && Number.isSafeInteger(v.width) && Number.isSafeInteger(v.height) && v.width > 0 && v.height > 0
    && Math.max(v.width, v.height) <= 2048 && v.width * v.height <= 2048 ** 2
    && (v.file_size === undefined || (Number.isSafeInteger(v.file_size) && v.file_size > 0 && v.file_size <= IMAGE_MAX_BYTES)));
  safe.sort((a, b) => b.width * b.height - a.width * a.height || (a.file_id < b.file_id ? -1 : a.file_id > b.file_id ? 1 : 0));
  const v = safe[0];
  return v ? Object.freeze({file_id: v.file_id, file_unique_id: v.file_unique_id, width: v.width, height: v.height,
    ...(v.file_size === undefined ? {} : {file_size: v.file_size})}) : undefined;
}

export const IMAGE_MAX_BYTES = 1048576;
const imageError = () => new Error('unsupported_or_invalid_image');
const live = options => {
  if (options.signal?.aborted || Date.now() >= options.deadlineAt) throw imageError();
};
function unpackImageEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw imageError();
  if (Object.keys(value).sort().join(',') !== 'base64,byteLength,mime,sha256') throw imageError();
  const {mime, base64, byteLength, sha256} = value;
  if (!['image/png', 'image/jpeg'].includes(mime) || typeof base64 !== 'string'
    || base64.length < 4 || base64.length > 4 * Math.ceil(IMAGE_MAX_BYTES / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
    || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > IMAGE_MAX_BYTES
    || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw imageError();
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64 || bytes.length !== byteLength
    || createHash('sha256').update(bytes).digest('hex') !== sha256) throw imageError();
  return {bytes, payload: Object.freeze({mime, base64, byteLength, sha256})};
}

/** decodeImage is trusted application code, never request-supplied code or a model tool.
 * It must fully decode the supplied bytes without mutation and enforce the supplied bounds.
 * Return exactly {mime, width, height}. A header-only decoder is not sufficient.
 * This callback seam is not a sandbox or hard process-memory limit.
 */
export function createImageValidator({decodeImage} = {}) {
  if (typeof decodeImage !== 'function') throw imageError();
  let active = false, queued;
  function bounded(work, options) {
    live(options);
    if (active && queued) return Promise.reject(imageError());
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, failed = false) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        if (failed) reject(imageError()); else resolve(value);
      };
      const cancel = () => { if (queued === start) queued = undefined; finish(undefined, true); };
      const start = () => {
        if (settled) return;
        active = true;
        void (async () => {
          try { live(options); const result = await work(); live(options); finish(result); }
          catch { finish(undefined, true); }
          finally { active = false; const next = queued; queued = undefined; next?.(); }
        })();
      };
      const timer = setTimeout(cancel, Math.max(1, options.deadlineAt - Date.now()));
      options.signal?.addEventListener('abort', cancel, {once: true});
      if (options.signal?.aborted) cancel(); else if (active) queued = start; else start();
    });
  }
  return Object.freeze({
    async validate(value, {signal, deadlineAt = Date.now() + 5000} = {}) {
      try {
        if (!Number.isFinite(deadlineAt) || (signal !== undefined && !(signal instanceof AbortSignal))) throw imageError();
        const options = {signal, deadlineAt: Math.min(deadlineAt, Date.now() + 5000)};
        live(options);
        // Snapshot canonical envelope and bytes before the first await.
        const {bytes, payload} = unpackImageEnvelope(value);
        return await bounded(async () => {
          const decoderBytes = Buffer.from(bytes);
          const actual = await decodeImage(decoderBytes, Object.freeze({...options, maxBytes: IMAGE_MAX_BYTES, maxDimension: 2048, maxPixels: 4194304}));
          live(options);
          if (!decoderBytes.equals(bytes) || !actual || typeof actual !== 'object' || Array.isArray(actual)
            || Object.keys(actual).sort().join(',') !== 'height,mime,width'
            || actual.mime !== payload.mime || !Number.isSafeInteger(actual.width) || !Number.isSafeInteger(actual.height)
            || actual.width < 1 || actual.height < 1 || Math.max(actual.width, actual.height) > 2048
            || actual.width * actual.height > 4194304) throw imageError();
          return Object.freeze({payload, mime: actual.mime, width: actual.width, height: actual.height});
        }, options);
      } catch { throw imageError(); }
    },
  });
}
