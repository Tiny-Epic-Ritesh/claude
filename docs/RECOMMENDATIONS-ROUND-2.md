# Recommendations — Feedback Round 2

**Source:** `bonanza-ai-crm-feedback-part-2.md`, Ritesh, 31 Aug 2026
**Status:** Section C answered below. Four decisions confirmed by Ritesh on
31 Aug 2026; the rest still open.

## Confirmed 31 Aug 2026

| Ref | Decision |
|---|---|
| **A-1** | **Responsive web on mobile.** No native app. Mobile layouts to be audited and fixed as part of the work; a native app, if ever wanted, is scoped separately. |
| **A-5** | **P2-03 is configuration promotion, and Production does not exist yet.** Standing up Production is an infrastructure task that comes before any of P2-03. Code promotion stays with CI/CD. |
| **A-3** | **SMTP now, Outlook per user later.** SMTP unblocks the composer immediately and carries system and campaign mail; per-user Outlook is added when Compliance rules on Graph. |
| Sequence | **Workstream 1 starts now** — P2-07, P2-10, P2-18, P2-24, P2-11 — while the remaining questions are settled. |

## Confirmed later on 31 Aug

| Ref | Decision |
|---|---|
| **Q-09** | Lead Score / AUM / Owner move into the record header (option 1). Done. |
| **P2-09** | Hand-built toolbar, no editor dependency. Personal templates free, firm-wide ones approved. Merge fields validated against `field_def`. Done. |
| **P2-12** | Replace the state counts with the one next step, inline, with the button that performs it. Done. |
| **Q-06** | Object and field level through the UI; record level already works via `data_scope`. System roles can be cloned, never deleted — label editable, code frozen. |
| **A-6** | Lead, Client and Ticket as the first three objects for P2-21. |
| Order | P2-12 → drill-through (P2-13/16/17c) → P2-05 → P2-21. |

**Still open:** Q-11 (vendor accounts, A-4) and Compliance on Microsoft Graph.
Q-05 / A-2 (CUBE) was **answered 31 Aug** — see below and
`docs/integrations/CUBE-QUICKCALL-API.md`.

---

## Workstream 1 — status

| ID | Status | What changed | How it was tested |
|---|---|---|---|
| **P2-07** | **Done** | `Leads.jsx` column header now reads `Products`. Display label only — `card_state` and `product_cards` untouched, per the ENH-10 rule. | Browser: the column reads PRODUCTS. |
| **P2-10** | **Done** | Base input rule's eight `:not()` exclusions wrapped in `:where()`, dropping it from (0,8,1) to (0,0,1) so the search box's own resets win. | Computed styles before: input had its own 1px border, glass background, 9px/12px padding inside the pill. After: `0px` border, transparent, no padding — one box. Checked a form input elsewhere still gets full styling. |
| **P2-18** | **Done** | `.tabs` scrollbar was hidden on both engines (`scrollbar-width: none` plus the webkit rule). Now a slim styled bar. | Setup has 18 tabs, 710px overflowing, 7 unreachable — Working calendars through Audit log. After: scrolls the full 710px, last tab reachable. Tasks (2 tabs) shows no scrollbar, so the other 11 screens are untouched. |
| **P2-24** | **Done** | The menu never flipped when there was no room below, so on a row near the foot of the table it ran past the bottom of the window. Nothing obscured or clipped it — it was drawn where the reader could not see. Setup has its own copy of the menu separate from the record ActionMenu, so the positioning now comes from one shared `useDropUp` hook and the two cannot drift apart again. | At 1366×620: first row opens down, bottom at 519 of 620, on screen. Last row flips up, 403–520 instead of 564–681, on screen. Both verified by measurement. |
| **P2-11** | **Done** | The five summary boxes sat between the tab strip and the tab content, on every tab — a band of summary between a heading and the thing it heads. Moved into the record header as compact facts (your option 1). | Tab strip to content is now a uniform 16px on Products, Details, Activity and Notes, all at the same y. `.metrics` block gone, `.record-facts` in the header. |

### Found while working, not on the list

