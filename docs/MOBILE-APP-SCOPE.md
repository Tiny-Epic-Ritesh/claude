# Mobile app — scope

**Date:** 3 Sep 2026
**Answers this rests on:** A-1, 3 Sep — a native Android and iOS app; and the
purpose Ritesh gave the same day: the sales team is on the road, cannot carry a
laptop, and needs to record meeting information and lead details from a phone.

---

## The headline

**This is a client, not a new system.** The part that sounds hardest — capturing
a verified location against an in-person meeting, lawfully — is already built,
tested and running.

`activities` carries `geo_status`, `geo_lat`, `geo_lng`, `geo_accuracy_m`,
`geo_address` and `geo_captured_at`. `routes/activities.js` accepts them on
create. `test/geolocation.test.mjs` holds twelve cases, and they are the twelve
that matter:

- it is off unless somebody turns it on
- only in-person meetings are asked at all
- a refusal is a value, not a failure
- "could not get a fix" is told apart from "would not give one"
- the accuracy radius is kept, because the address alone would mislead
- an impossible position is unavailable, not captured
- a position older than twelve months is cleared
- every location field carries a stated purpose
- a person can see what was recorded about their own movements
- refusals are reported as a rate, never as a list of movements

That is the DPDP-defensible version of this feature, and it exists. There are
322 API routes behind it — sign-in, my leads, lead detail, log an activity,
tasks, calendar, click-to-call are all endpoints that work today and are already
scoped by role and by book.

So the question is not "can the CRM do this on mobile". It is "what shape of
phone client, and what does it do when there is no signal".

---

## Scope

Proposed. **Confirm or cut before anything is built** — this is the decision that
moves the estimate more than every other one combined.

### In

| | Why |
|---|---|
| Sign in, with biometric unlock after the first login | A field rep signs in many times a day; a password each time means a weak password |
| My leads — list and detail | Read before a meeting, in the car park |
| **Log a meeting, with location** | The reason the app exists |
| Log a call, WhatsApp or note against a lead | The rest of what happens on the road |
| My tasks — see, complete, add | A follow-up agreed in a meeting must be capturable in the meeting |
| Today's meetings | The day's plan |
| Click-to-call through QuickCall | Already an endpoint; on a phone it is also just a dial intent |
| **Work offline, sync later** | Basements, lifts, and the parts of the country where this team sells |

### Out, for the first version

Setup and configuration, dashboards and reports beyond "my numbers", campaigns,
content, the partner portal, lead lists and bulk actions, imports, ticket
management, client 360.

None of these are things somebody does standing in a client's office. Admin work
belongs on a laptop, and putting Setup on a phone is how a phone app becomes a
two-year project.

---

## What is genuinely new work

Not the CRM. These five:

1. **The app shell** — navigation, the screens above, offline-aware forms.
2. **Offline queue and sync.** The hardest part by a distance. An activity
   logged with no signal must be held, retried and reconciled, and the rules for
   "the lead changed while you were offline" have to be decided rather than
   discovered.
3. **Auth on the device.** The web keeps a session token in `localStorage`. A
   phone needs Keychain on iOS and Keystore on Android, plus biometric unlock
   and a sensible re-auth window.
4. **Store presence.** Apple Developer Program and Google Play, registered to
   Bonanza, with a named responsible person. Privacy nutrition labels and a data
   safety form, both of which must match what the app actually does.
5. **Release process.** Store review means no hot fix. A defect that is a
   ten-minute deploy on the web becomes a one-to-three-day round trip.

---

## Technology

**React Native.** One codebase, and it reuses the React already in this repo —
including `client/src/api.js`, which is portable more or less as it stands.
Native Swift and Kotlin means two codebases and two skill sets, which is a poor
trade at this team size for an app of this scope.

Four native capabilities are needed and all are standard: geolocation, secure
storage, biometrics, and a dial intent.

This should be a decision rather than a default, but there is realistically one
answer.

---

## Decisions needed from Bonanza

| | Decision | Blocks |
|---|---|---|
| 1 | **Confirm or cut the scope above** | Everything. |
| 2 | **Store accounts** — Apple and Google, in Bonanza's name | Release. Apple's organisation verification is not same-day, so start it early even if the build has not. |
| 3 | **What may live on the device, and for how long** | The offline design. Cached leads are client data on a phone that can be lost; DPDP and SEBI both bear on it. |
| 4 | **Who gets the app** | Sales RMs only, or callers and Product RMs too. Changes the role scoping, not the build. |
| 5 | **Is proof of presence a compliance requirement or a management one** | See the risk below. It changes how much the location can be relied on. |

---

## Risks worth naming now

**Location can be faked on Android.** Mock-location apps are freely available and
do not need a rooted device. Detection is possible and partial: Android reports
whether a fix came from a mock provider, and an accuracy radius that never
varies is itself a signal. If the location is a *management* signal — where was
the team today — that is fine. If it is meant as *evidence* in a dispute, it
should be described as corroboration and never as proof, and the accuracy radius
already stored is part of why.

**Offline sync is where these projects overrun.** Not the syncing; the
reconciliation. Two people editing one lead, one of them three hours stale, is a
product decision before it is an engineering one.

**The app cannot be fixed quickly.** Anything that can strand a rep in a client's
office — a failed sign-in, a lost draft — needs to be right before release, not
after. This argues for a small first version and a slow widening.

---

## Sequence

1. Settle the five decisions above. Start the store accounts on day one
   regardless, because they wait on other people.
2. Build against the existing API with a throwaway shell — sign in, my leads,
   log a meeting with location — and put it on real phones with two RMs.
3. Offline queue and sync, once the online path is proven.
4. Widen to tasks, calendar and click-to-call.
5. Store submission, with the privacy forms filled from what the app does rather
   than from what we intended it to do.

**Nothing is built yet.** P2-01 is recorded as not started rather than done: the
web geolocation was built against the other reading of A-1 and does not satisfy
a native-app requirement, though the server behind it does.
