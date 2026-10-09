import { createHash, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const digest = value => createHash('sha256').update(value).digest();
export const secretMatches = (actual, expected) => typeof actual === 'string' && typeof expected === 'string' && expected.length >= 32 && timingSafeEqual(digest(actual), digest(expected));
const id = (n, positive = false) => Number.isSafeInteger(n) && n !== 0 && (!positive || n > 0);
const key = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Only Telegram-authenticated fields and operator configuration assign authority. */
export function route(update, policy) {
  if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0)
    return null;
  const m = update.message;
  if (!m || m.sender_chat || m.from?.is_bot !== false || !id(m.from?.id, true) || !id(m.chat?.id) || !id(m.message_id, true))
    return null;
  if (typeof m.text !== 'string' || m.text.length === 0 || m.text.length > 4096)
    return null;
  if (m.message_thread_id !== undefined && !id(m.message_thread_id, true))
    return null;
  if (typeof policy.tenantId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(policy.tenantId))
    throw new Error('Invalid tenant configuration');
  const userId = String(m.from.id), chatId = String(m.chat.id);
  let role;
  if (m.chat.type === 'private' && chatId === userId && policy.privateUsers.includes(userId))
    role = 'private-member';
  else if (['group', 'supergroup'].includes(m.chat.type) && m.chat.id < 0 && policy.groups[chatId]?.includes(userId))
    role = 'group-member';
  else
    return null;
  const topicId = m.message_thread_id === undefined ? null : String(m.message_thread_id);
  return {
    schemaVersion: 1, updateId: String(update.update_id), messageId: String(m.message_id),
    sessionKey: key([policy.tenantId, m.chat.type, chatId, topicId]),
    principal: {
      tenantId: policy.tenantId, userId, chatId, topicId, role
    }, text: m.text
  };
}
/** Admit before enqueue. Duplicates re-enqueue the same deterministic task ID for repair. */
export function createIngress({ secret, policy, inbox, queue }) {
  if (typeof secret !== 'string' || secret.length < 32)
    throw new Error('Webhook secret must contain at least 32 characters');
  return async ({ method, path, headers, body }) => {
    if (method !== 'POST' || path !== '/telegram/webhook')
      return {
        status: 404
      };
    if (!secretMatches(headers?.['x-telegram-bot-api-secret-token'], secret))
      return {
        status: 401
      };
    if (!Buffer.isBuffer(body) || body.byteLength > 65536)
      return {
        status: 413
      };
    let update;
    try {
      update = JSON.parse(body.toString('utf8'));
    }
    catch {
      return {
        status: 400
      };
    }
    const turn = route(update, policy);
    if (!turn)
      return {
        status: 200, body: {
          accepted: false
        }
      };
    const taskId = key([policy.tenantId, turn.updateId]);
    try {
      const record = await inbox.createOnce(taskId, turn);
      // Fail closed if a reused ID has different routing or content.
      if (!isDeepStrictEqual(record.value, turn))
        return {
          status: 409
        };
      await queue.enqueue(taskId, {
        inboxId: taskId
      });
      return {
        status: 200, body: {
          accepted: true, duplicate: !record.created
        }
      };
    }
    catch {
      return {
        status: 503
      };
    }
  };
}