**Fifty-two icons were rendering as their own names in words.** The icon font is
served with `immutable, max-age=31536000` from a fixed filename under
`public/`, which Vite copies verbatim. When the subset was regenerated on
30 August the filename did not change, so no browser that had already loaded the
app would ever fetch it — for a year. The file on disk was correct the whole
time; `candlestick_chart`, `shield_person` and `settings_account_box` are the
role icons on the login page.

Fixed by moving the `@font-face` into `styles.css` so the build fingerprints the
file: `material-symbols-rounded-<hash>.woff2`. New font, new URL.

This is the same failure that once pinned every returning browser to its first
build of `index.html`. `icons.test.mjs` now fails if the font is referenced on a
fixed path, and a lock file records the hash of the font each list produced.

---

## Part 0 — What I verified before answering

Four items I could check against the code straight away. These are facts, not
estimates.

| ID | Finding |
|---|---|
| **P2-07** | Confirmed. `client/src/crm/Leads.jsx:179` still renders `<th>Cards</th>`. Round 1's ENH-10 renamed the label elsewhere and missed the list header. One-line fix. |
| **P2-05** | **Done, 31 Aug.** The write API already existed and already implemented the Q-06 rules; what was missing was a screen that called it. `RolesSetup.jsx` now edits name, description, scope and permissions, creates and clones roles, and deletes non-system ones. Four e2e checks added, including that an edit — grant *and* revoke — takes effect on an already-issued token. |
| **P2-08 + P2-09** | **One root cause, not two.** `EmailComposer.jsx` already does attachments, templates and collateral. But `leadActions.jsx:46` sends the product-card action to a plain message modal instead. Every entry point pointing at the composer fixes both. |
| **P2-10** | **A regression from Round 1's ENH-19.** The base input rule chains eight `:not()` selectors, which gives it specificity (0,8,1). `.globalsearch input` is (0,1,1) and loses on specificity regardless of source order, so its `border: 0; background: transparent; padding: 0` resets never apply and the input draws its own box inside the pill. Blast radius is this element alone. The right fix wraps the exclusions in `:where()` so the base rule drops to (0,0,1) and any container override wins naturally — which also prevents the next nested input hitting the same wall. |

---

## Part 1 — Section C answered

### Q-01 · P2-01 Geolocation

| Question | Recommendation |
|---|---|
| All activity types, or meetings only? | **Meetings marked in-person, only.** The stated need is proof of physical presence. Capturing location on a phone call is surveillance with no purpose attached, and the first time it is questioned the whole feature becomes contentious. |
| Mandatory? | **No — record the refusal as a value.** Blocking the save means the meeting goes unlogged, and an unlogged meeting is worse for the business than an unlocated one. Store `location: declined`. A pattern of refusals by one person is itself the management signal, and it arrives without anyone being locked out of their own CRM. |
| Captured when? | **At save**, from the position read at that moment. "On create" is ambiguous on a form that may sit open on a desk for an hour. |
| What is stored and shown? | Latitude, longitude, **accuracy radius**, and a resolved address. Non-editable. The accuracy radius matters: a 2 km GPS fix presented as a precise address is evidence that will not survive being challenged. |
| Visible to the RM? | **Yes.** Somebody should be able to see what has been recorded about their own movements. That is both fair and the defensible position under DPDP. |
| Virtual / phone meetings? | No capture. Add a `mode` on the meeting — in person / video / phone — and capture only for the first. |
| Native app or responsive web? | **See my question A-1 below.** There is no native app today and building one is a separate product, not a feature. |

**One thing you did not ask that matters more than any of the above:** an
employee's location is personal data about a member of staff. Under DPDP that
needs a stated purpose, a retention period and the employee being told. I would
put a visible notice on the capture, retain for **12 months**, and write the
purpose into the field definition. Worth a Compliance view before build, not
after.

---

### Q-02 · P2-02 and P2-15 overlap

**One screen, two tabs.** "API access" (URL, key, secret, regenerate) and "Logs"
(webhook, telephony, API, payment, portal).

Two screens covering the same credentials is exactly the duplication the
LeadSquared audit spent ten findings on. If a vendor's key can be seen in two
places, one of them will drift.

---

### Q-03 · P2-03 UAT and Production

