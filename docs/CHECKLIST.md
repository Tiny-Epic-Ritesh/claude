# Build checklist

Live tracker. Updated as each item lands. **Do not delete completed rows** —
the record of what shipped is as useful as the list of what has not.

Legend: `[ ]` pending · `[~]` in progress · `[x]` done

**Status: 122 done, 1 open** (31 Aug 2026). The single open item is blocked on
the business, not on development: the LeadSquared export has not been run.

**Tests: 734** — 477 end-to-end and 257 unit. All green.

Since this header was last accurate the build has also closed the last of the
LeadSquared audit findings that were still open on 21 August: field-change
history, automation conflict detection, nested query power, and versioning for
rules, templates, KYC journeys and SLA policies. See `docs/gap-analysis.md` for
the current scorecard.

---

## A · Partner portal — full rebuild
_Reported 22 Aug 2026: "not captured on the full page… not utilizing the entire
page… UI was not good."_

- [x] A1 Full-width shell — replace the narrow centred column
- [x] A2 Graphical summary — earnings trend, conversion funnel, sourcing mix
- [x] A3 Metric strip — live numbers, not buried in prose
- [x] A4 Tabbed navigation — Overview · Referrals · Earnings · Clients · Payouts · Profile
- [x] A5 Referral list → card grid with status and action per card
- [x] A6 Commission / payout statement view
- [x] A7 Responsive down to mobile
- [x] A8 Verified in browser at 3 widths, no overflow, no collisions

## B · KYC (DKYC) portal — full rebuild
_Same report. "The list of products I saw in the KYC portal was in a list format."_

- [x] B1 Full-width shell
- [x] B2 Product **cards**, not a list — box design, one action per card
- [x] B3 Visual step rail — where the applicant is in the 16 steps
- [x] B4 Progress summary with real numbers
- [x] B5 Feature / benefit presentation per product
- [x] B6 Trust panel — SEBI registration, security, data residency
- [x] B7 Responsive down to mobile
- [x] B8 Verified in browser at 3 widths, no overflow, no collisions

## C · Lead detail
- [x] C1 **Edit lead** — currently missing entirely
- [x] C2 Field-level permission respected in the edit form
- [x] C3 Product cards → box design, uniform grid
- [x] C4 Action button on every product card
- [x] C5 Actions open in a modal on the same page, no navigation away
- [x] C6 Custom fields from the metadata layer appear on the record
- [x] C7 Verified in browser

## D · Quality gates (every item above)
- [x] D1 All suites green after each change
- [x] D2 No horizontal page overflow at 375 / 768 / 1280
- [x] D3 No overlapping blocks (collision detector)
- [x] D4 Overlays near-opaque, never glass
- [x] D5 Business rules unchanged — permissions, org scope, disposition matrix
- [x] D6 Client build clean

---

## E · Login, click-to-call & action menus
_Requested 22 Aug 2026. Decisions taken with the user, recorded below._

| Question | Decision |
|---|---|
| Click-to-call | **Dial immediately via CUBE.** Clicking a number hits `POST /leads/:id/call`; CUBE rings the RM's extension then connects the client. No confirm step. |
| Consent | **Block marketing, allow service.** Opt-out blocks promotional WhatsApp/SMS/Email; calls and service messages still go. Invalid mobile disables call and SMS. Enforced at the API, never only in the UI. |
| List view | **Per-row menu plus bulk on selection.** Checkboxes enable bulk reassign / campaign / push-to-dialler, as LeadSquared and Salesforce both do. |
| Action set | The six named, plus create task, raise a case, start KYC, change stage, push to autodialler. |

