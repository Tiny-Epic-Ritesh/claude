# Round 4 — per-ID status

**Source:** [ROUND-4-source.md](ROUND-4-source.md) — an independent QA audit, 43
findings, received 13 October 2026.

**What the auditor asked for:** "Claude Code should return per-ID status
(`fixed`, `partly fixed`, `not started`, or `needs decision`) with evidence
against this document and earlier feedback IDs." This is that document.

## The ledger — every point in the report, and where it stands

Kept current: a commit that closes a point changes its row here and says so.
Last updated **16 October 2026**: `84c2c2f`, `eaf4743`, `d34bb6b`, the rulings of 13 October, `72fa94d` (OPS-15, 16, 17, 25, 26), `e02fb6d` (OPS-18 to 24), `1c3b18c` (QA-02), `ca7d4ee` (QA-13), `9aa78bf` (QA-06), `a3be2c1` (QA-09, 24, 34, 35), `93607f5` (OPS-27 to 31), `b9b3807` (QA-29, QA-42), `b663fb4` (OPS-32 recorded open; a Dealer may mark Warm), the rulings of 14 October, `0efa39b` (the QA-02 cleanup workflow; help lines), `826ae09` (QA-33's emergency activation), `f54c4f6` (QA-28's categories and the Compliance role), `88c2c67` (multiple nominees, QA-34), `32278d2` (referral commission and retention policies; QA-37's lead purge), `8840d1c` (OPS-33 to 35 recorded open), `69f8d16` (QA-37 batch 1: lists and templates), `de28b1c` (QA-37 batch 2: tasks, cases and corrections), `9224a07` (QA-37 batch 3: library content, holidays and case categories), `2f628d6` (QA-37 batch 4: automation rules and flows), `82d7989` (OPS-36 to 40 recorded open), `b0c97b8` (nominees to SEBI's May 2026 circular), `6fc4f64` (QA-37 batch 5: partners, KYC journeys and retiring test records; QA-37 closed), `a21a6a7` (OPS-41 recorded open), `ce5b6d0` (the firm's nomination obligations under SEBI's May 2026 circular), `cd3ab93` (OPS-42 recorded open), `bd13b87` (OPS-42 fixed: capabilities, not roles, and the API integration role), `670fc3e` (the 15 Oct answers on the nomination pop-up), `3034d0f` (a switch per business for the nomination reminders, off), `bf9067f` (OPS-43 recorded open), `df97dbc` (OPS-32 to 41 and 43 fixed; QA-13 marked fixed, its leftovers having been built on 14 Oct), `de27e4a` (batch one: QA-05, 12, 17, 18, 22, 25, 43, with before/after screens in [ROUND-4-fix-evidence/](ROUND-4-fix-evidence/)), and the commit after it (the approved QA-16 design, Ritesh's Part 4, and Ritesh's rulings of 15 and 16 October).

**States.** *fixed* — in code, tested, pushed. *not started* — open, no
blocker. *needs decision* — waiting on Ritesh, and nothing is built until it is
answered. *unverified* — the auditor's evidence stands but I have not traced it
to a line yet. *environment* — a change to labs.tinyepic.in itself, not the code. *closed by
ruling* — Ritesh ruled that the behaviour reported is the behaviour wanted.

**Today, of the 43 IDs: 37 fixed · 1 closed by ruling · 0 partly fixed · 5
open · none waiting on a decision.** Every ruling a finding needed was given on
13 October, and the two narrower questions left inside fixed IDs on 14
October; both are built. Plus the points below the table, which are not IDs
but are as much part of the report.

### The 43 findings