This is the largest item in the document and the one I have most concern about.
My recommendations, then a question I cannot answer myself.

| Question | Recommendation |
|---|---|
| Own database for UAT? | **Yes, mandatory, non-negotiable.** |
| Production data copied in? | **No. Masked subset, or synthetic.** We are currently holding an open incident report precisely because real client records were put in UAT. Copying them in by design would institutionalise that. |
| Approval on promotion? | **Yes — maker-checker.** One admin clicking one button to change a SEBI-regulated production system, with no second pair of eyes, is among the first things an auditor tests. The approvals engine already does maker-checker; this becomes a new scope rather than new machinery. |
| Rollback scope? | **Configuration only.** Code rollback is CI/CD and we already have it. Data and schema rollback is not something a button can honestly offer — a migration that dropped a column cannot be undone by clicking, and pretending otherwise is worse than not offering it. |
| Versions retained? | Last **10** promotions, or 90 days, whichever is longer. |

---

### Q-04 · P2-04 User management and ghost login

| Question | Recommendation |
|---|---|
| Audit-logged? | **Yes, and it now costs nothing** — the access log built this week records every request with the user on it. A ghost session should tag every row with *both* identities, so "Kavita, acting as Sneha" is what the log says. A ghost session that logs only the impersonated user destroys the audit trail rather than extending it. |
| Who may ghost into whom? | **Nobody ghosts into a Super Admin.** Admin may ghost into any non-admin role. Super Admin may ghost into anyone below Super Admin. Nobody ghosts into themselves-plus-one-level-up, which is how impersonation becomes privilege escalation. |
| Read-only fields? | **email/username** (that is the identity), **role** (a permissions change belongs on the roles screen where it is audited as one), and **sales_org** (that moves somebody between Bonanza and Bigul — the boundary this system has just spent a week hardening). Mobile, name, extension, manager: editable. |

I would also add a **persistent banner** during a ghost session and a hard
session cap (say 60 minutes), because the failure mode is an admin forgetting
they are impersonating and acting as somebody else by accident.

---

### Q-05 · P2-04a CUBE dialer fields

**I cannot answer this one.** See question A-2.

---

### Q-06 · P2-05 Roles and permissions

| Question | Recommendation |
|---|---|
| Granularity? | **Object and field level through the UI; record level is already built** and needs surfacing rather than building. `leadScope` / `clientScope` decide record visibility from the role's declared `data_scope`; `field_def` plus the masking engine already do field level. The gap is that none of it is editable from a screen. |
| System roles editable? | **Clone, never delete; label editable, code frozen.** The code defaults reference these role codes, so deleting `sales_rm` breaks seeded configuration in ways that surface weeks later. Renaming the label is safe and is usually what people actually want. |

---

### Q-07 · P2-06 Save / Discard

| Question | Recommendation |
|---|---|
| Scope? | **Admin and Super Admin configuration screens only.** Putting an explicit save on a Sales RM editing a lead slows the single busiest workflow in the product to protect against a mistake that is one undo away. Configuration is different: a wrong SLA or masking rule affects everybody at once and nobody notices for a week. |
| Navigating away? | Both guards: an in-app prompt on route change, and `beforeunload` for a closed tab. |

---

### Q-08 · P2-09 Email composer

| Question | Recommendation |
|---|---|
| What actually sends? | **See question A-3** — this depends on Q-16 and I do not want to guess. |
| Templates shared or private? | **Both, and the distinction matters.** Org templates are admin-approved and are the compliance-safe ones; personal templates are an RM's own drafts. Only approved templates may be used for bulk or campaign sends. |
| Merge fields? | **Yes, and validated against the field registry.** LeadSquared's tenant is full of copy keyed to fields that do not exist. A merge field that resolves to nothing sends a client an email addressed to a blank space. The registry already exists (`field_def`), so validation is cheap. |

---

### Q-09 · P2-11 and P2-12 Lead layout

You asked whether I should propose options first. **Yes — I would rather show
you two or three than guess, since this is the screen your RMs live in.** For
now, my starting position:

- **Lead Score, AUM, Owner** move into the record header strip, beside the name
  — they are identity, not content, and they currently interrupt the flow
  between a summary and the thing it summarises.
