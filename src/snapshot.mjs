import { open, readFile, rename, mkdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validKey, checkCapacity } from './state.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX = 1024 * 1024;
/** Native Node filesystem checkpoint, single trusted writer only. The directory
* must be operator-owned, never user-selected or writable by untrusted tenants.
* Not Hermes SQLite, not a cross-process transaction store, not cloud durability.
*/
export class FileSnapshots {
  constructor(directory) {
    this.directory = directory;
  }
  async save(sessionKey, state) {
    validKey(sessionKey);
    const payload = JSON.stringify({
      schemaVersion: 1, sessionKey, state
    });
    const bytes = Buffer.from(JSON.stringify({
      sha256: hash(payload), payload
    }));
    if (bytes.length > MAX)
      throw Error('Snapshot too large');
    await mkdir(this.directory, {
      recursive: true, mode: 0o700
    });
    const target = join(this.directory, sessionKey + '.json'), temp = target + '.' + randomUUID() + '.tmp';
    const file = await open(temp, 'wx', 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      }
      finally {
        await file.close();
      }
      await rename(temp, target);
      const dir = await open(this.directory, 'r');
      try {
        await dir.sync();
      }
      finally {
        await dir.close();
      }
    }
    catch (error) {
      await unlink(temp).catch(() => {
      });
      throw error;
    }
    return {
      sha256: hash(payload), bytes: bytes.length
    };
  }
  async load(sessionKey) {
    validKey(sessionKey);
    const target = join(this.directory, sessionKey + '.json');
    if ((await stat(target)).size > MAX)
      throw Error('Snapshot too large');
    const raw = await readFile(target);
    if (raw.length > MAX)
      throw Error('Snapshot too large');
    const envelope = JSON.parse(raw.toString('utf8'));
    if (typeof envelope.payload !== 'string' || hash(envelope.payload) !== envelope.sha256)
      throw Error('Snapshot checksum mismatch');
    const data = JSON.parse(envelope.payload);
    if (data.schemaVersion !== 1 || data.sessionKey !== sessionKey || data.state?.version !== 1 || typeof data.state.memoryMarkdown !== 'string' || !Array.isArray(data.state.order) || typeof data.state.turns !== 'object' || data.state.turns === null)
      throw Error('Invalid snapshot schema');
    const state = data.state;
    checkCapacity(state);
    if (!Number.isSafeInteger(state.revision) || state.revision < 0 || Object.keys(state.turns).length !== state.order.length)
      throw Error('Invalid snapshot revision');
    if (!Number.isSafeInteger(state.epoch) || state.epoch < 0 || state.order.length > 100 || new Set(state.order).size !== state.order.length || Buffer.byteLength(state.memoryMarkdown) > 65536)
      throw Error('Invalid snapshot state');
    for (const id of state.order) {
      validKey(id);
      const record = state.turns[id];
      if (!record || record.turn?.turnId !== id || record.turn?.sessionKey !== sessionKey || !['PENDING', 'RUNNING', 'PREPARED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'QUARANTINED'].includes(record.status))
        throw Error('Invalid snapshot record');
      if (typeof record.turn.text !== 'string' || record.turn.text.length > 4096)
        throw Error('Invalid snapshot turn');
      if (['PREPARED', 'SENDING', 'SENT', 'FAILED'].includes(record.status) || record.reply !== undefined) {
        if (typeof record.reply !== 'string' || record.reply.length > 4096 || !Number.isSafeInteger(record.revision) || record.revision < 1 || record.revision > state.revision)
          throw Error('Invalid snapshot checkpoint');
      }
    }
    // Local restart must not revive a lease held by a terminated process.
    data.state.lease = null;
    return data.state;
  }
}
