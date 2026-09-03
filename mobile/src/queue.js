/**
 * Work done with no signal, sent when there is one.
 *
 * The scope document called this the hardest part of the app, and the hard part
 * is not the sending. It is deciding what a failure means.
 *
 * THREE OUTCOMES, THREE DIFFERENT ANSWERS
 * ---------------------------------------
 * A request that never got a reply is the case this exists for: keep it and try
 * again. But a request the server *refused* — "that lead is not in your book",
 * "a Meeting needs an outcome" — will be refused every time, and retrying it
 * forever hides it from the person who could fix it. And a 5xx is neither: the
 * server is unwell rather than disagreeing, so it is worth a few more attempts
 * before giving up.
 *
 *   no reply      → stay queued, retry on the next flush
 *   4xx           → rejected. Stop, and show it. The server has an opinion.
 *   5xx           → retry, up to MAX_ATTEMPTS, then rejected
 *
 * ORDER IS PRESERVED
 * ------------------
 * Two activities against one lead must land in the order they happened — the
 * second may depend on what the first set. So a flush stops at the first item
 * that cannot be sent rather than skipping past it.
 *
 * SENDING TWICE IS SAFE
 * ---------------------
 * A creating request carries a `client_ref`, and `POST /api/activities` returns
 * the original row for a ref it has already seen. Without that, this queue would
 * be a machine for logging the same meeting twice: a reply lost in transit is
 * indistinguishable from a request that never arrived.
 *
 * Not every request needs one. Completing a task is `PATCH { status: 'Done' }`,
 * which sets a value rather than adding a row -- sending it twice lands in the
 * same place, so it is idempotent by nature and asks for no key. Items say which
 * they are with `ref`, rather than the queue guessing from the method.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { api } from './api.js';

const KEY = 'bnz.activity.queue.v1';
const MAX_ATTEMPTS = 5;

let listeners = [];
const notify = (items) => listeners.forEach((fn) => fn(items));

/** Subscribe to queue changes. Returns an unsubscribe. */
export function onChange(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

async function read() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    /* A corrupt queue must not brick the app. Losing an unsent activity is bad;
       a rep who cannot open the app at all is worse. */
    return [];
  }
}

async function write(items) {
  await AsyncStorage.setItem(KEY, JSON.stringify(items));
  notify(items);
  return items;
}

export const list = read;
export const pending = async () => (await read()).filter((i) => i.state === 'queued').length;
export const rejected = async () => (await read()).filter((i) => i.state === 'rejected');

/**
 * Put a request on the queue. Returns the stored item.
 *
 * `ref: true` for anything that creates a row, so a retry is recognised rather
 * than duplicated. `ref: false` for a request that sets a value and is
 * therefore safe to repeat.
 */
export async function enqueue({ path, method = 'POST', body, label, ref = true }) {
  const item = {
    id: Crypto.randomUUID(),
    client_ref: ref ? Crypto.randomUUID() : null,
    path,
    method,
    body,
    state: 'queued',
    attempts: 0,
    queued_at: new Date().toISOString(),
    last_error: null,
    // Shown in the pending list so a rep can tell one item from another.
    label: label || path,
  };
  const items = await read();
  await write([...items, item]);
  return item;
}

export async function remove(id) {
  await write((await read()).filter((i) => i.id !== id));
}

/** Move a rejected item back to queued, for a person who has fixed the cause. */
export async function requeue(id) {
  const items = await read();
  await write(items.map((i) => (
    i.id === id ? { ...i, state: 'queued', attempts: 0, last_error: null } : i
  )));
}

/**
 * Try to send everything queued, oldest first.
 *
 * Stops at the first item that cannot be sent, so order is preserved. Safe to
 * call at any time and safe to call twice at once — the second call sees the
 * first call's writes.
 */
export async function flush() {
  const items = await read();
  const result = { sent: 0, kept: 0, rejected: 0 };
  let changed = false;

  for (const item of items) {
    if (item.state !== 'queued') continue;

    try {
      const body = item.client_ref
        ? { ...item.body, client_ref: item.client_ref }
        : item.body;
      const send = item.method === 'PATCH' ? api.patch : api.post;
      await send(item.path, body);
      item.state = 'sent';
      result.sent += 1;
      changed = true;
    } catch (err) {
      item.attempts += 1;
      item.last_error = err.message;
      changed = true;

      if (err.status && err.status >= 400 && err.status < 500) {
        // The server disagrees, and will disagree again. Show it to somebody.
        item.state = 'rejected';
        result.rejected += 1;
        continue;
      }

      if (item.attempts >= MAX_ATTEMPTS) {
        item.state = 'rejected';
        result.rejected += 1;
        continue;
      }

      // No reply, or a 5xx. Keep it, and stop so nothing overtakes it.
      result.kept += 1;
      break;
    }
  }

  if (changed) await write(items.filter((i) => i.state !== 'sent'));
  return result;
}