- **Replacing "2 Warm / 1 Active":** the two facts that change what an RM does
  next are **the next action** and **how long since anyone last spoke to this
  person**. "2 Warm, 1 Active" describes state; neither of those two describes
  state, they prompt a decision. That is the difference between a summary that
  takes up space and one that earns it.

---

### Q-10 · P2-13 and P2-17c Drill-through

**Same tab; filter shown as a removable chip; editable; offered as a saved view.**

That is not a new decision — it is exactly what was agreed as Q-05 in Round 1
and built for ENH-05. So **P2-13 is a defect against agreed behaviour**, not a
change of direction. I will treat it as a bug and find why the tiles are not
landing on the exact record set.

---

### Q-11 · P2-14 Connectors

**I cannot answer this.** See question A-4 — nothing here can be built or tested
without vendor accounts.

---

### Q-12 · P2-15a Log retention

| Log | Recommendation | Why |
|---|---|---|
| API / webhook | 90 days | Long enough to debug an integration, short enough not to hoard |
| Telephony | 12 months | Call records attract regulatory interest |
| Payment | **7 years** | Financial records under Indian law |
| Portal / access | 90 days | Matches the access log already built |

Viewable by Admin and above. Searchable and exportable: yes.

**Flag:** seven years of payment logs is a storage commitment and a DPDP
question in its own right. Worth confirming with Compliance that seven is the
number they want, rather than my assuming it from general practice.

---

### Q-13 · P2-17b Custom dashboards

| Question | Recommendation |
|---|---|
| Who creates? | **Personal dashboards for everyone; shared dashboards for Admin, Super Admin and supervisors.** A rep arranging their own view harms nobody; a rep publishing a dashboard to the desk is a different act. |
| Shareable? | Yes, to named roles. **Scoping still applies** — a shared dashboard shows each viewer their own data, never the author's. |
| Default homepage per role? | Yes, set in Setup, with a per-user override. |

---

### Q-14 · P2-19 Database size

**I can answer this one from the code: no, the platform is not multi-tenant in
the isolation sense.** There is one database, one schema, and a `sales_org`
column separating Bonanza from Bigul. "Tenant-wise" therefore means per
`sales_org`.

That said, the answer you probably want is still available: size per
`sales_org`, per object, plus row counts and growth rate. Admin sees their own
book; Super Admin sees both.

**Worth being explicit about, because it affects P2-03:** if Bigul ever needs
genuine data isolation rather than query-level separation, that is a much larger
change and is far cheaper before 495,118 leads land than after.

---

### Q-15 · P2-20 Content library

| Question | Recommendation |
|---|---|
| What does it hold? | Marketing collateral, product brochures, and approved client-facing documents. **Not email templates** — those now live in Templates with real versioning, and splitting them across two homes recreates finding 10. |
| Who may create and access? | Libraries owned by a role, shared to named roles, with an expiry date per item. The expiry matters: a brochure quoting last year's brokerage rates is a compliance problem, not just stale content. |

---

### Q-16 · P2-25 Outlook

| Question | Recommendation |
|---|---|
| Microsoft 365 OAuth? | Yes. |
| Org-level or per user? | **App registration once at org level; mailbox connected per user.** Sending every RM's email through one shared identity destroys attribution — which is LeadSquared finding 7, the shared-login problem, arriving through a different door. |
| Scope? | Calendar and email send. The calendar adapter is already built and simulating. |

**Still blocked on the same thing:** Microsoft Graph moves data outside India.
That decision has been with Compliance since the leadership deck and is
unchanged.

---

## Part 2 — My own questions

These are not in Section C and I cannot proceed on the related items without
them.

### A-1 · P2-01 — is "mobile application" a native app?

There is no native app. The portal is responsive web, and geolocation works in a
mobile browser over HTTPS with the user's permission.

A native iOS/Android app is a separate product with its own build, release
cycle, app-store review and maintenance. If that is genuinely what the business
expects, it needs to be scoped as such rather than absorbed into this item.

### A-2 · P2-04a — CUBE fields — **answered 31 Aug 2026**

