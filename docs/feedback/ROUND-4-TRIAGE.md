# Round 4 — per-ID status

**Source:** [ROUND-4-source.md](ROUND-4-source.md) — an independent QA audit, 43
findings, received 13 October 2026.

**What the auditor asked for:** "Claude Code should return per-ID status
(`fixed`, `partly fixed`, `not started`, or `needs decision`) with evidence
against this document and earlier feedback IDs." This is that document.

## Read this first: the build they tested is the build we have

labs.tinyepic.in was running `1cff7c3` (18 September). **No commit landed between
27 September and 3 October**, so nothing was in flight during the audit. The
seventeen commits since are N-6 (CUBE), N-10 (picklist books, KYC verification and
objection), OPS-14 (picklist enforcement) and documentation. None of them was
aimed at anything in this report.

So the honest headline is that **nothing in Round 4 has been fixed**, and the
report should not be read as partly stale. One finding, QA-01, needs its claim
narrowed rather than its status changed — see below.

## What I verified in code, and what I did not

Eleven findings — the ten the auditor asked to be prioritised, plus QA-08 — were
traced to a line. Those say **verified** and name the cause. The remaining
thirty-two say **unverified**: the report's own evidence stands, I simply have not
re-derived it, and I am not going to record a status I did not establish. Several
of those are decisions rather than defects, and those are marked as such whatever
their code state.

## The priority set, with causes

| ID | Pri | Status | Cause, in code |
|---|---|---|---|
| QA-01 | P0 | **not started** · verified | The server already gets precedence right, and did in the tested build: `crm.js` line 978, `const routable = req.body.route ?? (!owner_id && INBOUND_SOURCES.has(...))`. The bug is in the client. `Leads.jsx` line 594 renders *Assign to me* as `<option value="">`, so the form posts an empty owner, `!owner_id` is true, and a Website lead routes away from the person who just claimed it. **Narrow the finding: not "routing overrides the selection" but "the selection is never sent."** Fix at both ends — carry the creator's id in the option, and have the server distinguish an absent owner from one explicitly set. The report's second observation, that the form offers owners a Sales RM should not see, is separate and also open. |
| QA-02 | P0 | **not started** · verified | `engine/rules.js` has no idempotency of any kind: no key, no already-fired check, no bounded retry. It writes `rule_runs` (line 539) but never reads it to decide whether to act. Nothing stops a sweep re-firing against a record it has already acted on, which is what 48,243 firings against 41 leads describes. |
| QA-03 | P0 | **not started** · verified | `portal.js` line 161: `SELECT id FROM users WHERE role = 'customer_care' AND active = 1 ORDER BY (...) LIMIT 1` — **no `sales_org` filter**, so a Bonanza partner's ticket goes to whichever Customer Care user is least loaded in either book. The INSERT on line 164 carries no `sales_org` and no `category_id`, which is why the case reads *Uncategorised*. And hard-coding `role = 'customer_care'` bypasses the SLA category table that says `Partner Support → Partner RM`. Three defects in one query. **This is the fifth instance of the book-boundary class behind OPS-05, OPS-06, OPS-07 and OPS-08** — all fixed 17–18 September, all in other routes. The portal was missed. |
| QA-33 | P0 | **not started** · verified | `partners.js` line 447, `POST /:id/request-elevation`, refuses with "N onboarding step(s) still incomplete". Line 462, `POST /:id/elevate`, checks `partner.elevate` and nothing else. The auditor's narrowing is exactly right: the guard exists on the normal path and is absent on the privileged one. |
| QA-28 | P1 | **not started** · verified | Three case-creation paths, three different levels of completeness. `tickets.js` line 299 inserts `category_id` and `sales_org` and calls `applySla` (line 309). `portal.js` line 164 calls `applySla` but inserts neither. `ai.js` line 235 inserts neither **and never calls `applySla` at all** — hence a High compliance case with no category and no due timestamps. |
| QA-30 | P1 | **not started** · verified | `admin.js`, the send handler from line 1340: `const template = campaign.template_id ? one(...) : null`. The template is optional and a null one falls through to a default body, which is the "Bonanza update" the auditor saw. There is no approved-content guard at the API. |
| QA-32 | P1 | **not started** · verified | `admin.js` line 152 refuses unless `code` is present. The screen promises a generated permanent code and offers no Code input, so the form cannot satisfy it. Either generate server-side or expose the field; the screen's promise says generate. |
| QA-34 | P1 | **not started** · verified | `kyc.js` contains no field validation whatsoever — no `validate()` call, no format check on PAN, mobile, IFSC or PIN, and no nominee total. `ifsc` is passed straight through (line 316). Every value the auditor pushed through is accepted because nothing looks at any of them. |
| QA-26 | P1 | **not started** · verified | A one-word asymmetry. `POST /leads` validates `name: ['required', 'max:120']` (line 885). `PATCH /leads/:id` validates `name: ['max:120']` (line 1085) — **no `required`** — so an empty name passes the API and the database raises `NOT NULL constraint failed: leads.name`. |
| QA-08 | P1 | **not started** · verified | `POST /tasks` (line 1869) requires a title and a due date, and checks the book of `lead_id` when one is given, but nothing requires *any* of `lead_id`, `card_id`, `ticket_id` or `partner_id`. All four default to null. The page's mandatory-link promise is unenforced and has no selector. |
| QA-36 | P1 | **needs one check** | The client deliberately re-fetches `/leads/:id?unmask=true` for the edit form (`LeadDetail.jsx` line 1014), with a comment that the parameter is refused without `pii.unmask`. If that refusal holds, a Sales RM's form should not have been populated — so either the server gate does not cover this role or it does not cover this route. That is one read of `unmaskRequested`/`maskFor` and I have not done it. |

