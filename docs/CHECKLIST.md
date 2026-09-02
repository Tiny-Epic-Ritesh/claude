# Build checklist

Live tracker. Updated as each item lands. **Do not delete completed rows** —
the record of what shipped is as useful as the list of what has not.

Legend: `[ ]` pending · `[~]` in progress · `[x]` done

**Status: 123 done, 1 open** (2 Sep 2026). The single open item is blocked on
the business, not on development: the LeadSquared export has not been run.

**Tests: 1,105** — 576 end-to-end and 529 unit. All green.

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

---

## Lead lists rebuilt to market standard — done 2 Sep 2026

Triggered by the observation that the lead list was "not upto the mark … does
not have all the features available in market". Checked against the Salesforce
List View anatomy (`docs/salesforce-reference/ui-layer.md` §3) and the
LeadSquared lists audit (`docs/legacy-leadsquared/views-tasks-lists.md`), which
between them describe the 4,810-list failure and the shape of the fix.

The legacy signal: **4,810 lists against 495,118 leads**, with names like
`All Active Clients 210826.csv` — someone exports to Excel, filters there,
re-imports as a static list, uses it once, never deletes it. Daily habit.

- [x] **Governance.** A live list is the default; a snapshot must state a
      reason and an expiry (90 days unless said otherwise). Lapsed snapshots
      archive rather than delete — a campaign may still reference one.
- [x] **The API default is `refreshable`** (was `static`). A default is the
      choice most records end up with, so the path of least effort was
      producing the exact thing the 4,810 were made of. Refreshable rather than
      dynamic because dynamic "is never safe to send a campaign to", and a
      default should not remove a capability from someone who stated no
      preference. Exposed as `default_kind` on `/lists/meta` and read by the
      new-list form, so the two cannot drift.
- [x] **The saved-search hole.** `POST /search-advanced/lead/to-list` inserted
      a static list directly and skipped every check. It is the easiest way in
      the product to make a snapshot, so it was the hole the rule would have
      drained through. Now stamps its own reason and expiry.
- [x] **Nested query builder.** The engine supported AND/OR trees over 27 typed
      fields since it was written; nothing exposed the catalogue, so the only
      expressible filter was a single stage from a dropdown. That gap is what
      sent people to Excel.
- [x] **Export**, audited by row count and filter, masked unless the exporter
      holds `pii.unmask`.
- [x] **Import** on client code, mobile or PAN, reporting misses by value —
      "43 did not match" is not actionable; the 43 values are.
- [x] **Column chooser.** The choice belongs to the list, not the viewer, since
      a list is a shared object.
- [x] **Four more bulk actions** — dialler, field edit, membership, delete.
      Delete is soft, gated on `lead.delete`, and needs the count typed.
- [x] **Pagination.** The table showed at most 100 rows of any list with no
      control to reach the rest and no indication rows were missing. On the
      legacy tenant, lists of 12,519 and 21,379 were routine — that table
      showed half a percent of one and presented it as all of it.
- [x] **Sort on every column.** Rows came back hard-ordered by `updated_at`.
      "Who in this list holds the most" was a question you answered by
      exporting, which is the habit the rest of this work exists to end.
