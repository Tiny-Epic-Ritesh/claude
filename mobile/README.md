# Bonanza CRM — field app (throwaway shell)

Against the existing API: **sign in**, **today**, **my leads**, **my tasks**,
**call a lead**, and **log a meeting with a location** — with an offline queue
underneath.
Built to be put on two RMs' phones and argued with. Not built to be extended —
see `docs/MOBILE-APP-SCOPE.md` for what a real version needs and which
decisions come first.

Three tabs, no navigation library: there is no back stack, no deep links and no
router. A segmented control is what three screens need, and choosing a router
now would be choosing an architecture for an app whose shape is still being
argued about.

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

It carries any request, not only activities — completing a task goes through it
too, so a rep can clear their list in a basement.

Two more rules worth knowing:

- **Order is preserved.** A flush stops at the first item it cannot send rather
  than skipping past it, because two activities on one lead must land in the
  order they happened.
- **Sending twice is safe.** A request that *creates* carries a `client_ref`,
  and `POST /api/activities` returns the original row for a ref it has seen.
  Without that, this queue would be a machine for logging the same meeting
  twice — a reply lost in transit is indistinguishable from a request that never
  arrived. Two e2e tests hold it, including one that a ref from one person can
  never hand back another person's activity.

  A request that only *sets* a value needs no key. Completing a task is
  `PATCH { status: 'Done' }`, which lands in the same place however many times
  it arrives — verified, not assumed. Items declare which they are with `ref`,
  rather than the queue guessing from the method.

The queue survives sign-out on purpose. It holds work, not session state.

## Calling: the switch dials, not the handset

The obvious mobile answer is a `tel:` link, and for this app's main user it is
impossible. A Sales RM asking for a lead is given `••••••9300` — the number is
masked by role, and you cannot dial dots. An Admin is given `9848249300`.

So `POST /api/leads/:id/call` is not a nicety, it is the only route that works:
the server holds the number, hands it to the switch, and the rep never sees it.
Verified — the RM saw dots while the vendor was sent `9848249300`. **Masking
survives onto the phone** rather than being the first thing a mobile app quietly
gives up. Consent is checked before the call, and the call is logged, both
without the client having to remember.

The handset is still the fallback, because the route's own comment says it
should be: when the switch refuses, a rep needs to be able to call from their
own phone. That is offered only when the number *this device was given* is
dialable — the app does not reimplement the masking rules to work that out, it
looks at what it received. Digits can be dialled, dots cannot.

Two refusals are handled differently on purpose:

| | What happens |
|---|---|
| **409, consent** | The reason and the fix are shown, and **no handset fallback is offered.** The number is withdrawn or dead; routing around that would defeat a rule the CRM is enforcing |
| **502, switch refused** | Handset dial offered, if the number is dialable |
| **`simulated: true`** | Reported as *not called*. QuickCall has no credentials yet, so the switch accepts the request and rings nobody — a success notice would leave a rep waiting for a phone that never rings |

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