- [x] E1 Login page — role picker as aligned boxes (`.login-*` has no CSS at all today)
- [x] E2 Consent engine — marketing vs service, enforced at the API
- [x] E3 Consent enforced on `/leads/:id/call` and `/leads/:id/message`
- [x] E4 Click-to-call from the mobile number — lead detail
- [x] E5 Click-to-call from the mobile number — lead list
- [x] E6 Shared ActionMenu component, driven by capabilities
- [x] E7 Action menu on lead detail
- [x] E8 Action menu per row on lead list
- [x] E9 Bulk actions on multi-select (reassign, campaign, dialler)
- [x] E10 Superadmin and Admin hold every action by default
- [x] E11 Actions the role lacks are hidden, and the API refuses them anyway
- [x] E12 Tests for consent, click-to-call and action gating
- [x] E13 Verified in browser at 3 widths

## F · Market data (NSE / BSE)
_Requested 22 Aug 2026. Decisions taken with the user._

| Question | Decision |
|---|---|
| Source | **Bonanza's existing licensed feed.** Vendor not yet named — built behind a normalised contract with a working simulated provider, so it runs today and goes live when credentials land in `server/.env`. |
| Content | Index strip (NIFTY 50 / SENSEX / BANKNIFTY), market news headlines, corporate actions & results calendar, IPO / NFO calendar. |
| Placement | Cockpit banner, login page, a dedicated Market tab, and the lead detail sidebar. |
| Compliance | **15-minute delayed, with a visible disclaimer and timestamp.** Nobody should trade off a CRM screen, and delayed data on the public login page avoids a real-time public-display licence. |

**Open with the user:** which vendor the licensed feed is (Global Datafeed,
TrueData, in-house gateway, …) and whether the licence permits unauthenticated
display on the login page.

