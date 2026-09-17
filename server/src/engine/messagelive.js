/**
 * Live messages — P3-21, phase 3.
 *
 * WHY SERVER-SENT EVENTS AND NOT A SOCKET
 *
 * A WebSocket needs the proxy in front of this to pass upgrade headers, and
 * the nginx configuration is not ours to change. Server-sent events are plain
 * HTTP: one long response, text down it as things happen. The two headers that
 * matter are set where the stream is opened -- `no-transform` and
 * `X-Accel-Buffering: no`, which tell a proxy not to sit on the bytes -- and a
 * comment is sent every 25 seconds so an idle stream is not closed as dead.
 *
 * POLLING STAYS
 *
 * The screens keep their timers, slowed right down while a stream is
 * connected. A stream that never arrives, or dies behind a proxy nobody told
 * us about, then costs a slower refresh rather than a screen that quietly
 * stops updating -- which is the failure worth designing against, because
 * nobody reports it, they just stop trusting the page.
 *
 * ONE PROCESS
 *
 * This bus lives in memory, so it carries events between the people connected
 * to this process. A second instance behind a load balancer needs a shared
 * channel (Redis, or Postgres LISTEN/NOTIFY at pilot) -- the same note the
 * role-capability cache in engine/access.js carries, and the same answer.
 */

import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
// One listener per open stream, and there is no sensible ceiling on those.
bus.setMaxListeners(0);

/** Something happened in a conversation. Members connected right now hear it. */
export function announce(conversationId, what, extra = {}) {
  if (!conversationId) return;
  bus.emit('change', {
    conversation_id: Number(conversationId),
    what,
    at: new Date().toISOString(),
    ...extra,
  });
}

/** Listen until the returned function is called. */
export function listen(handler) {
  bus.on('change', handler);
  return () => bus.off('change', handler);
}

/** How many streams are open, for the health endpoint to be honest about it. */
export const openStreams = () => bus.listenerCount('change');
