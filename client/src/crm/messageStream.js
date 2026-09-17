/**
 * One live message stream per tab, shared by every screen that wants it
 * (P3-21, phase 3).
 *
 * WHY FETCH AND NOT EVENTSOURCE
 *
 * The browser's EventSource cannot send an Authorization header, and this
 * CRM's session travels in one. The alternative -- the token in the URL -- puts
 * a live credential into every proxy and access log it passes. So the stream is
 * read with fetch, which can send the header, and parsed here.
 *
 * WHY SHARED
 *
 * The header inbox is on every page and the Messages screen wants the same
 * events. Two streams per tab would be two held-open connections per person for
 * nothing, so the first subscriber opens it and the last one closes it.
 *
 * WHEN IT FAILS
 *
 * It reconnects with a backoff, and every subscriber is told whether it is
 * connected, so a screen can slow its polling right down while it is and fall
 * back to its normal pace when it is not. A stream that never arrives costs a
 * slower refresh, never a page that silently stops updating.
 */

import { useEffect, useRef, useState } from 'react';
import { token, getActiveOrg } from '../api.js';

const listeners = new Set();
const statusListeners = new Set();

let controller = null;
let connected = false;
let retryMs = 2000;
let retryTimer = null;

const setConnected = (value) => {
  if (connected === value) return;
  connected = value;
  for (const fn of statusListeners) fn(value);
};

/* One record is `event:` and `data:` lines ended by a blank line. Only `data`
   matters here; a line starting with a colon is the server's keep-alive. */
function dispatch(record) {
  const data = record
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .join('\n');
  if (!data) return;
  let event = null;
  try { event = JSON.parse(data); } catch { event = null; }
  if (event) for (const fn of listeners) fn(event);
}

async function open() {
  if (controller || !listeners.size) return;
  const session = token.get('crm');
  if (!session) return;

  controller = new AbortController();
  const headers = { Authorization: `Bearer ${session}`, Accept: 'text/event-stream' };
  const org = getActiveOrg();
  if (org) headers['X-Sales-Org'] = org;

  try {
    const res = await fetch('/api/messages/stream', { headers, signal: controller.signal, cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`The message stream answered ${res.status}`);
    setConnected(true);
    retryMs = 2000;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf('\n\n');
      while (cut >= 0) {
        dispatch(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf('\n\n');
      }
    }
  } catch (err) {
    // Closed on purpose, because nobody is listening any more.
    if (err?.name === 'AbortError') {
      controller = null;
      setConnected(false);
      return;
    }
  }

  controller = null;
  setConnected(false);
  if (listeners.size) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, retryMs);
    retryMs = Math.min(retryMs * 2, 60_000);
  }
}

/** Hear every change in a conversation you are in. Returns the unsubscribe. */
export function subscribe(onEvent, onStatus) {
  listeners.add(onEvent);
  if (onStatus) {
    statusListeners.add(onStatus);
    onStatus(connected);
  }
  open();
  return () => {
    listeners.delete(onEvent);
    if (onStatus) statusListeners.delete(onStatus);
    if (!listeners.size) {
      clearTimeout(retryTimer);
      controller?.abort();
    }
  };
}

/**
 * The stream, from a component. Returns whether it is connected right now, so
 * the caller can slow its own polling while it is.
 */
export function useMessageStream(onEvent) {
  const [live, setLive] = useState(connected);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => subscribe((event) => handler.current?.(event), setLive), []);
  return live;
}