Ritesh authenticated to the vendor's Swagger portal and the full specification
was read. Written up as `docs/integrations/CUBE-QUICKCALL-API.md` — 18
endpoints, every request and response field.

**The headline: there is no DID field in the CUBE API.** Nothing in any request
or response is named DID or equivalent. The nearest concept is `Extension`,
supplied per agent at login. So the P2-04a field is `Extension` and it belongs
on the **user** record, not the campaign.

Three things the documentation settled:

- **`CampaignId` is fixed at agent login**, so an agent is in exactly one
  campaign at a time and changing campaign means logging off and on. There is
  also no endpoint that lists campaigns, so the values must be configured by
  hand on our side.
- **The integration is stateful.** `AuthLogin` returns an `AuthId` that every
  later action carries until logout, so the CRM has to hold a live session per
  signed-in agent — server-side, or a restart orphans every agent's dialer.
- **A UAT server exists** (`uat-raphsody.in`), so this can be built and
  exercised without touching production dialer traffic.

Two things it did *not* settle, both raised in §5 of the reference doc. The
first is a security decision rather than a technical one:

- **`AuthLogin` requires each agent's own CUBE password.** Storing every
  agent's dialer password is a credential store we do not have and should not
  build lightly. Preferred option: the agent types it once at start of shift
  and we retain only the `AuthId`, never the password.
- **`AuthCallLog` does not return `ClientId`**, though both dialling endpoints
  accept it. The only join key back to a lead is phone number plus a time
  window, which is ambiguous for family accounts sharing a mobile — common in
  Indian broking. Worth asking CUBE to return it, since the field plainly
  exists in their model.

### A-3 · P2-09 / P2-25 — which system sends email?

These two items describe one thing from two directions. Options:

1. **SMTP** — simplest, works today, sends from a Bonanza address.
2. **Outlook per user** — each RM sends as themselves, replies land in their
   own mailbox, attribution is exact. Blocked on the residency decision.
3. **Both** — SMTP for system and campaign mail, Outlook for personal.

I would build (3), with (1) working first so the composer is usable before the
Compliance decision lands. But this is your call, and P2-09 cannot be finished
without it.

### A-4 · P2-14 / P2-23 — vendor accounts

Facebook and Google connectors cannot be built or tested without accounts and
credentials. Which specific products — Facebook Lead Ads? Google Ads? Gmail?
Calendar? Each is a different API with a different consent model.

### A-5 · P2-03 — does Production exist, and what is being promoted?

Today there is one environment. Two questions inside this item:

- **Is there Production infrastructure yet**, or does that need standing up
  first? Everything else in P2-03 depends on the answer.
- **Is "promote" about configuration or about code?** They are entirely
  different builds. Code promotion is CI/CD and largely exists. Configuration
  promotion — moving a rule, template or role definition from UAT to Production
  — is a product feature and a substantial one.

My reading is that you mean configuration, since you describe Admins doing it
from a UI. Please confirm.

### A-6 · P2-21 — "all objects" is unbounded as written

"Edit and configuration options for all objects, with relevant detailed settings
for each" could mean a week or a quarter depending on what "detailed" covers.
Could we pick **three objects** to do properly first — I would suggest Lead,
Client and Ticket — and use those to establish the pattern before spreading it?

---

## Part 3 — Grouping

The 25 items contain a lot of overlap. Building them as 25 separate pieces would
duplicate work and produce inconsistent screens. I would group them into eight
workstreams:

| # | Workstream | Items | Size |
|---|---|---|---|
| 1 | **Quick defects** | P2-07, P2-10, P2-18, P2-24, P2-11 | Small — all diagnosed or diagnosable in hours |
| 2 | **Email, one composer everywhere** | P2-08, P2-09 | Medium; blocked on A-3 |
| 3 | **Drill-through correctness** | P2-13, P2-16, P2-17c | Medium — a defect against agreed behaviour |
| 4 | **Configuration surfaces** | P2-05, P2-06, P2-21, P2-22, P2-20 | Large; A-6 open |
| 5 | **Integrations** | P2-14, P2-23, P2-25, P2-02, P2-15 | Large; blocked on A-3, A-4 |
| 6 | **Dashboards** | P2-17, P2-17a/b/d, P2-12 | Large |
| 7 | **User management** | P2-04, P2-04a | Medium; A-2 open |
| 8 | **Platform** | P2-03, P2-19, P2-01 | Largest; A-1, A-5 open |