- [x] **Search within a list** (Salesforce's "Search this list…"). Narrows the
      view only: `member_count` is deliberately unaffected, so a search cannot
      shrink what a bulk action takes. Covered by its own test — a search
      followed by "delete all" still demands the full count and refuses.

### Notes from building it

- **`.btn-danger-ghost` rendered grey.** `.btn-sm` is declared later and the two
  tie on specificity, so source order decided it — the same trap `.btn-primary`
  hit before. Written now as a compound selector that wins by weight.
- **Three e2e fixtures created snapshots with no reason** and now state one.
  That is the new contract, not a test workaround.
- **The icon scanner flagged `sort`**, which is not an icon here —
  `query.set('sort', sort)` is a parameter name. The scan already strips two
  false-positive contexts (`className`, `key:`/`group:`); a `.set`/`.get` first
  argument was a third, and is stripped now rather than adding a dead glyph.
  `view_column`, `upload`, `unfold_more` and `chevron_left` were real and were
  added to the subset.


---

## The account book checked the same way — done 2 Sep 2026

Same method as the lead list: read `Clients.jsx` and `routes/clients.js` against
the Salesforce List View anatomy. The filters, chips and drill-through tiles
were already good; three things were missing and one was an outright absence.

- [x] **Sort on every column.** `ORDER BY c.activated_at DESC`, hardcoded. The
      columns here are Holdings and Brokerage YTD, so "who are my largest
      clients" is the question this tab exists to answer, and the only way to
      ask it was to copy the table out. Whitelisted, because it lands in an
      ORDER BY.
- [x] **Pagination and a row count.** The tab asked for `limit=200` and rendered
      whatever came back. Worse than the lead list's version of this: the
      Accounts tile above stated the true total, so a book of 900 showed two
      hundred rows under a tile reading 900, with nothing to explain the
      difference.
- [x] **`X-Total-Count` is now readable.** Three routes have been sending it to
      a client that discarded it — `api.js` never surfaced headers, so no table
      in the product could show a total it did not compute itself. Attached to
      the returned array as a non-enumerable `total` and surfaced by `useApi`,
      which keeps the bare-array contract those routes deliberately chose.
- [x] **Export.** Clients were the only object in the system with none — leads,
      interactions, cases, tasks, partners, campaigns and product interest all
      have one through `/search-advanced`. For a broking CRM the account book is
      the revenue, so the most valuable table was the one nobody could take out.
      Audited with row count, columns and the filter used; masked unless the
      exporter holds `pii.unmask`; capped at 5,000.

### Notes

- **The export shares the list's filter builder.** Extracted to `clientFilter()`
  and used by both, so what leaves is what was on screen. An export that
  rebuilt those conditions would eventually disagree with the table it came
  from, and "which accounts were in that file" is the question asked afterwards.
- **A test of mine was passing for the wrong reason.** "Unmasking an export is a
  permission" used Customer Care, who is refused for lacking `data.export`
  entirely — the assertion never reached the unmask branch. Rewritten.
- **Every role holding `data.export` also holds `pii.unmask`** (superadmin,
  admin, sales_supervisor). The 403 on the unmask branch is therefore defensive
  rather than reachable, and the masked default is the only thing between an
  exporter and identifiers in the clear. Worth knowing before the role matrix
  changes.

### Still open on the account book

- [x] **Clients are in `SEARCHABLE`** — done 2 Sep 2026. The metadata was
      already there (`entity_def` had `client`, with 14 `field_def` rows); the
      entity had simply never been registered. 13 fields are offered, including
      the custom `service_tier` from the value store, and the builder is mounted
      on the Clients tab. Two security defects were found on the way and are
      recorded below.
- [ ] **No bulk actions.** Leads have eight. Clients have reassign on the record
      only. A bulk action over a *filter* rather than an explicit list is a
      different safety proposition to the lead-list ones and wants deciding
      before building.
- [ ] **No column chooser.** A lead list is an object that can own a column
      choice; the account book is a tab, so the choice would have to belong to
      the person. That is a preference store this system does not yet have.


---

## Clients added to advanced search — done 2 Sep 2026

The metadata already existed. What was missing was the registration, the scope,
and — as it turned out — two things that would have been unsafe to ship the
account book onto.

- [x] **`SEARCHABLE.client`**, joined to `users` so a result carries the owner's
      name rather than an id. The join is 1:1 on a primary key, so the COUNT
      that shares the table is unaffected.
- [x] **Its own scope entry.** The generic branch in `scopeFor` applies only the
      `sales_org` boundary. Client visibility is also a role question: an
      org-scoped role without `client.view.all` sees nothing, and a Product RM
      sees only accounts holding their product. Falling through would have let a
      Relationship Manager who owns one account read all four in their business
      through the search box while the Clients tab showed them one. Tested by
      asserting search and list return the same count for the same person.
- [x] **The builder mounted on the Clients tab.** The component already took an
      `entity` prop and was only ever mounted for leads.

### Two defects found on the way, both pre-existing

- [x] **An encrypted field was offered as a filter that could never match.**
      PAN is stored with randomised encryption, so `pan = 'ABCDE1000F'` compares
      plaintext against ciphertext that differs on every write. An exact,
      correct PAN returned zero rows while the builder described the filter back
      as "PAN is equal to ABCDE1000F". For a broker, "no lead has this PAN" when
      one does is how a duplicate account gets opened. Verified against live
      data before fixing. Encrypted fields are no longer offered on lead, client
      or partner. Exact lookup still exists through the blind index
      (`pan_bidx`, `routes/ccm.js`); wiring that into the builder — an eq-only
      operator over a hashed value — is a feature, not this fix.
- [x] **The CSV export never masked anything.** The docstring directly above it
      promised "masked fields stay masked — an export is not a way around
      field-level security" for as long as the route existed, and the code sent
      query rows straight to the file. Every mobile and email left in the clear,
      on every object, for anyone holding `data.export`. Now masked through the
      same `maskFor`/`maskRecords` the list screens use, with `?unmask=true`
      honoured for `pii.unmask` holders and recorded in the audit row.

### Notes

- **`registryFor`'s capability gate now has nothing to act on.** Every
  capability-scoped field in the schema is `encrypted_text`, so the exclusion
  above reaches them first. The gate is still what stands between a restricted
  non-encrypted field and a filter, so it is asserted directly rather than left
  to rot unnoticed.
- **A test asserted the bug.** "A capability-scoped field is filterable only by
  a holder" checked that a `pii.unmask` holder *could* filter on PAN. They
  could — it just never matched. Rewritten to assert the stronger property:
  nobody can filter it, so nobody can probe it a character at a time either.
- **Two of my own new tests passed for the wrong reason before being fixed**:
  one matched on `entity` (the display name) instead of `key`, and one asserted
  against a parsed object for a `text/csv` response, so the masked half passed
  without reading a row. Both now assert the row count first.


---

## The case queue checked the same way — done 2 Sep 2026

Same method again, and this one had a live privilege escalation in it.

- [x] **Search was showing cases the queue refuses.** `SEARCHABLE.case` had
      `scope: 'none'`, so advanced search fell through to the generic branch —
      which applies the `sales_org` boundary and nothing else. Because `tickets`
      does carry a `sales_org` column, the generic branch found one and applied
      it, which made the gap look handled while every role rule was absent.
      Measured before fixing: a **dealer read 12 cases through the search box
      and 1 in the queue**; a caller 12 against 3; a Product RM 12 against 7.
      Now scoped through `ticketScope`, and every role's two numbers match.
- [x] **`reqTicketScope`**, for symmetry with leads and clients. The routes were
      calling `ticketScope(req.user, 't')` and dropping the active-org argument
      — exactly the "?org= does nothing" bug the comment beside `reqScope`
      warns about. Switching business narrowed leads and clients and left cases
      alone.
- [x] **Merged cases are excluded from search**, as the queue has always
      excluded them. This is why the two disagreed by exactly one row for every
      role even after the scope was fixed.
- [x] **Sort on the columns worth sorting.** Subject is a paragraph and the SLA
      figure is computed per row after the query, so neither is offered. The
      queue's own order — breached, then priority, then due soonest — stays the
      default and has a way back to it.
- [x] **Paging and a count.** The route had a hardcoded `LIMIT 300`, no offset
      and no total; the queue rendered whatever came back as though it were
      everything.
- [x] **Search within the queue** by reference, subject or the person it was
      raised for. There was no way to find one case except paging to it.
- [x] **Export**, audited and masked. The queue joins the client's name and
      mobile in, so it carries identifiers even though a case is not a person.
      It inherits the caller's scope as well as the filter — a supervisor
      exports 10 where an admin exports 11.

### Notes

- **The scope test was checked against the bug.** Disabled the fix, restarted
  the server, and confirmed the test fails with "dealer: expected 1, got 8"
  before restoring it. Worth doing because the first attempt at this proved
  nothing: the suite runs against a long-lived server on :4100, and editing the
  file without restarting means testing the old code.
- **A test of mine would have thrown.** The merged-case check called `one(...)`
  for a direct database read; `e2e.mjs` has no imports at all by design. It now
  merges two cases through the API, which exercises the path that creates the
  condition rather than depending on the seed.
- **A loop that skips every role reports success.** The scope comparison now
  counts the roles it actually compared and fails if that is not four — the
  shape of two mistakes already made in this suite.
- **A component defined in a render body remounts its subtree every render.**
  The sortable header was declared inside the queue, so the whole header row was
  torn down and rebuilt on every keystroke of the search box. Hoisted.


---

## Partners and campaigns checked the same way — done 2 Sep 2026

The last two searchable objects, and the worst finding of the four passes.

- [x] **Advanced search had no per-object capability gate at all.** It required
      a session and nothing else. A Caller is refused the Partners tab and the
      Campaigns list with a 403, and read **all seven of each** through the
      search box — partner codes, commercial state, campaign audiences and
      results. Fixed structurally rather than per route: the object declares
      what it requires, and one piece of middleware enforces it on search,
      count, ids, fields, save and export. Gating the search alone would have
      left five other doors into the same rows.
- [x] **The object picker no longer names what it will refuse.** The list of
      what exists is itself a disclosure, and it is a second, independent layer
      — verified by disabling the middleware and watching the picker test keep
      passing while the two gate tests failed.
- [x] **Partners narrow twice in search, as they do in the tab** — by book, and
      for a Partner RM to the partners they own. The seed happens to give that
      RM every partner in their book, so this one was latent rather than
      demonstrable; it is the same rule either way.
- [x] **Archived campaigns are out of the search**, as they are out of the list.
- [x] **The campaign list never applied the book boundary.** It selected every
      campaign regardless of `sales_org` — the same shape as the ticket list
      before August. Not demonstrable on this seed, where every campaign is
      Bonanza's, which is exactly why it survived.
- [x] **Neither list was bounded.** No `LIMIT` at all on either: the whole book
      came back on every call, with no count. Both now page, count, sort and
      search, and partners export — audited, masked, and inheriting the book
      and ownership rules because the list and the export read one filter.
- [x] **PAN and bank account are not exportable.** Both are encrypted at rest,
      so an export would ship ciphertext; naming them leaves nothing to export
      rather than quietly producing something useless.

### Notes

- **The gate was tested against the bug.** Disabled it, restarted the server,
  confirmed both gate tests fail, restored. Same discipline as the ticket scope
  — and the reason it matters is that the first attempt at that check on
  tickets proved nothing, because the suite runs against a long-lived server
  and editing a file without restarting tests the old code.
- **Four objects, four passes, one shape.** Leads, clients, tickets, partners
  and campaigns each had the same three list gaps (no sort, no paging, no
  count) and each of the last three had a scope or capability rule that the
  search path did not apply. The list route and its search are the same data
  with the same boundary, and fixing one of a pair is how the other stays
  broken — which is what the ticket list comment already said in August.


---

## Partner and campaign front ends wired up — done 2 Sep 2026

The server work above was only half of it; both tabs were still reading the
first page and calling it everything.

- [x] **Partners**: search, count, sortable headers, paging, and the export
      dialog. PAN and bank details are named in the dialog as never exported,
      because a column somebody expects and cannot find reads as a bug.
- [x] **The two partner tabs are a server-side group now.** They were made by
      pulling every partner and splitting the array in the browser, and the four
      tiles were sums over that same array. Honest while the list was unbounded;
      the moment it started paging, both would have described a page. There is a
      `?group=` filter and a `/partners/summary`, and a test asserts the
      tile and the tab agree and that neither follows the page size.
- [x] **Campaigns, both surfaces.** There are two: the marketing tab at
      `/campaigns` that people use weekly, and the Setup screen. Both read the
      same route, so both needed it. The Setup one is a table and got sortable
      headers; the marketing one is a card grid, so it got an order dropdown
      instead — a grid has no column headers to click.

### Note

- **A component declared in a render body remounts its subtree.** Same fix as
  the case queue, in both new headers: declared at module scope so the header
  row is not torn down and rebuilt on every keystroke of the search box.


---

## Tasks and interactions — done 2 Sep 2026

The last two searchable objects, and the largest exposure of the five passes.

- [x] **Neither was scoped at all.** Tasks and activities carry no
      `sales_org` column, and the generic branch in `scopeFor` gives up
      when it cannot find one — it returns no scope rather than failing closed.
      So advanced search over these two returned **every task and every
      interaction in the system, across both books, to anybody signed in**: 194
      interactions with their subjects, bodies, dispositions, recording URLs and
      captured locations, and 46 tasks each labelled with its lead's name. That
      includes 36 Bigul interactions and 7 Bigul tasks visible to Bonanza staff,
      which is the standing data-residency rule broken in both directions.
- [x] **Both are scoped through the lead now**, which is where the book lives.
      An interaction with no lead is a partner interaction — 18 of them and no
      other kind — so those are scoped through the partner's book instead of
      being left visible for want of a lead. Tasks additionally keep the list's
      own ownership rule: your own unless you hold `report.team`.
- [x] **The task list is bounded, counted, sorted and searchable.** It had no
      `LIMIT` at all.
- [x] **The task tiles count the list rather than the page**, via a
      `/tasks/summary` that shares the list's scope clause. Open, Overdue and
      Completed were computed in the browser from whatever the fetch returned.
- [x] **Priority sorts by meaning.** The CASE was copied from tickets, whose
      vocabulary has no `Normal` — and tasks default to it. Normal and Low
      shared a bucket until all five values were named.
- [x] **Interactions have no general list surface** — they appear as per-lead
      timelines, which are bounded and were already scoped. Advanced search is
      their only general surface, so the scope fix is the whole of the work
      there. Nothing was invented to give them a list they do not have.

### Notes

- **Verified against the bug.** Both scopes disabled, server restarted, three
  tests fail, restored. Same discipline as the ticket and capability fixes.
- **One of my own tests overpromised.** "An interaction search never crosses the
  book" fell back to a Bonanza token when no Bigul one was in scope, so it would
  have passed without testing a book boundary at all. It signs in as a real
  Bigul user now and reads back every lead the returned interactions name.

### The shape, across all seven objects

Leads, clients, tickets, partners, campaigns, tasks and interactions each had
the same list gaps, and five of the seven had a scope or capability rule the
search path did not apply. The list route and its search are the same data with
the same boundary — the comment on the tasks list said so in August, about the
last time this exact thing happened.


---

## The generic search scope fails closed — done 2 Sep 2026

The thing that made two of the last three leaks silent, fixed at the cause.

- [x] **" I cannot work out what you may see" no longer means "then see
      everything".** The generic branch in `scopeFor` returned
      `{ sql: null }` — no filter — in three separate situations: an entity
      it did not recognise, a table with no `sales_org` column, and a user
      with no orgs. It refuses now. A searchable object with no scope of its own
      returns nothing until somebody gives it one, which is a visible, reportable
      emptiness rather than a silent disclosure.
- [x] **A seventh leak, found by looking for what the change would break.**
      `product_cards` carries no `sales_org`, so
      `product_interest` was in exactly the position tasks and interactions
      were: a Caller read all 570 cards, 118 of them on Bigul leads. Scoped
      through the lead now — a caller sees 70, an admin the 452 that are
      Bonanza's.
- [x] **The refusal says so.** A table with neither a `sales_org` column
      nor a branch is a coding mistake rather than a state of the world, so it
      warns by name to the server log rather than only returning nothing.

### Verified

- Registered a temporary searchable object over a table with no
  `sales_org` and no branch: it returned 0 of 6 rows and logged
  `[search] probe_unscoped has no sales_org and no scope of its own`.
  Removed afterwards.
- Disabled the new `product_interest` branch and both new tests failed —
  the object fell through to the refusal and came back empty, which is the
  guard working and the tests noticing.
- One of the two tests checks every searchable object returns rows to a
  superadmin. That is the outside-in way to assert nothing has fallen through
  the refusal, since `scopeFor` is not exported.


---

## Record detail pages checked the same way — done 2 Sep 2026

The reads were in good shape; `bookscope.test.mjs` already asserts fourteen
record routes refuse the other book, and probing six detail routes for
within-book role rules found five correctly refused. The sixth was a false
alarm of my own: a list that looked reachable turned out to be explicitly
shared with that role.

The writes were another matter. That conformance test covers reads only, and a
route that will not show you a record but will let you change it is worse than
one that shows it.

- [x] **`PATCH /leads/:id` never checked which lead.** It gated carefully
      what a caller may change — stage and owner each need a capability — and
      loaded the record by id alone. A Bonanza dealer could edit a Bigul lead's
      name, mobile, city and consent flags. It goes through `loadInBook`
      now, the accessor the conformance test blesses.
- [x] **`PATCH /tasks/:id` had no check of any kind.** It updated by id and
      returned the whole row, so it was a write primitive over every task in the
      system — reassign, reschedule, close — and a read primitive besides. A
      Bonanza dealer changed a Bigul task and read its description back. It now
      applies the rule the Tasks list applies: the lead's book, and your own
      unless you hold `report.team`.
- [x] **Both verified by weakening them** and watching the tests fail, then
      restored.

### Notes

- **`loadInBook` is not the tool for tasks.** A task with no lead has no
      book, and that accessor refuses a record whose org is null — which would
      take standalone reminders away from the people they belong to. The route
      carries the list's own rule instead.
- **A heuristic scan flagged 44 write routes with no scope helper in view.**
  That was a finder, not a verdict: most scope inside a helper or beyond the
  window it read. Only the two above accepted a cross-book write when actually
  tried, and product cards and notes correctly refused.
- **Tickets could not be tested across the book** — every seeded ticket is
  Bonanza's — so `PATCH /tickets/:id` and its CSAT route are untested
  rather than clean. Worth a Bigul ticket in the seed.
- **My first ownership test passed against the bug.** The lead scope runs first,
  so for most pairs of users the refusal is already a 404 and the ownership
  branch never executes. The test now builds the one shape that reaches it — a
  task on a lead the caller owns, assigned to somebody else — and fails when
  that branch is disabled.


---

## A Bigul case in the seed, and the four things it found — done 2 Sep 2026

Asked for a Bigul ticket so the untested ticket write routes could be tested.
The seed gap turned out to be a symptom rather than an oversight.

- [x] **The create route never set `sales_org`.** The column defaults to
      'BONANZA', so every case ever raised landed in Bonanza's book whoever
      raised it and whoever it was about — a Bigul case readable by Bonanza
      staff and missing from the queue of the people it belonged to. It derives
      the book from the subject now: the lead, else the card's lead, else the
      partner, else the raiser's active org. The subject decides, not the author.
- [x] **Two seeded cases already sat on Bigul leads** and were marked Bonanza
      for that reason. The seed sets the book from the lead now, gives Bigul
      cases a `BGL-` reference like every other Bigul record, and both
      assigns and raises them within their own book — the scope grants sight to
      whoever is assigned or raised a case, so both halves have to be somebody
      real in that book.
- [x] **The reference prefix was hardcoded `BNZ-`** for every case, in a
      two-brand firm that uses BGL everywhere else.
- [x] **Auto-assignment ignored the book**, so a Bigul case could be assigned to
      a Bonanza agent — who cannot read the queue it is in. It picks within the
      case's book now, and leaves it unassigned rather than assigning across:
      unassigned in the right book beats assigned in the wrong one.

### And then the seed change found three more

- [x] **`PATCH /tickets/:id` and `POST /tickets/:id/csat` both accepted
      cross-book writes.** The first gated reassignment on a capability and
      never checked which case; the second checked nothing at all. Both go
      through `loadInBook` now. These are the routes recorded as *untested
      rather than clean* in the previous entry — they were not clean.
- [x] **The case tiles counted a different set than their own drill-through.**
      They filtered on the org *switcher*, which is null unless somebody has
      explicitly switched business, so by default they counted both books while
      the list showed one — and ignored the role rules besides. They share the
      list's scope now, so the tile and the list agree by construction.
- [x] **A unit test was asserting the fixture, not the rule.** "The book
      boundary survives the new rule" included superadmin, a role that reaches
      both books by design and is asserted to do so elsewhere. It only passed
      while every seeded case was Bonanza's.

### The point

A seed where every row of a kind sits in one book cannot test a boundary. Three
live defects and one false test were hiding behind two rows of missing data.
