# Bonanza CRM — field app (throwaway shell)

Three screens against the existing API: **sign in**, **my leads**, **log a
meeting with a location**. Built to be put on two RMs' phones and argued with.
Not built to be extended — see `docs/MOBILE-APP-SCOPE.md` for what a real
version needs and which decisions come first.

## Running it

The server must be up, and location capture is **off by default** — it is a
Compliance switch, not a developer one:

```
cd server && GEO_CAPTURE_ENABLED=1 npm start
cd mobile  && npx expo start
```

Press `w` for a browser, or scan the QR code with Expo Go on a handset.

**On a real phone, `localhost` is the phone.** Point the app at the machine
running the server:

```
EXPO_PUBLIC_API=http://192.168.1.x:4100 npx expo start
```

## What it does, and what it refuses to pretend

Everything on the meeting form comes from `GET /api/activities/meta` — the
modes, the outcomes, whether a location is wanted at all, and the notice shown
while it is asked for. Turning capture on, or adding an outcome in Setup,
changes this screen without it being rebuilt.

Three behaviours are worth watching, because they are the ones the server's
`geolocation.test.mjs` insists on and they are easy to get wrong in a client:

| | What happens |
|---|---|
| Location captured | Stored with its **accuracy radius**, shown beside the address |
| Permission refused | Stored as `declined`. **The meeting still saves** — an unlogged meeting is worse than an unlocated one |
| Meeting was Virtual | Never asked. Capture is for in-person meetings only |

## The offline queue

A meeting is written to a persistent queue **before** the network is attempted,
so it survives the app being killed mid-send, a flat battery in a car park, and
a tunnel. The flush that follows is what gets it there now if there is signal,
and its result decides the wording: a rep needs to know whether this is *done*
or merely *safe*.

The hard part is not sending. It is deciding what a failure means:

| Outcome | What happens |
|---|---|
| No reply at all | Stays queued. Retried on the next flush, and when signal returns |
| **4xx** | Rejected and shown. The server has an opinion and will have it again |
| **5xx** | Retried up to five times, then rejected |

Two more rules worth knowing:

- **Order is preserved.** A flush stops at the first item it cannot send rather
  than skipping past it, because two activities on one lead must land in the
  order they happened.
- **Sending twice is safe.** Every item carries a `client_ref`, and
  `POST /api/activities` returns the original row for a ref it has already seen.
  Without that, this queue would be a machine for logging the same meeting
  twice — a reply lost in transit is indistinguishable from a request that never
  arrived. Two e2e tests hold it, including one that a ref from one person can
  never hand back another person's activity.

The queue survives sign-out on purpose. It holds work, not session state.

## Deliberately absent

Secure token storage, biometric unlock, navigation. Each is a decision in the
scope document rather than something to add by default. The token lives in
memory, so closing the app signs you out — an honest placeholder for Keychain
and Keystore rather than a stand-in that looks finished.

## Notes for whoever picks this up

- `src/api.js` is a near-copy of `client/src/api.js`. Extracting a shared client
  is worth doing once there are two callers worth keeping in step.
- The API field for an outcome is `disposition`, not `code`. Sending `code` is
  ignored and returns "a Meeting activity needs an outcome", which reads like a
  broken form. Cost an hour; written down so it costs nobody else one.
- Expo SDK 57. `AGENTS.md` in this folder asks you to read the versioned docs
  before writing anything, and it is right to.