**Workstream 1 is unblocked and I can start on it the moment you say so.**
Workstreams 2, 5, 7 and 8 have open questions in front of them.

Being straight with you about scale: this is not a one-week list. Workstreams 5,
6 and 8 are each larger than everything delivered in Round 1. If there is a date
attached to the pilot, tell me and I will sequence against it rather than
against the numbering.

---

## P2-05 — delivered 31 August

**What changed**

| File | Change |
|---|---|
| `client/src/crm/RolesSetup.jsx` | New. The editable roles screen: role list with holder counts, an editor modal, a create/clone dialog, and a capability picker grouped by category. |
| `client/src/crm/Admin.jsx` | The Roles tab renders `RolesSetup`. The old read-only matrix is exported and kept, rendered beneath the list. |
| `server/src/routes/setup.js` | One fix: `PATCH /roles/:code` accepted a blank name. `COALESCE` keeps an omitted name, but `''` is not null, so the role would have been stored nameless. |
| `client/src/styles.css` | Styling for the scope picker and capability groups. |
| `server/test/e2e.mjs` | Four checks (below). |

**Decisions carried out of Q-06, and where they show up**

- *Object and field level editable; record level stays with `data_scope`.* The
  editor says so on screen: "Record visibility is decided here and nowhere else."
  A second mechanism for the same question is the LeadSquared mistake.
- *Code frozen, label editable.* The code field is disabled, on custom roles as
  well as system ones — seeded configuration and the access-model defaults
  reference those strings, so renaming one is a migration, not an edit.
- *Clone, never delete.* System roles have no delete control; the server refuses
  it independently. "Copy permissions from" is offered on every new role.

**Two things the screen now shows that nothing showed before**

- The `sensitive` flag on a capability. It has been in the table since the
  access model was built and no screen ever rendered it. Granting "Unmask client
  identifiers" should not look identical to granting "View own leads" to the
  person doing the granting.
- Both the label and the code for every permission. The code is what appears in
  a refusal message and in the audit log, and whoever is reading either needs to
  find it here.

**How it was tested**

Four e2e checks in section 27, on top of the nine that already covered the API:

| Check | Why |
|---|---|
| An edit replaces the permission set, adding *and* removing | The editor PATCHes a whole set; a bug that only appended would be invisible in the UI. |
| A role cannot be saved without a name | The `COALESCE` gap above. Fails against the old code. |
| **An edit takes effect without the holder signing in again** | The one that decides whether the screen is worth anything. Grant, then revoke, both checked on a token issued *before* either change — revocation is the urgent direction, and if capabilities were resolved at sign-in an administrator would take access away and the person would keep it until expiry. |
| Every capability the picker offers is one the server recognises | The picker renders the catalogue and PATCHes back ticked codes; the server silently drops unknown ones. Drift between catalogue and table would look like a successful save that did nothing. |

Suite: **509 e2e + 285 unit, all green.**

**Two defects found in my own work while verifying, both fixed**

- The suggested role code froze after one keystroke — `f.code || slug(name)` is
  truthy from the first character, so "Regional Supervisor" suggested `r`.
- The Sensitive badge rendered as a full-width bar. `.cap-row span` was a
  descendant selector and the badge is a span; at (0,1,1) it also outranked
  `.badge` at (0,1,0). Scoped to `.cap-row > span`.

**One finding raised, not fixed — needs your decision**

`/api/tickets` and `/api/tickets/:id` carry no capability gate at all. Both are
book-scoped, so this is not a cross-book leak, but any signed-in user can read
every case in their own book including the client's own description and the
replies. There is no `ticket.view` capability to gate them with — all five
existing ticket capabilities govern writes. Written up as §6a of the security
record with three options; I did not pick one, because adding a read capability
means re-granting across twelve roles and doing that without knowing who
genuinely needs case access would cut people off mid-work.
