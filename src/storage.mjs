import { createHash } from 'node:crypto';
const validId = value => {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error('Invalid record key');
  return value;
};
/** Contract: createOnce is atomic; a losing concurrent writer returns the existing value. */
export class MemoryInbox {
  #records = new Map();
  async get(id) {
    validId(id);
    return structuredClone(this.#records.get(id));
  }
  async createOnce(id, value) {
    validId(id);
    const created = !this.#records.has(id);
    if (created)
      this.#records.set(id, structuredClone(value));
    return {
      created, value: structuredClone(this.#records.get(id))
    };
  }
}
/** Inject an official @google-cloud/firestore Firestore instance; no credential files here. */
export class FirestoreInbox {
  constructor(db, collection = 'inbox') {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(collection))
      throw new Error('Invalid collection');
    this.db = db;
    this.collection = collection;
  }
  async createOnce(id, value) {
    const ref = this.db.collection(this.collection).doc(validId(id));
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists)
        return {
          created: false, value: snapshot.data().value
        };
      tx.create(ref, {
        value, createdAt: new Date()
      });
      return {
        created: true, value
      };
    });
  }
}
const generationValue = value => {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
    throw new Error('Invalid generation');
  return value;
};
const objectName = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(value) || value.split('/').some(x => x === '.' || x === '..'))
    throw new Error('Invalid object name');
  return value;
};
/** Pinned reads and create-only snapshots; injected official GCS Bucket. */
export class GcsSnapshots {
  constructor(bucket, { maxBytes = 8 * 1024 * 1024 } = {}) {
    this.bucket = bucket;
    this.maxBytes = maxBytes;
  }
  async read({ object, generation, sha256 }) {
    objectName(object);
    generationValue(generation);
    if (!/^[a-f0-9]{64}$/.test(sha256))
      throw new Error('Invalid digest');
    const file = this.bucket.file(object, {
      generation
    });
    const [metadata] = await file.getMetadata();
    if (String(metadata.generation) !== generation || !Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) < 0 || Number(metadata.size) > this.maxBytes)
      throw new Error('Snapshot metadata mismatch');
    const [bytes] = await file.download({
      validation: 'crc32c'
    });
    if (bytes.length > this.maxBytes || bytes.length !== Number(metadata.size) || createHash('sha256').update(bytes).digest('hex') !== sha256)
      throw new Error('Snapshot integrity failure');
    return bytes;
  }
  async create(object, bytes) {
    objectName(object);
    if (!Buffer.isBuffer(bytes) || bytes.length > this.maxBytes)
      throw new Error('Invalid snapshot size');
    const file = this.bucket.file(object);
    await file.save(bytes, {
      resumable: false, validation: 'crc32c', preconditionOpts: {
        ifGenerationMatch: 0
      }
    });
    // Return only the content digest. Persist the returned object generation through
    // an adapter-specific upload response before creating a restoration pointer.
    return {
      sha256: createHash('sha256').update(bytes).digest('hex')
    };
  }
}