| ID | Pri | State | Note |
|---|---|---|---|
| QA-01 | P0 | **fixed** `84c2c2f` | Form sends `route: false`. Its second half, adjacent (e), is `OPS-19`, fixed. |
| QA-02 | P0 | **fixed** · QA-02 commit | A rule fires once per change: `rule_firings` records what each rule has done to each lead, a delayed stage runs once if the lead still matches, a repeat happens only if the rule asks, and the stored schedule — office hours, weekends, a daily limit — is read at last. The waterfall is staged as answered and holds while a High or Critical case is open; an abandoned journey becomes one task. Leads already acted on are taken as fired at deploy. The duplicates on labs: `server/scripts/qa02-duplicate-tasks.mjs`, preview by default, for Ritesh to run. [QA-02-SCHEDULER-DESIGN.md](QA-02-SCHEDULER-DESIGN.md), "As built". |
| QA-03 | P0 | **fixed** `84c2c2f` | `engine/cases.js`. |
| QA-04 | P1 | **fixed** `eaf4743` | The Leads page reads the date window — and the source chart's `source` — a tile sends, and shows each as a removable chip. Tile and list compare the same dates. Both compared IST dates against UTC timestamps: adjacent (j), `OPS-24`, fixed — both read IST days now. |
| QA-05 | P1 | **fixed** `eaf4743` and batch one | Every Customer Care figure (Open assigned, Due today, SLA breached, Resolved today, Waiting on client, CSAT) says it is the person's own and opens the Cases page on exactly the cases it counts; the team summary on the Cases page does the same. The Cases page reads every filter a link brings -- assigned, breached, status, due today, rated, resolved and created windows -- and shows each as a chip that can be removed; Home's tiles name their view. "SLA breached" means one thing everywhere: open and flagged by the minute-by-minute sweep (`breachedSql`), where the tile also counted paused cases past due and the list counted resolved ones. "Resolved today" was the agent's own, and Home's month-to-date figure everyone's -- both now say so. Days are India days. `round4e.test.mjs` checks each figure's count against its list. |
| QA-06 | P1 | **fixed** · QA-06 commit | Ruled 13 Oct. The Marketing Manager holds `pii.unmask` and sees identifiers unmasked by default (Setup → Field masking can still mask any field for the role), and holds `export.lead`, so the list Export that opened and then refused now works. **Setup → Business policies → Marketing's exports carry personal data**: *Unmasked* (the default, as ruled) or *Masked*, which refuses a clear export from every export route. **One masking rule everywhere:** the masker learnt the names a join gives identifiers (`lead_mobile`, `applicant_mobile`, `applicant_email`), and list members (the auditor's list #3), the case queue and case, the KYC health board and journey — the applicant's form included — a lead's journeys and the email composer now mask as the lead list does. Found by `server/test/piimasking.test.mjs`, which plants a lead and calls every GET route as a masked role. |
| QA-07 | P1 | not started | A UI build: draft-until-Save on Manage, and a consequence summary with Confirm for Escalate and Resolve -- Part 4 items 1 to 4 (see [below](#riteshs-part-4)). Ruled: a change of priority, an escalation's included, recalculates the case's deadlines from when it was opened (16 Oct); resolved cases close after 72 hours by themselves, per business, and the button checks SLAs now (16 Oct, with `OPS-45`); an escalation with no manager goes to a Sales Supervisor in the case's own business or is refused (15 Oct, `OPS-44`). |
| QA-08 | P1 | **fixed** `84c2c2f` | Every link book-checked too. |
| QA-09 | P1 | **fixed** · definitions commit | Set from standard broking practice and written down: [QA-09-DEFINITIONS.md](QA-09-DEFINITIONS.md). *Won* is an opened account (a UCC); *Trading* is an account that traded in the last 90 days and *Dormant* one that has not; the exchanges' *Inactive* is 24 months (NSE/INSP/64718, Oct 2024); an Active product card is not an account; commission *accrued* is earned and unpaid, *paid* is paid. The Partner Portal now reads Trading and Dormant from the account, ends its funnel at *Account opened*, counts conversions as accounts, and shows paid and accrued commission apart; the CRM's partner conversions are accounts too. |
| QA-10 | P1 | not started | A UI build: an opaque, scrollable call panel with a visible End call and state-aware actions -- Part 4 item 9. Ruled 15 Oct: keep the panel and redesign it. Needs a design pass in both themes. |
| QA-11 | P1 | **fixed** `eaf4743` | One resolver, `fill()` in the merge engine, for the composer, test-send and campaign send. A field masked for the sender is refused by name. **`{{name}}` in campaigns is now the first name**, as the picker always said. The picker's static examples are untouched. |
| QA-12 | P1 | **fixed** `eaf4743` and batch one | The screen shows `CRM_PUBLIC_URL` or the origin it is itself using -- https. Ruled 15 Oct: an API key is refused (403, `insecure_transport`, "rotate it") when the proxy's `X-Forwarded-Proto` says http; without the header nothing changes, so nothing breaks. nginx untouched. |
| QA-13 | P1 | **fixed** · QA-13 commit, `0efa39b`, `32278d2` | Ruled 13 Oct and built. **Setup → Business policies** (new, `admin.policies`, Admins and Superadmins, draft until Save, every change in the configuration audit) holds one switch per business — *Bonanza partners may refer Bigul products* and the reverse — both **off**. Off, the portal offers the partner's own business's products only and refuses a referral for the other's; on, the other's are offered labelled with their business, a referral for one becomes a lead in that business attributed to the partner, and the partner can follow it in the portal. The public account-opening page is **a page per business**, as ruled: `/dkyc` is Bonanza's, `/dkyc?business=bigul` Bigul's, each with its own products, name, logo and regulatory line, and a resumed application wears its own business's name. Bonanza Equity no longer pitches "the Bigul flat plan". **Plans, ruled 13 Oct and built:** Bigul's flat plan is offered on Bigul applications only. **Both leftovers built 14 Oct:** each business's page shows its own help line (`0efa39b`), and how a cross-business referral is paid is a Business policy (`32278d2`). |
| QA-14 | P2 | not started | Pipeline multi-select products and per-stage filters -- Part 4 items 10 and 11. Ruled 15 Oct: each stage filters by name or mobile, owner, days in the stage and last contacted. |
| QA-15 | P2 | not started | Pagination and column sorting, `P3-36`/`37`/`39`. |
| QA-16 | P2 | not started | Report builder and dashboard creation, `P3-06`/`P2-17`. `N-4a` answered on 15 Oct by reading both LeadSquared accounts, read-only ([QA-16-LEADSQUARED-REPORTS.md](QA-16-LEADSQUARED-REPORTS.md)); the design drawn from it was approved the same day ([QA-16-REPORTS-DESIGN.md](QA-16-REPORTS-DESIGN.md)) and is built in the order of its section 6. |
| QA-17 | P2 | **fixed** batch one | Ruled 15 Oct: 15-10-2026, and 15-10-2026 14:30 IST with a time. One formatter (`dmy`/`dmyTime` in client api.js; the same in server engine/daterange.js for messages), in India whatever the browser's zone; the two shared helpers every screen used now say it. A bare day (a holiday, an IPO close) printed raw because the parser could not read it -- fixed. The hand-made formats (calendar, reports, integrations, imports, API keys, KYC, telephony, commission months) and the server's follow-up confirmation, reminders, nomination acknowledgement and holiday errors use it. Storage and the API stay ISO. |
| QA-18 | P2 | **fixed** batch one | Ruled 15 Oct: Marketing is not offered the Service Console (`hiddenFor`). The outside click: **not reproduced** -- the audited launcher already closed on an outside press, and does in a headless run; hardened anyway, catching the press before anything on the page can swallow it (pointerdown, capture phase), touch included, and closing on navigation and on leaving the window. |
| QA-19 | P2 | **fixed** `eaf4743` | "Create list" goes to Lead Lists for whoever holds `list.create`. |
| QA-20 | P2 | **fixed** `eaf4743` | Tasks and Tickets count what they list, like every other tab. |
| QA-21 | P2 | **fixed** `eaf4743` | The handoff names the Product RM(s) asked and the High-priority task it gave them. 60-second timing still unmeasured. |
| QA-22 | P2 | **fixed as ruled** batch one | Ruled 15 Oct: prepare it, name the provider later. Every headline carries its source and date; while the feed is simulated the section says these are sample headlines; a headline becomes a link as soon as a feed supplies its URL. Live links wait on the news provider being named. |
| QA-23 | P2 | **fixed** `eaf4743` | An egress row records what actually answered; the table says Sent abroad, Served locally, or — for rows before 13 Oct — Not recorded. |
| QA-24 | P2 | **fixed** · definitions commit | *Won* means the account was opened: an account opening now sets its lead Won, in the field history. A Business policy, *A lead is marked Won only once its account is opened*, makes it a hard rule for every stage writer; it is **off** until the account-opening feed reaches the CRM, because until then an RM's Won is the only signal there is. The seed no longer hands out Won at random. |
| QA-25 | P2 | **fixed** `eaf4743` and batch one | The breach answer says whose tickets it counted. The page makes room for the Copilot where there is room -- the content narrows by the drawer's width and the figures reflow -- and below that width the drawer overlays and closes. |
| QA-26 | P1 | **fixed** `84c2c2f` | |
| QA-27 | P2 | **fixed** `eaf4743` | A delete returns to the list with a confirmation and a link straight to the recycle bin. |
| QA-28 | P1 | **fixed** `84c2c2f` | Every flag now opens a category, as ruled 14 Oct: Mis-selling / misrepresentation (High), Assured-return claim (High) and Regulatory escalation (Critical) with a new Compliance role; urgency on funds to Payout / Withdrawal (High) with Customer Care. Changeable per flag in Setup → SLA & categories, audited. An Admin of the business receives Compliance cases while nobody holds the role. `compliancedesk.test.mjs`. |
| QA-29 | P2 | **fixed** 13 Oct | Reproduced in a browser: Done reloaded the list, but the dialog's Close, Escape and a click outside did not, so the list kept its empty state until a reload. The server had counted the lead at once. Every way out after an import now goes the way Done goes, and the values that did not match stay on the list page, folded, after the dialog shuts. `round4d.test.mjs`. |
| QA-30 | P1 | **fixed** `84c2c2f` | Including duplication. |
| QA-31 | P2 | **fixed** `eaf4743` | Any whole-rupee minimum; zero is zero, not "not set"; a negative is refused on create and edit. |
| QA-32 | P1 | **fixed** `84c2c2f` | And the cross-book backfill it would have switched on. |
| QA-33 | P0 | **fixed** `84c2c2f` | Every activation path asks whether onboarding is done. The override was ruled 14 Oct (yes) and built: a Superadmin's emergency activation, asked for by name, with a reason, in the audit trail and on the partner for good, told to the business's Admins, and the open steps left open with a task for the partner's owner. `emergencyelevation.test.mjs`. Partner #9 cleanup is *environment*, below. |
| QA-34 | P1 | **fixed** `d34bb6b` and the definitions commit | Every DKYC step is checked against its own declaration before any vendor call, and stored normalised; all six of the auditor's values are refused. **Ruled 13 Oct, industry practice, and built:** an applicant under 18 is refused online and pointed to a guardian-opened minor account. The journey keeps the mobile it was started with and offers it to confirm. **Ruled 14 Oct, multiple nominees, and built** (`88c2c67`) to SEBI's circular of 10 Jan 2025 -- which SEBI's circular of 29 May 2026 (SEBI/HO/OIAE/OIAE_IAD-3/P/CIR/2026/12676, in force 1 Sep 2026) supersedes. **Ruled 14 Oct: follow the 2026 circular, and rebuilt to it:** up to three; only the name and relationship required, and a minor's date of birth; a share, mobile, email and one identifier (Aadhaar's last four, PAN, driving licence or passport) optional, the same for a minor's guardian, and checked when given; shares all given and totalling 100% or all blank and split equally, any odd lot to the first; the investor's choice of what the holding statement shows; and opting out shows the Annexure-B declaration in full and has to be affirmed -- no OTP and no video, which were the 2025 circular's. The address and the incapacity operator, which the 2026 form does not have, are gone. A nominee's and a guardian's details are masked in the CRM like the applicant's. `nominees.test.mjs`. **Ruled 15 Oct, the firm's obligations, built in the CRM:** every nomination, change and opt-out -- in the application or recorded by staff from Annexure-A/B on the client page -- is kept in a history and acknowledged to the investor by SMS and email with a reference (9.3); the client page, list and export carry what the holding statement prints, names or Yes/No as chosen (10.1); accounts without a nomination, opt-outs included, are reminded by SMS and email once each half-year, and the trading platform asks `GET /api/platform/nomination-prompt` (moved there by `OPS-42`) on each log-in and is told to show the pop-up once a day (10.2). `nominationduties.test.mjs`. **Answered 15 Oct:** the trading platform is taken to show a nomination pop-up of its own already, so it keeps that one and calls the CRM only if the teams agree to switch -- one pop-up, not two; who on the trading side receives the spec ([NOMINATION-POPUP.md](../integrations/NOMINATION-POPUP.md)) is not yet known; a nomination made on the platform or at the DP is recorded by staff on the client page for now, with an automatic feed to be configured once the team concerned confirms; and so the half-yearly reminders have a switch per business in Setup -> Business policies, **off** until an Admin or Superadmin turns it on. |
| QA-35 | P2 | **fixed** · definitions commit | The lead page's AUM tile counts Active products — it said "no active products" whenever the AUM date was missing — and a new *Account* tile says whether the account is opened, with its UCC. KYC complete, operations reviewed, account opened and product Active are defined apart in the definitions note. |
| QA-36 | P1 | **closed by ruling** 13 Oct | Not a bypass: Sales RM and Sales Supervisor hold `pii.unmask`, so the edit form's unmask is permitted and audited. Ritesh ruled that opening the editor should show contact details without a click, which is what it does. |
| QA-37 | P2 | **fixed** batches 1 to 5, 14–15 Oct | Recommendations accepted as written — [QA-37-LIFECYCLE.md](QA-37-LIFECYCLE.md) — with corrections to notes and activities as linked entries, never edits, and built entity by entity; that page says what each one does now. Built: the partner portal's withdraw and re-issue (`OPS-15`), a task *Cancelled* status (QA-02), the lead purge (`32278d2`), lists and templates (batch 1, 14 Oct), tasks, cases and corrections to notes, activities and replies (batch 2, 14 Oct), library content, holidays and case categories (batch 3, 14 Oct), automation rules and flows (batch 4, 14 Oct), and partners, KYC journeys and *Retire test records* (batch 5, 15 Oct, with Ritesh's answers of 14 Oct). Users already complied: deactivated and handed over, never deleted. `lifecycle1` to `lifecycle5.test.mjs`. |
| QA-38 | P2 | **fixed** `eaf4743` | Send email / SMS / WhatsApp open when any purpose is allowed; the dialog asks Service or Marketing and the API enforces it. |
| QA-39 | P2 | **fixed** `eaf4743` | The manual message and the list bulk send name their sender. Automated sends stay "system". The bulk send wrote two entries per lead: adjacent (i), `OPS-23`, fixed. |
| QA-40 | P2 | **fixed** `eaf4743` | The log tabs called the Setup-health counter; they call the log counter. |
| QA-41 | P2 | **fixed** `eaf4743` | A refusal shows, on all fourteen screens that put the spinner first. |
| QA-42 | P1 | **fixed** 13 Oct | Watched as the Dealer in the Service Console, as in the auditor's screenshot. Start engaging opens the panel and Mark as Exploring works. The reported result came from the panel's other moves: it offered every legal move whether or not the role may make it, and sent a refusal to the page behind it. Lost, which a Dealer cannot set, answered 403 and nothing showed -- no change, Activity 0, no product mutation in the audit, as reported. A move the role cannot make is now disabled with the reason, a refusal shows in the panel, and a move that worked says so. The auditor also asked for a Dealer's Warm to be refused; **ruled 13 Oct: a Dealer may mark Warm** -- the role matrix is right, so there is no refusal to test. `round4d.test.mjs`. |
| QA-43 | P1 | **fixed** `eaf4743` and batch one | One rule for which KYC journeys a person sees (`journeyScope`): the product in their books, and its lead one they may see; a journey with no lead yet only for those who see every lead. The board, every cockpit, the detail, the coach and the Copilot use it. Before, the board listed every journey in the business and the detail refused those whose lead the reader could not see -- a Caller, Dealer, Sales RM or Partner RM was listed journeys they could not open. The two writes `N-12` named (take over, force a step) are held to it too. Checked for every role that reads KYC, journey by journey. |

Counted: **fixed 37** — QA-01, 02, 03, 04, 05, 06, 08, 09, 11, 12, 13, 17, 18, 19, 20, 21,
22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 38, 39, 40, 41, 42, 43. **Closed by
ruling 1** — QA-36. **Partly fixed 0.** **Open 5** — QA-07 and QA-10 (UI builds);
QA-14, QA-15 and QA-16 (feature requests under earlier IDs; QA-16 is being designed from both
LeadSquared accounts' reports, read 15 Oct, for approval before it is built). Every open ID is traced or classified;
none is "unverified".

### Everything else the report asks for

| Point | Where in the report | State |
|---|---|---|
| Per-ID status back, against the report and earlier IDs | §7, retest gate | **Delivered** — this document, kept current |
| Re-run the linked reproduction paths **after deployment** | §7, retest gate | Pending a deploy of `84c2c2f` to labs.tinyepic.in — a deployment, which I do not do |
| **Revoke synthetic partner #9's portal access and sessions** — "priority cleanup" | §9, and QA-33 | **handled in code, pending deploy.** `OPS-15`'s start-up check withdraws every stored `partner<id>` password with its sessions, #9's included, the first time the fixed build starts on labs; the record itself is kept, as §9 asks. *Withdraw portal access* now exists on the partner's page. |
| A scoped, auditable cleanup mechanism for test entities the UI cannot retire | §9 | **built** in QA-37 batch 5: Setup → Test records. An Admin marks a record as test data, the list previews what retiring does to each (or what stops it), and retiring takes each out of use through its own lifecycle, with a reason; nothing is deleted. Running it on labs is Ritesh's, after the retest. |
| Preserve reproduction records #40–#44, cases #9–#11, lists #3–#4, campaigns #3–#4, partners #9–#10, rule #6, automation #2 until retest | §9 | Nothing here touches them; they live in labs.tinyepic.in's database |
| BRD gate P0 — API allow/deny tests for every role and business | §1 | not started — the largest open item. `N-12` is part of it |
| BRD gate P1 — dialler/AI disposition, 90s/120s timing | §1 | partly: QA-28 fixed; real dialler blocked on `N-6` (CUBE credential) |
| BRD gate P2 — Warm handoff, partner elevation, 60-second notification timing | §1 | partly: QA-33 fixed; timing untested |
| BRD gate P3 — DKYC validation, timers, abandonment, audited override | §1 | QA-34 fixed; timers, abandonment and the override write untested |
| BRD gate P4 — SLA sweep and reopen, live delivery, CSAT | §1 | QA-30 fixed; the rest untested |
| Pilot gates: credential hashing, session expiry and revocation, server-side authorisation, partner isolation, KYC document encryption and retention, consent and DND, India residency, the pilot database, latency and availability | §1 | not started as an **evidence** exercise. Some exist in code (passwords are hashed; PAN is encrypted); none has been written up as the auditor asks |
| Implementation sequence, steps 1–9 | §6 | Steps 1 (records), 5 (validation, partly), 6 (partner activation) advanced by `84c2c2f`. Step 2, QA-02, built 13 Oct. Steps 3, 4, 7, 8, 9 not started |
| Evidence attached to each fix | §6 | Tests in `round4.test.mjs`; before/after screenshots need the deployed build |
| Regression table against Rounds 1–3 and Ritesh's Part 4 | §4 | Rounds 1–3: each item maps to an ID above. Part 4 has its own table, [below](#riteshs-part-4): two of its items are not in the report |

### Ritesh's Part 4

Ritesh's own feedback, eleven items, received 15 October: [PART-4-source.md](PART-4-source.md), verbatim.
The auditor's QA-07, QA-10 and QA-14 are drawn from it; items 7 and 8 are not in
the report. It asks for a completion report against each item, which this table
becomes as they close.

| Item | What | Report ID | State |
|---|---|---|---|
| 1 | Confirm before Escalate and Mark resolved, with the escalation chain and what happens next | QA-07 | not started |
| 2 | At most 50 conversation entries, and Show more for the whole history | QA-07 | not started |
| 3 | Manage: changes held until Save and a confirmation; the SLA note under Status; what an internal note is | QA-07 | not started. Ruled 16 Oct: a priority change recalculates the deadlines from creation |
| 4 | Run SLA sweep: say what it does, confirm, show the result; rounded, both themes | QA-07 | not started. Ruled 16 Oct: the 72-hour close runs by itself per business (`OPS-45`) |
| 5 | The case summary cards open their cases | QA-05 | **fixed** `de27e4a`. Ruled 15 Oct: Average CSAT opens the rated cases |
| 6 | Dates as DD-MM-YYYY everywhere | QA-17 | **fixed** `de27e4a`, as 15-10-2026 14:30 IST (ruled 15 Oct) |
| 7 | A Sales RM's new lead is theirs, their name shown, no other owner offered | -- | partly: the server refuses another owner without `lead.reassign` (`OPS-19`) and the form locks the field, but it says "Assign to me" rather than the person's name |
| 8 | Product moves made clear; the Product RM handover explained, with context and a way to talk; every action says what it did | -- | not started. Ruled 16 Oct: the handover is a request on the product card, copied to each Product RM's task, with a Message button |
| 9 | The Start call pop-up | QA-10 | not started. Ruled 15 Oct: keep and redesign |
| 10 | Pipeline: choose several products | QA-14 | not started |
| 11 | Pipeline: quick filters in each stage | QA-14 | not started. Ruled 15 Oct: name or mobile, owner, days in stage, last contacted |

### Found while fixing, needing their own OPS ids

**Ids assigned 13 Oct:** (a) `OPS-15`, (b) `OPS-16`, (c) `OPS-17`, (d) `OPS-18`,
(e) `OPS-19`, (f) `OPS-20`, (g) `OPS-21`, (h) `OPS-22`, (i) `OPS-23`, (j)
`OPS-24`. Fixing (a) found three more: `OPS-25`, an elevation approval that
skipped the onboarding check, and `OPS-26`, partner responses carrying the
stored password hash, both fixed with it on approval; and `OPS-27`, the
copilot listing both businesses' partners. Four more turned up later —
`OPS-28` and `OPS-29` fixing (j), `OPS-30` building QA-02, `OPS-31` fixing
QA-06 — all book-boundary and permission gaps. **Fixed:** all ten, and
`OPS-25` to `OPS-31`, the last five on Ritesh's yes of 13 Oct. Fixing `OPS-31`
found one more, `OPS-32` -- the rest of the Product Supervisor's cockpit counts
both businesses -- recorded open on Ritesh's choice. The work of 14 Oct found
three more, recorded open on his yes: `OPS-33` (a business's branding reset at
every restart), `OPS-34` (attendance on the UTC day) and `OPS-35` (the recycle
bin listing both businesses); building QA-37 found five more, recorded open
on his yes: `OPS-36` (templates sent from a lead or a rule unchecked for
approval or business), `OPS-37` (campaign routes by id unchecked for business),
`OPS-38` (a case reply's author taken from the request), `OPS-39` (a card
showing call notes field security hides) and `OPS-40` (the content list across
businesses); and batch 5 one more, `OPS-41` (KYC journeys listed and changed
across businesses); and the nomination obligations one more, `OPS-42` (an API
key's scopes not enforced by the route guard; fixed 15 Oct on Ritesh's go-ahead); and its
reminder switches one more, `OPS-43` (business policies changed across
businesses), recorded open on his yes. **All eleven open ones fixed 15 Oct** on
his word ("Fix all 11 now"), `OPS-43` to his ruling of the same day. Reading
for Part 4 found two more, each to be fixed inside the item that exposed it, on
Ritesh's word: `OPS-44` (15 Oct: an escalation with no manager went to any Sales
Supervisor, in either business) and `OPS-45` (16 Oct: the SLA sweep closed
resolved cases in both businesses). A third, Request Product RM with no business
or visibility check, is fixed under `N-12` as ruled. State of each is in the OPS table at the top
of [OUTSTANDING.md](OUTSTANDING.md). Not counted above: they are not report IDs.

### Rulings asked for

Answered 13 Oct: 1. QA-13 (a Setup control, off) · 2. QA-09/24/35 (standard
practice) · 3. QA-06 export (allowed, with a masked/unmasked Setup control) ·
4. QA-37 (recommendations accepted as written; corrections as linked entries) · 7. OPS ids (assigned) · 8. QA-02 (signed off) ·
9. QA-36 (yes) · 10. QA-34 (industry practice) · 11. QA-42 (a Dealer may mark
a product Warm: the role matrix is right). Answered 14 Oct: 6. QA-33 (yes: a
Superadmin's audited emergency activation, built) · 5. QA-28 (the suggested
categories, and a Compliance role to receive them, built). Answered 15 Oct,
the nomination pop-up (QA-34's row): the platform's own pop-up stays, staff
record nominations made outside the CRM by hand for now, the spec's
recipient is not yet known, and the half-yearly reminders wait behind a
switch per business, off. Answered 15 Oct, Part 4: Average CSAT opens the
rated cases; the call panel is kept and redesigned; each pipeline stage filters
by name or mobile, owner, days in stage and last contacted; `OPS-44` is fixed
inside QA-07. Answered 16 Oct, Part 4: the 72-hour close runs by itself per
business; a priority change recalculates deadlines from the case's creation;
the Product RM handover is a request on the card with a Message button; the
unchecked Product RM request is fixed under `N-12`. Nothing is still open here. The DKYC half of QA-13 was
answered the same day: a separate page per business.

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
| QA-01 | P0 | **fixed** 13 Oct · verified | The server already gets precedence right, and did in the tested build: `crm.js` line 978, `const routable = req.body.route ?? (!owner_id && INBOUND_SOURCES.has(...))`. The bug is in the client. `Leads.jsx` line 594 renders *Assign to me* as `<option value="">`, so the form posts an empty owner, `!owner_id` is true, and a Website lead routes away from the person who just claimed it. **Narrow the finding: not "routing overrides the selection" but "the selection is never sent."** Fix at both ends — carry the creator's id in the option, and have the server distinguish an absent owner from one explicitly set. The report's second observation, that the form offers owners a Sales RM should not see, is separate and also open. |
| QA-02 | P0 | **not started** · verified | `engine/rules.js` has no idempotency of any kind: no key, no already-fired check, no bounded retry. It writes `rule_runs` (line 539) but never reads it to decide whether to act. Nothing stops a sweep re-firing against a record it has already acted on, which is what 48,243 firings against 41 leads describes. |
| QA-03 | P0 | **fixed** 13 Oct · verified | `portal.js` line 161: `SELECT id FROM users WHERE role = 'customer_care' AND active = 1 ORDER BY (...) LIMIT 1` — **no `sales_org` filter**, so a Bonanza partner's ticket goes to whichever Customer Care user is least loaded in either book. The INSERT on line 164 carries no `sales_org` and no `category_id`, which is why the case reads *Uncategorised*. And hard-coding `role = 'customer_care'` bypasses the SLA category table that says `Partner Support → Partner RM`. Three defects in one query. **This is the fifth instance of the book-boundary class behind OPS-05, OPS-06, OPS-07 and OPS-08** — all fixed 17–18 September, all in other routes. The portal was missed. |
| QA-33 | P0 | **fixed** 13 Oct · verified | `partners.js` line 447, `POST /:id/request-elevation`, refuses with "N onboarding step(s) still incomplete". Line 462, `POST /:id/elevate`, checks `partner.elevate` and nothing else. The auditor's narrowing is exactly right: the guard exists on the normal path and is absent on the privileged one. |
| QA-28 | P1 | **fixed** 13 Oct · verified | Three case-creation paths, three different levels of completeness. `tickets.js` line 299 inserts `category_id` and `sales_org` and calls `applySla` (line 309). `portal.js` line 164 calls `applySla` but inserts neither. `ai.js` line 235 inserts neither **and never calls `applySla` at all** — hence a High compliance case with no category and no due timestamps. |
| QA-30 | P1 | **fixed** 13 Oct · verified | `admin.js`, the send handler from line 1340: `const template = campaign.template_id ? one(...) : null`. The template is optional and a null one falls through to a default body, which is the "Bonanza update" the auditor saw. There is no approved-content guard at the API. |
| QA-32 | P1 | **fixed** 13 Oct · verified | `admin.js` line 152 refuses unless `code` is present. The screen promises a generated permanent code and offers no Code input, so the form cannot satisfy it. Either generate server-side or expose the field; the screen's promise says generate. |
| QA-34 | P1 | **not started** · verified | `kyc.js` contains no field validation whatsoever — no `validate()` call, no format check on PAN, mobile, IFSC or PIN, and no nominee total. `ifsc` is passed straight through (line 316). Every value the auditor pushed through is accepted because nothing looks at any of them. |
| QA-26 | P1 | **fixed** 13 Oct · verified | A one-word asymmetry. `POST /leads` validates `name: ['required', 'max:120']` (line 885). `PATCH /leads/:id` validates `name: ['max:120']` (line 1085) — **no `required`** — so an empty name passes the API and the database raises `NOT NULL constraint failed: leads.name`. |
| QA-08 | P1 | **fixed** 13 Oct · verified | `POST /tasks` (line 1869) requires a title and a due date, and checks the book of `lead_id` when one is given, but nothing requires *any* of `lead_id`, `card_id`, `ticket_id` or `partner_id`. All four default to null. The page's mandatory-link promise is unenforced and has no selector. |
| QA-36 | P1 | **needs decision** — traced 13 Oct, see the ledger | The client deliberately re-fetches `/leads/:id?unmask=true` for the edit form (`LeadDetail.jsx` line 1014), with a comment that the parameter is refused without `pii.unmask`. If that refusal holds, a Sales RM's form should not have been populated — so either the server gate does not cover this role or it does not cover this route. That is one read of `unmaskRequested`/`maskFor` and I have not done it. |

## Fixed on 13 October

The eight surgical fixes, in one pass. `server/test/round4.test.mjs` carries
28 tests through the shipped routes. Run against the unfixed code (`b0920fd`),
**20 fail, and every one of the eight findings has at least one that does**; the
other eight pass on both, because they guard what must keep working.

| ID | What changed |
|---|---|
| QA-01 | The New lead form sends `route: false`. The server's precedence rule was right and is untouched. The biting test is a check of the form's source -- weaker than a behavioural one, and the best available without a browser. |
| QA-03, QA-28 | One way to open a case, `engine/cases.js`, used by the case screen, the Partner Portal and the AI disposition. Each case now gets its book, its category, the least-loaded agent **in that book**, a `BNZ-`/`BGL-` reference by book, and its SLA clock. A portal ticket is Partner Support; a Complaint flag is a Complaint case. The AI door had the portal's cross-book defect too: `role = 'customer_care' LIMIT 1`. |
| QA-33 | `POST /:id/elevate` asks the same onboarding question as `request-elevation`, through one helper. The emergency override, ruled 14 Oct, is `partner.elevate.emergency` (Superadmin only) and `emergencyActivate` in `partners-support.js`. |
| QA-26 | A lead PATCH that mentions the name may not blank it, whitespace included. |
| QA-08 | `POST /tasks` needs at least one link, and **every** link is now book-checked -- only the lead was, so a partner, case or card id from the other book went straight in. The Tasks page gained a lead search, and shows a refusal instead of swallowing it. |
| QA-32 | The server issues the code the screen promised: from the name, in the catalogue's style, `BG-` for Bigul, numbered when taken. The product gets its business, and the dialog shows its own errors. |
| QA-30 | A campaign carries an approved template for its own channel from creation, an edit cannot strip or mismatch it, a duplicate is made on the same terms, and test-send and send ask again. The stock "Bonanza update" body is gone. |

**Fixing QA-32 would have switched on a dormant cross-book defect**, so it was
fixed in the same change rather than left: a new product put a card on every
lead in **both** businesses, against the rule `generateCards` states for new
leads. It never fired only because no product could be created.

Existing tests were updated where they encoded the old contract: the e2e
suite created seven campaigns with no content, and a supervisor test
created an unlinked task without checking that it had been created at all.

### Found beside the fixes, and deliberately not widened into them

Ten of them.

Each wants its own OPS id.

| | What | Where |
|---|---|---|
| a | **Every partner activated from the screen has the portal password `partner<id>`.** The route defaults to it when given none, the screen never sends one (`PartnerProfile.jsx` posts `{}`), and the response returns it in plain text. The auditor's partner #9 on labs.tinyepic.in is ACTIVE with `partner9`. Guessable by anyone who knows a partner's number. | `partners.js`, `/:id/elevate` |
| b | The partner code is `BNZ-P####` for every partner, Bigul's included. | same route |
| c | `POST /partners` never sets the partner's business, so every new prospect is Bonanza's by column default -- the defect tickets, campaigns and now products each had. | `partners.js` |
| d | The AI disposition confirm loads its lead with no book check, so any user can change card states, the score and raise cases on a lead in either business. **One of `N-12`'s cases.** | `ai.js`, `/disposition/confirm` |
| e | The New lead form offers owners a Sales RM may not assign, and `POST /leads` takes any active owner in the book without `lead.reassign`, which the edit requires. The second half of the auditor's QA-01. | `Leads.jsx`, `crm.js` |
| f | Product create silently drops the brochure and apply URLs the form sends. | `admin.js`, `POST /products` |
| g | A campaign's template is checked for approval and channel, not for business: a Bonanza campaign can send a Bigul template. | `admin.js` |
| i | A list bulk send writes **two** timeline entries per lead — `send()` writes one and the route writes its own — against non-negotiable 1, one shared timeline. Found fixing QA-39, which now signs both. | `lists.js`, `/:id/bulk/message` |
| j | Date windows compare IST dates with UTC timestamps, so a lead made between midnight and 05:30 IST counts on the day before — in the tile and the list alike, so they agree, and both are off. | `engine/daterange.js` |
| h | Duplicating a campaign never sets the copy's business, so a Bigul campaign's copy is filed in Bonanza's book -- the defect the create route's own comment describes fixing. | `admin.js`, `/campaigns/:id/duplicate` |

And two rulings: which category each of the other four compliance flags opens
(mis-selling risk, a guaranteed-return expectation, a regulatory mention,
urgency on funds -- uncategorised until then, with their deadlines), and
whether a Superadmin needs an audited emergency override for QA-33.

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

**Spent, 13 October.** All twenty below were traced the same day; where each
landed is in the ledger at the top. What follows is the list as it stood that
morning.

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

**13 October:** the eight are done. QA-02 and QA-34 are next.