**Not possible yet:** tying market moves to client holdings ("4 of your clients
hold Reliance"). No instrument or position data exists in any of the 51 tables.
The lead sidebar therefore keys off *product interest* instead, which does exist.

- [x] F1 Market data adapter — normalised contract, simulated provider
- [x] F2 Staleness and delay stamped on every payload, fail-closed on outage
- [x] F3 Cache layer so the feed is not hammered per page view
- [x] F4 Public index endpoint for the login page — no session, rate limited
- [x] F5 Authenticated endpoints — news, corporate actions, IPO/NFO
- [x] F6 Index strip on the cockpit banner
- [x] F7 Index strip on the login page
- [x] F8 Dedicated Market tab
- [x] F9 Lead detail sidebar, keyed off product interest
- [x] F10 Disclaimer component, shown wherever figures appear
- [x] F11 Tests
- [x] F12 Verified in browser at 3 widths

## G · Campaigns & Meta connectors
_Requested 22 Aug 2026._

**What was actually wrong:** `campaign.manage` was already held by Superadmin,
Admin and Marketing Manager. `POST /campaigns` existed but the screen had no
Create button, and there was no `PATCH` or `DELETE` at any layer — so editing a
campaign was impossible for every role, permissions notwithstanding.

| Question | Decision |
|---|---|
| Meta scope | **All four** — Lead Ads inbound, ad campaign publishing, Custom Audiences, Messenger/IG DM inbox. |
| Meta prerequisites | Business Manager and app **already exist**. Still needed: app ID, page IDs and a test lead form. Credentials go into `server/.env` directly, never through chat. |
| WhatsApp campaigns | **Existing Smartping connector.** No second WhatsApp integration. |
| Campaign actions | Duplicate, Schedule, Pause/Resume, Test send, Recipient preview, Archive/Delete. |

### Flagged: Custom Audiences vs the residency rule

Pushing a segment to Meta sends hashed client identifiers to Meta's servers —
**client data leaving India**, which contradicts the standing constraint set at
the start of this project. Lawful under DPDP with consent and standard industry
practice, but it is the user's own rule that it breaks, at a SEBI-regulated
broker.

Built behind `CRM_META_AUDIENCES_ENABLED`, **off by default**, with the
conflict stated on the screen that enables it. The other three Meta features
carry no such tension.

### G1 · Campaign management
- [x] G1.1 **Consent on campaign send** — currently sends to every list member with no opt-out check
- [x] G1.2 `PATCH /campaigns/:id` — edit
- [x] G1.3 Duplicate, archive, delete
- [x] G1.4 Schedule, pause, resume
- [x] G1.5 Test send to the signed-in user
- [x] G1.6 Recipient preview with excluded count and reasons
- [x] G1.7 Campaign create/edit UI with every action button
- [x] G1.8 Tests

### G2 · Meta connector
- [x] G2.1 Adapter + config, normalised contract, simulated provider
- [x] G2.2 Lead Ads webhook → lead, tagged to source and campaign
- [x] G2.3 Messenger / Instagram DM → interaction timeline
- [x] G2.4 Ad campaign publish + spend/results pull-back
- [x] G2.5 Custom Audiences **behind the compliance flag, default off**
- [x] G2.6 Connector setup screen
- [x] G2.7 Tests

## H · Advanced search
_Requested 22 Aug 2026._

**Feasibility:** high. The recursive AND/OR condition tree already exists with
dual evaluators and 25 passing tests. Two gaps: the field registry is lead-only
and hardcoded, and the blank / is-defined / is-not-defined operators the user
asked for do not exist yet.

| Question | Decision |
|---|---|
| Objects | **All of them** — leads, activities, campaigns, cases, tasks, partners, clients. |
| Saved searches | **Save as a reusable Segment**, kept as a live query so membership never goes stale. |
| Custom fields | **Searchable automatically.** A field added in Setup is filterable with no code — the payoff from the metadata layer. |
| Result actions | Bulk actions, CSV export, save as campaign audience, and plain paging. |

**Security note, not asked:** a filter is a data-exfiltration channel. Someone
who cannot read PAN must not be able to binary-search it either
(`pan starts_with A`, `AB`, `ABC`…). Field-level security therefore applies to
*filterable* fields, not only to returned ones. CSV export is gated behind its
own capability and every export is logged with row count and the filter used.

- [x] H1 Generalise the field registry — per entity, derived from metadata
- [x] H2 New operators: is blank, is not blank, is defined, is not defined, ends with, between
- [x] H3 Custom fields filterable through the value store
- [x] H4 Field-level security applied to filterable fields
- [x] H5 Search API — tree in, paged results out
- [x] H6 Advanced search UI — condition rows, AND/OR, nesting
- [x] H7 Save as segment (live query)
- [x] H8 Bulk actions on a result set
- [x] H9 CSV export, capability-gated and logged
- [x] H10 Save result as a campaign audience
- [x] H11 Tests
- [x] H12 Verified in browser

## Carried over from earlier work

- [x] Condition tree — one recursive query model, dual evaluators
- [x] Computed metrics — `lead_metrics`, versioned `score_models`
- [x] Roles as data — `roles` / `role_capabilities` / `permission_sets`
- [x] Disposition matrix + follow-up intelligence
- [x] Vendor adapters — CUBE, Smartping, Bonanza KYC
- [x] Metadata layer — entity/field/picklist as data, label ≠ API name
- [x] Field-level security — the interaction split
- [x] Object Manager UI
- [x] Modal overlay defect fixed app-wide

## Still queued after this batch

- [x] Formula + Roll-Up evaluators — curated set, validated at creation, computed on read, Setup builder, 23 tests
- [x] Polymorphic owner + Queue entity — `owner_queue_id`, role-based membership, claim/place, assignment falls back to a queue rather than to nobody, 16 tests
- [x] OWD Private floor + sharing rules — manager chain at any depth, grant-only layers, one role's reach genuinely reduced, 12 tests
- [x] Approvals engine — all four scopes, generic engine, record locked while pending, self-approval refused, rollback on failure, 23 tests
- [x] Automation builder UI — visual IF/THEN builder shipped. Condition and action
      vocabulary comes from the server, so a new field or action type appears in
      the form with no client change. Rules are always created **disabled**, and
      the primary button is *Save and dry-run*, not Save — a rule that fires on
      495k leads is one you want to have tested first.
- [x] Drop `leads.kyc_status` mirror — derived from the journeys and the eKYC portal; **it had already drifted on 2 of the 6 seeded leads with a journey**, column now dropped
- [x] Holiday calendars (office + NSE/BSE) — two calendars, half-days, wired into the SLA clock and follow-up scheduling, 20 tests
- [x] Migration map — `docs/migration-map.md` written from the audit. Routes all
      ~330 legacy fields by domain, ranks the cutover risks, and lists the five
      aggregate exports still needed to close the open decisions.
- [x] Per-channel consent — the one migration blocker that needed no export.
      Legacy holds four independent withdrawals (DoNotCall/Email/SMS/Track);
      the CRM had one boolean, which could only over- or under-block.
- [x] Data-quality analyser — `server/src/analyze-export.js`. Turns a raw CSV
      export into the five aggregates, and cannot leak PII: value lists are
      produced only for picklist-shaped fields and never for identifier-named
      columns. Verified against a synthetic export — zero PII in the output.
- [ ] **Blocked on the user:** run the export from LeadSquared and the analyser
      over it. Only Bonanza has tenant access.

---

## Defects found and fixed while doing the above

Not on the original list — found by looking.

- [x] **`.public-body` was capped at `max-width: 440px`**, and `.public-wide` /
      `.public-head` had no CSS rules at all. This was the root cause of the
      reported "not utilising the entire page" on both portals. They now use a
      shared full-width shell.
- [x] **`.backdrop` / `.modal` / `.modal-lg` had no CSS whatsoever.** Every
      dialog in the application rendered inline ~1,100px below the fold instead
      of over the page — clicking "Create user" appeared to do nothing. Fixed
      app-wide; overlays are now 98.4% opaque, never glass.
- [x] **The partner funnel was not monotonic** — it read 2 → 0 → 0 → 2 → 1
      because CRM stage and KYC status are independent tracks. Now computes how
      far each client actually reached, so each row is a subset of the one above.
- [x] **The donut centre disagreed with its own legend** (2 clients vs 4
      interests). It counts interests now, and says so.
- [x] **The edit form would have corrupted client phone numbers.** The lead
      payload masks PII, so the form seeded `••••••0000`; the phone input strips
      non-digits, so the first keystroke would have saved `0000` over a real
      number. The form now fetches through the audited `?unmask=true` path, and
      any value still masked is locked with the reason shown.
- [x] **The metadata test suite deleted every custom field in the database**,
      not just the ones it created. Pointed at a database with real
      configuration it would have destroyed it. Cleanup is now scoped by name.
- [x] **The e2e suite left seeded users deactivated**, so it passed exactly once
      per reseed and then failed with 30+ cryptic 401s. It now restores the book
      and reactivates.
- [x] Product cards on a lead buried the three engaged products under eight
      "Not engaged" ones. Engaged now sort first; the rest fold behind a count.
- [x] Reference values (source, language, risk profile, stage) were scattered
      between `db.js` constants, hard-coded `<select>`s and whatever happened to
      be in the column — which is how a lead came to be sourced from "Carrier
      Pigeon". They are picklist rows now, validated at the API.

## Defects found while building section E

- [x] **`.login-wrap` / `.login-card` / `.login-role` had no CSS at all** — the
      third instance of this pattern. The eleven role buttons were bare browser
      defaults flowing inline, which is what "not aligned properly" was.
- [x] **The consent flags were not writable.** `mobile_invalid` and
      `marketing_opt_out` were missing from the lead PATCH field list, so the
      edit form offered both as checkboxes, reported a successful save and
      discarded them. An RM ticking "opted out" after a client asked them to
      stop changed nothing. Caught by the new consent tests.
- [x] **Nothing enforced consent before an outbound send.** The disposition
      matrix set the flags, segments filtered on them, and no call or message
      path ever read them. Now enforced at the API for every channel.
- [x] **`useLeadActions` was hoisted above the state it closes over** in
      LeadDetail — a temporal-dead-zone error that built cleanly, passed every
      test, and rendered a blank page. Only the browser check caught it.
- [x] Two of my own new tests asserted wrong premises (a shared fixture flagged
      by an earlier suite, and a capability every seeded role actually holds).
      Corrected rather than deleted.

## Defects found while building section F

- [x] **`.login-card` overflowed the viewport on a phone.** `width: 100%;
      max-width: 620px` under `place-items: center` sizes a grid item to its
      content, so the market ticker widened the card to 620px inside a 375px
      screen even though the ticker has its own scroller. Now flex-centred with
      a viewport-relative `min()` that no ancestor can defeat.
- [x] **The topbar overflowed at 375px** — pre-existing, unrelated to the market
      work. The user menu sat 47px past the right edge and put the whole page
      into horizontal scroll on every screen. The search field now yields first.
- [x] The Market nav item first landed in the Configuration section, where every
      role without admin capabilities lost it. Navigation is server-driven from
      `apps.js`, not the client `NAV` const — moved and added to four apps.

## Logos — done 22 Aug 2026

- [x] Real Bonanza and Bigul marks, downloaded from the companies' own sites
- [x] Light and dark variant for each, switched in CSS so the right one is
      correct on the first frame rather than after a JS check
- [x] Applied to the CRM topbar, login page, KYC portal and partner portal
- [x] **Defect fixed:** the two Bonanza files declared `width`/`height` that
      disagreed with their own viewBox (120×73 against a 231×89 box), so the
      logo visibly resized when the theme flipped. Stripped so the viewBox
      governs.
- [x] Provenance recorded in `client/src/assets/SOURCES.md`

## Notes from building advanced search

- The value control for a picklist field used to be a dropdown for **every**
  operator, so `source contains …` could only contain a whole existing value —
  nearly useless, since that is what `equals` is for. Now a dropdown for
  exact-match operators and free text with suggestions for partial ones.
- `is not equal to` needed a `COALESCE`: without it SQL drops rows where the
  field is null, while the in-memory evaluator treats null as not-equal-to
  everything. The two would have disagreed silently. Caught by the paired
  evaluator test, which is exactly what that test exists for.
- Owner-scoped fields (`interaction.body`, `recording_url`) are **not**
  filterable at all. Their rule is per record — the owner and their managers —
  and a WHERE clause cannot express that, so offering them would enforce the
  wrong thing rather than nothing.

## Notes from building the Meta connector

- `verifyWebhook` first returned a boolean, but the shared webhook guard expects
  `{ ok, reason }`. It would have refused every delivery. Fixed to match.
- The webhook first called `runEnabledRules('lead.created', id)` — but that
  function takes no arguments and is the automation tick, not a per-lead
  router. It would have silently routed nothing. Now calls `assignLead`, which
  is what every other inbound lead uses, so the seeded
  "Facebook Lead Ads → Digital Desk" rule finally has leads to act on.
- `leads.external_id` did not exist. Added — it is what dedupes Meta's retries
  and matches an inbound DM back to someone already in the book.
- Express now keeps the raw request body. Meta signs the exact bytes it sent,
  and re-serialising the parsed JSON changes whitespace and key order, so the
  HMAC would never have matched a legitimate delivery.
- Ad campaigns are created **PAUSED**, always. A CRM button that begins spending
  real money the instant it is pressed is a bad idea however good the
  confirmation dialog; a human starts it in Ads Manager having seen it.
- An unknown sender's DM is **not** turned into a lead. A Messenger id is not a
  contact detail, and a CRM full of records nobody can ring is worse than a
  missed message.

**Still needed from the business:** the Meta app ID, page IDs and a test lead
form. Credentials go into `server/.env` on the server, never through chat.

## Notes from the KYC mirror and the calendars

**`leads.kyc_status`** had four writers and every reader, and had already
drifted on **two of the six seeded leads that have a journey at all** — lead 2
read "In Progress" against a Stalled journey. Now derived from the journeys and
the eKYC portal, with the column dropped so nothing can read a stale one.

One judgement call: when a lead has several journeys, the *furthest* wins rather
than the newest. KYC in India is per client, not per product — completing it
once for equity does not get un-completed by a stalled mutual-fund journey.

**Working calendars.** `engine/sla.js` had always claimed in its own docstring
to skip "nights, Sundays and holidays". There was no holiday data anywhere, so
it skipped nights and Sundays and counted every Diwali as a working day — an SLA
raised before a three-day closure reported a breach nobody could have prevented.

- Two calendars, because the office (Mon–Sat) and the exchange (Mon–Fri) are
  different weeks and diverge often.
- Half-days are distinct from closures, so Muhurat trading is expressible.
- **Only fixed-date holidays are seeded.** Holi, Diwali, Eid and Dussehra move
  with the lunar calendar and come out in an NSE circular each year — inventing
  them in code would be worse than leaving them out. A test asserts they are
  *not* present, so nobody adds a guess later.
- **A defect I introduced and caught:** the first `addWorkingMinutes` stepped in
  five-minute slices and re-walked the calendar on each one. It hung the server
  on boot. Rewritten to jump whole days; 200 SLA computations now take under
  three seconds, asserted by a test.

## Notes from queues and the Private floor

**Queues.** `assignLead` used to leave an unroutable lead at `owner_id = NULL` —
on nobody's worklist until a report found it. Now it lands in a queue, stays
visible to the desk that can take it, and is claimed by a named person. A test
asserts no lead is ever owned by a person *and* a queue at once.

**The Private floor, and an honest correction.** My first measurement claimed
Product RM gained 38 leads. That was **my own measurement error** — the baseline
query omitted `product_type_id`, so product scope matched nothing. Re-measured
with identical inputs, the delta across every role was zero.

Which exposed the real problem: my code comment claimed `lead.view.all` was "no
longer a short-circuit" while the code still short-circuited on it. The comment
was a lie, and a lie in a comment is worse than the behaviour.

What was actually wrong was configuration, not code. `lead.view.all` was held by
six roles, five of them declared `org` scope — consistent. The sixth, Sales
Supervisor, is declared `team`, so `data_scope` was decorative for that role and
the two could disagree. The capability now belongs only to roles declared `org`,
and Sales Supervisor reaches its team through the management chain instead.

Two things that made this land:
- **The chain follows reports to any depth.** The old `team` scope was direct
  reports only, so a regional head above two desk supervisors saw neither desk's
  leads. A hierarchy that works one level deep is not a hierarchy.
- **`seedAccessModel` could only add grants, never withdraw them**, so removing
  a role from the matrix had no effect on an existing database. It now revokes
  grants withdrawn from *shipped* roles only, logs what it did, and leaves
  administrator-made permission sets alone.

Verified by construction rather than by counting: a lead in the same sales org,
owned outside the supervisor's chain, is **hidden** from them and **visible** to
an org-scope Admin.

## Notes from approvals and automation health

**Approvals — one engine, four scopes.** The four scopes have nothing in common
in the business and everything in common as software: a request with a reason, a
rule for who decides, a record locked while it waits, a decision with a reason,
an audit trail that survives both outcomes. Written four times those five things
end up subtly different four times.

Three properties the tests exist to hold:
- **Self-approval is refused**, whatever capabilities the requester holds. An
  approval you can grant yourself is a log entry, not a control.
- **The record is frozen while a decision is pending**, enforced on the write
  path. If a commission can still be edited while a change to it awaits
  sign-off, the approver puts their name to a number that has moved.
- **A failing action rolls the decision back.** An approval recorded against
  something that did not happen is worse than no approval at all.

**Automation health (non-negotiable 12).** `rules.js` had no `catch` anywhere:
one action throwing — a dead number, a deleted template — aborted the whole run,
silently skipping every lead after it, with nothing recording that it happened.

- Each action is now attempted independently and failures land in a queue.
- Static conflict detection reports pairs of enabled rules that write the same
  field to different values, and says which priority wins.
- It deliberately does **not** attempt to prove two condition sets can both be
  true. That is satisfiability, and a cheap approximation that says "no conflict"
  when there is one is worse than not checking — so it reports possible overlaps
  and leaves the judgement to someone who knows the book.
- Rules sharing a priority are reported separately: ordering is only explicit if
  it is actually ordered.