## Decisions only Ritesh can make

These are not defects to fix. They block the fix.

| ID | The decision |
|---|---|
| QA-13 | May a Bonanza partner refer Bigul products, and may Bonanza-branded DKYC open Bigul accounts? The auditor explicitly says not to infer the answer from the present UI. Everything about catalogue filtering and brand copy waits on this. |
| QA-09, QA-24, QA-35 | What do `Won`, partner-client `Trading`, product-card `Active`, an issued UCC, accrued commission and paid commission each mean, and which is authoritative for which screen? Three findings are the same conflation. |
| QA-06 | Marketing may now view unmasked PII — already decided. **Export is a separate decision and is still open.** The screen currently offers Export and then refuses it, which is wrong either way. |
| QA-37 | Which configurable entities get rename/retire/archive, and which keep immutable history? Ten entities, one policy call. Includes the revoke path QA-33's cleanup needs. |

## Already-known work this report re-evidences

The auditor cross-references these themselves; I have not re-verified them.

| QA | Existing ID | Note |
|---|---|---|
| QA-04, QA-05 | Round 1 `ENH-05`/`05a`, Round 2 `P2-13`/`P2-17c` | Metric drill-through. The date predicate is dropped while the stage one applies. |
| QA-14 | Round 4 of Ritesh's own feedback | Pipeline multi-select products and per-stage filters. |
| QA-15 | `P3-36`/`37`/`38`/`39` | Pagination absent, most column sorting absent; the bulk-update "across all pages" wording is premature until pagination exists. |
| QA-16 | `P3-06`, `P2-17` | Custom report builder and dashboard creation — both already open and both gated on `N-4a`. |
| QA-17 | Ritesh's date-format request | One display formatter, `DD-MM-YYYY`, ISO preserved in storage and API. |
| QA-18 | `P3-31` | App Launcher stays open on outside click. |
| QA-22 | `ENH-09` | Market headlines are static text, not links. |
| QA-02 | older handoff `B-01` | Same scheduler defect, now with counters. |
| QA-03 | older handoff `B-02` | Same cross-business assignment, now with a reproduction. |

## Unverified, and needing a pass of their own

QA-07, QA-10, QA-11, QA-12, QA-19, QA-20, QA-21, QA-23, QA-25, QA-27, QA-29,
QA-31, QA-38, QA-39, QA-40, QA-41, QA-42, QA-43.

Two worth flagging inside that list:

- **QA-43** is the same shape as `N-12`, which is already open: a record-id route
  whose list and detail disagree about scope. The Product Supervisor's KYC list
  includes a journey whose detail API returns 403. When N-12 is worked, this is
  one of its cases.
- **QA-12** I looked for and could not find. `ApiAccess.jsx` renders
  `{data.base_url}` from the server rather than a hard-coded `http://`, so either
  the server composes it wrongly or this is already correct. It needs the one
  check, not a rewrite.

## Suggested order

The auditor's order is sound and I would not change it. QA-01, QA-02, QA-03 and
QA-33 first. Of those, three are small and one is not:

- **QA-01, QA-03, QA-33 are each a few lines**, and QA-26, QA-08, QA-28, QA-32 and
  QA-30 are the same size. Eight surgical fixes, each with a test, is one focused
  pass.
- **QA-02 is a design change, not a patch.** Idempotency keys, bounded retries and
  a retention policy for `rule_runs`, plus reconciling 48,000 existing activities
  and 10,000 duplicate tasks without destroying audit evidence. It wants its own
  scoping and its own sign-off.
- **QA-34 is medium.** The validation rules themselves are easy; the open question
  is where they live, because the same values arrive from DKYC, from import and
  from automation writes, and the report rightly asks for all three.

What I propose: the eight surgical fixes first, in one pass with tests, then
QA-02 scoped separately, then QA-34. The four decisions above can be answered in
parallel and do not block that work.
