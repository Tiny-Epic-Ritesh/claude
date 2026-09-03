/**
 * The CRM API, from a phone.
 *
 * Deliberately a near-copy of `client/src/api.js` rather than a shared package.
 * This is a throwaway shell whose job is to prove the path from a device to the
 * existing API; extracting a shared client is worth doing once the app is real
 * and there are two callers worth keeping in step, not before.
 *
 * BASE has to be reachable *from the device*, which `localhost` is not once
 * this leaves a browser on this machine: a phone resolving localhost resolves
 * itself. On a real handset this becomes the LAN address of whatever is running
 * the server, and in a pilot it becomes the hostname behind TLS.
 */

import { Platform } from 'react-native';

export const BASE = process.env.EXPO_PUBLIC_API
  || (Platform.OS === 'web' ? 'http://localhost:4100' : 'http://10.0.2.2:4100');

let token = null;

export const setToken = (value) => { token = value; };
export const getToken = () => token;

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    /* The API answers with { error } and often a { field } beside it. Surfacing
       the server's own wording beats inventing a second vocabulary for the same
       refusal -- and the refusals here are ones a rep must understand: "that
       lead is outside your book", "a Meeting needs an outcome". */
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.field = data?.field;
    err.fields = data?.fields;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
};

/** Sign in and keep the token for the rest of the session. */
export async function signIn(email, password) {
  const data = await request('/auth/login', { method: 'POST', body: { email, password } });
  setToken(data.token);
  return data.user;
}
