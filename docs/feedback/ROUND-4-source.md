# Bonanza AI CRM — independent QA audit, Round 4

**Author:** independent QA pass (not Ritesh)
**Dated:** 1 October 2026, testing 30 September–1 October IST
**Build tested:** labs.tinyepic.in/ai-crm — which was `1cff7c3` (18 Sep); no commit landed between 27 Sep and 3 Oct
**Scope:** 43 findings, QA-01 to QA-43, plus a role/module coverage ledger and a test-data registry
**Received:** 13 October 2026

Verbatim below. Two notes on reading it:

- Its links and image paths point at `C:/Users/Admin/OneDrive - Bonanza Group/`, the
  auditor's own machine. **The evidence is stored beside it, in
  [ROUND-4-evidence/](ROUND-4-evidence/)**: 107 original screenshots, the gallery,
  the test journal, the inventory and the manifest, unpacked from
  `Bonanza_CRM_QA_Claude_Handoff_2026-10-01.zip` on 13 October. All 107 images
  matched their SHA-256 in the inventory, and the package's own report matched the
  manifest's hash. That copy, `ROUND-4-evidence/REPORT_FOR_CLAUDE.md`, is the same
  report with its image links relative, so it opens with its screenshots in place.
- Section 10 onward is the screenshot gallery: a problem caption per image. The
  captions are useful, the image links are not resolvable from here.

Per-ID status is in [ROUND-4-TRIAGE.md](ROUND-4-TRIAGE.md), which is the document to
read first and the one to keep current.

---

# Bonanza AI CRM — independent QA handoff

**Tested:** 30 September–1 October 2026 (IST)
**Revision:** Verified CRUD and simulated KYC retest; supersedes the 30 September report.
**Evidence:** [Screenshot review with highlighted statements](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/SCREENSHOT_REVIEW.html>), original images, and a coverage/cleanup ledger accompany this document.
**Environment:** [development CRM](https://labs.tinyepic.in/ai-crm/) in Google Chrome  
**Audience:** Claude Code and Bonanza CRM product owners  
**Disposition:** Several core workflows work, but the build is **not ready for a production pilot** until ownership/routing, scheduled-rule repetition, partner activation, KYC validation, product creation, campaign approval, and metric drill-through are corrected and retested.

## 1. Basis, decisions, and test limits

I compared the live UI with the [CRM Blueprint](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/Bonanza AI CRM Blueprint_files/saved_resource.html>), [Round 1 feedback](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/Feedback Files/Bonanza-AI-CRM-Feedback-Round-1.md>), [Part 2 feedback](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/Feedback Files/bonanza-ai-crm-feedback-part-2.md>), [Part 3 feedback](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/Feedback Files/FEEDBACK-PART-3.md>), [Part 4 feedback](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/Feedback Files/Feedback for Bonanza AI CRM_Part 4.docx>), and the [final handoff](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/BONANZA_CRM_FINAL_CLAUDE_CODE_HANDOFF.md>). The [Salesforce study and acceptance tests](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/SFDC Bonanza Study/05_DECISIONS_AND_ACCEPTANCE_TESTS.md>) were used as enhancement context, not as proof of current Bonanza behavior. Its source audit was pinned to an older code state; findings below come from the current browser unless explicitly marked otherwise. The Smartping API document is an integration reference; Smartping was simulated in this test.

The owner confirmed that synthetic writes are safe and all integrations in this environment are simulated. The owner explicitly confirmed the final DKYC Finish step is simulated and creates no real account or legal agreement; that step was completed. The owner also clarified that **Marketing Manager should see unmasked PII**; this supersedes the older blueprint sentence saying Marketing has no client PII. One product-scope decision remains open: whether a Bonanza partner should be able to refer Bigul products. Do not infer that answer from the present UI.

I signed in as all **11 internal demo roles** (Superadmin, Admin, Sales RM, Sales Supervisor, Caller, Dealer, Product RM, Product Supervisor, Partner RM, Customer Care, Marketing Manager) and as both demo personas in the separate Partner Portal (**Associate** and **Remisier**). I exercised the synthetic create/edit/delete or retirement paths listed in Section 8 and opened the operational and Setup modules. **This is not an exhaustive pass of every button or every role × feature combination.** Surface-only, blocked, and untested items are explicitly identified. This was a desktop browser session. It does **not** certify every control, mobile layout/geolocation, provider callbacks, production security, load at the BRD target, or all four partner models. Do not mark those as passed from this report.

### How this retest corrected earlier conclusions

- **QA-08 corrected:** Task creation is possible with a correctly entered date/time. The confirmed defect is that an **unlinked task is accepted**, despite the mandatory-link message and missing selector.
- **QA-11 refined:** The merge selector displays static examples. A simulated send/reload proves `full_name` and `rm` resolve correctly; supported `owner`, `city`, `mobile` and `email` remain literal placeholders in the logged body. This is not evidence of an email being delivered to a wrong person.
- The email/SMS/WhatsApp and campaign tests are **simulator tests**. Email explicitly reported no SMTP delivery. File/camera controls in DKYC created simulated attachment tokens; no actual document upload or image-quality validation was certified.
- A manually sent message displays actor “system” in the timeline, but API audit rows identify Kavita Iyer. QA-39 concerns timeline attribution, not a proven absence of server audit.
- A brief loading/stale frame was not treated as a defect by itself. Persisted results were read after completion or reload. The list-import stale state and denied-API indefinite loading are independently documented.

Synthetic records, final state, and cleanup instructions are in Section 9. Do not remove reproduction records before preserving the relevant audit evidence.

### Blueprint fit and phase-gate status

The v5.0 BRD calls for **one shared data model across three surfaces** (internal CRM, public 16-step DKYC, and a separately authenticated, partner-scoped portal). It preserves five core entities—Lead, Product card, Activity, Ticket and Partner—and explicitly requires API-enforced permissions. The present build exposes all three surfaces, 11 internal role entries, product cards, partner referrals, cases, KYC screens, AI and rules. The visible breadth is substantial, but the tested ownership/routing errors show that the shared-model and permission boundaries cannot yet be accepted. These are the most useful BRD acceptance checks for the next build:

| BRD gate | Current evidence | Acceptance status / next proof |
|---|---|
| P0: 11 roles and API-enforced permissions | All 11 demo role cockpits opened; Sales RM creation produced an out-of-scope lead (QA-01) | **Open.** Run direct API allow/deny tests for every role and business, then repeat lead creation and readback. |
| P0: configurable product and two-condition rule dry run | Disabled rule #6 with Website AND age=0 matched #40/#42; nothing sent. New-product Save fails “Code and name are required” despite generated-code promise. | **Blocked/partial.** Product creation/backfill blocked by QA-32; minimum validation QA-31. Rule create/edit/dry run passed, activation/execution intentionally left disabled; existing scheduling has QA-02. |
| P1: caller/dealer call disposition, edits, card/task/score effects, compliance ticket | Superadmin simulated complaint call → edited review → Confirm created activity, +3 score, linked task and High case #11. Caller Exploring allowed; Warm UI denied. Dealer allowed city edit. | **Partial.** Auto-created case has no SLA/classification (QA-28). Dealer engagement result needs QA-42. Production AI/dialer and 90s/120s timing were not certified. |
| P2: Sales RM Warm handoff; partner onboarding/elevation; attributed referral | Referral #41 retained attribution. #42 MF handoff created High task/notification for Deepak; owner stayed Priya. Partner RM prospect advanced 1/8 and incomplete elevation was denied. Superadmin activated partner #9 at 0/8. | **Fail/partial.** Superadmin activation gate QA-33; acknowledgement context QA-21. Exact 60s notification timing and full approved elevation/sign-in remain open. |
| P3: complete 16-step DKYC, timer/abandon, supervisor override | Bigul Trading journey #43: baseline 14 → income proof 15 → bank proof 16; wrong OTP/missing consent/proof blocked; pause/reload restored step; simulated Finish complete. Product Supervisor Bonanza detail exposes override controls. | **Partial/fail.** Invalid mobile/PAN/IFSC/account/PIN and nominee 150% accepted (QA-34). Actual uploads, exact timers, abandonment and audited override write remain untested; list/detail scope has QA-43. |
| P4: SLA escalation/reopen and campaign reach/activity | Cases #9/#11 replies/status/resolution and simulated CSAT exercised. Static list #4 import/bulk edit; campaign #3 send logged one activity. Copy #4 skipped opted-out member, sent 0. | **Partial/fail.** Campaign sends without approved template (QA-30); AI case SLA QA-28; review flow QA-07. SLA sweep/reopen, live delivery, bounce/click and CSAT submission remain untested. |

The BRD separately makes credential hashing, expiring/revocable sessions, server-side authorisation, partner isolation, encrypted KYC documents, consent/DND, India residency, PostgreSQL for pilot, and stated latency/availability targets **pilot gates**. Its prototype text says plaintext passwords and SQLite were deliberate prototype choices; this browser pass did not inspect the current deployment's storage, credentials or infrastructure, so it does not claim those conditions still hold. Request implementation and test evidence for each non-functional gate before pilot sign-off.

## 2. Fix first — confirmed behavior and defects

### QA-01 · P0 · Configured routing overrides the Sales RM’s “Assign to me” selection

**Problem:** A successfully created lead is immediately inaccessible to its creator.

**Related:** Part 4 lead-owner request; Blueprint role ownership. **Repro:** Sign in as Priya Sharma, Leads → New lead → Website source → “Assign to me.” Lead #40 was assigned to Caller Sneha; the independent retest created [lead #42](https://labs.tinyepic.in/ai-crm/leads/42) and again displayed **“This lead is outside your visibility scope.”** Superadmin audit for #42 records `routed_to:6`, owner Imran Shaikh, rule `Google / paid search → Digital Desk (team)`, source Website. Thus the routing engine, rather than a random owner display error, overrode the explicit selection. The form also offered other owners despite the Sales RM restriction.

**Expected/fix:** Define precedence for manual owner, automatic source routing, import, and portal creation. For the user’s Part 4 Sales RM requirement, enforce the authenticated Sales RM as owner at the server, reject/ignore unauthorized owner fields, and return a record the creator can immediately read. Keep intended automatic routing for the appropriate ingestion paths. Verify creation/readback in both businesses and each permitted creator role. Do not simply disable all routing.

**Retest evidence:** QA01-sales-create-assign-to-me, QA01-sales-created-denied, QA01-audit-routing-cause, QA01-owner-after-create.

### QA-02 · P0 · Scheduled rules appear to repeat against the same records and have produced an unusable task backlog

**Related:** older handoff B-01, Part 3 automation builder. **Evidence:** [Rule builder](https://labs.tinyepic.in/ai-crm/setup/rules) showed enabled rules `Warm → notify Product RM` fired **10,431×**, `KYC escalation waterfall` **48,243×**, and `transfer lead to post sales team` **47,526×**. [Audit log](https://labs.tinyepic.in/ai-crm/setup/audit) recorded all three `rule_fired` entries every five minutes. [Database](https://labs.tinyepic.in/ai-crm/setup/database) showed **10,477 tasks**, **48,443 activities**, **29.5 MB rule_runs**, **17.1 MB notifications**, with only **41 leads**. Priya's cockpit showed about **10,000 overdue follow-ups** and repeated identical `Contact lead — warm MF card` tasks. A dry run of the Warm rule matched one lead and sent nothing. On the independent retest, counters rose to **10,509 / 48,633 / 47,994**; a later Admin cockpit showed **10,703 overdue follow-ups**. The disabled synthetic two-condition rule matched exactly leads #40 and #42 and sent nothing. The firing counter alone may count evaluations, so inspect rule runs and resulting task/notification IDs before attributing every row to duplication; the duplicate tasks and backlog are observable. **Expected:** Event/condition transitions execute once per intended record/state/step, with durable idempotency keys, bounded retries, and a retention policy. Reconcile duplicate side effects and display a useful backlog, then regression-test each enabled rule under repeated sweeps.

### QA-03 · P0 · Bonanza partner support is assigned across the business boundary

**Related:** Blueprint partner isolation, SLA category routing; older handoff B-02. **Repro:** In the Partner Portal, Girish Patel (Bonanza Associate) submitted `QA Partner Support 20260930`. It created [BNZ-00010](https://labs.tinyepic.in/ai-crm/tickets/10), marked **Uncategorised**, assigned to **Divya Menon**, whose user record is **Bigul Customer Care**. The [SLA category setup](https://labs.tinyepic.in/ai-crm/setup/sla) says `Partner Support → Partner RM`. In Bonanza Customer Care view, the case header still says Divya, but the Manage assignee picker says **Unassigned**, because Divya is outside the selectable Bonanza users. **Expected:** Portal support assigns the correct business and category, chooses an eligible assignee in that business, and presents one consistent assignee value. Add server-side cross-business assignment rejection and automated tests for portal, case create, reassignment, and escalation. Audit whether Bigul staff could receive or view this Bonanza case; that visibility was not tested.

### QA-04 · P1 · Cockpit numbers do not drill through to the counted records

**Related:** Round 1 `ENH-05/05a`, Part 2 `P2-13/P2-17c`. On Superadmin Home, `NEW LEADS 3` for month to date linked to `/leads?created_from=2026-09-01&created_to=2026-09-30`, but the destination displayed **39 leads**, including April/August rows. `WON 0` linked to the same date range plus `stage=Won`, but displayed **6 Won leads**. The stage filter applied; the date query did not. On 1 October, a fresh All businesses retest showed **New leads 2** for 01-10-2026; its exact date URL again opened **44 leads**, including May/August rows. Counts changed as synthetic records were added; the filter defect persisted. **Expected:** Clicking any figure opens the exact underlying set with the same date window, role scope, business and definition; list total must equal the tile or explain an explicit difference. Use one query contract for count and drill-through, including browser refresh and back navigation.

### QA-05 · P1 · Customer Care summary counts and case filters disagree

**Related:** Round 1 `ENH-05a`, Part 4 case summary tiles. Customer Care Home showed `OPEN CASES 4`; its link `/tickets?open=true` opened the default **Assigned to me / 2 cases** view. Manually choosing **All open** showed four. The separate case-summary strip (`OPEN ASSIGNED`, `SLA BREACHED`, `RESOLVED TODAY`, `CSAT`) was not clickable. After resolving synthetic case #9 that day, Home's month-to-date Resolved incremented to 2 while the separate `RESOLVED TODAY` remained 0. **Expected:** Each tile goes to the exact filtered records; daily, month-to-date, assigned and all-open measures have explicit definitions and agree with the destination.

### QA-06 · P1 · Marketing PII policy is contradictory across screens and Setup

**Owner decision:** Marketing Manager **may see unmasked PII**. [Roles & permissions](https://labs.tinyepic.in/ai-crm/setup/roles) still denies Marketing `pii.unmask`; [Field masking](https://labs.tinyepic.in/ai-crm/setup/masking) marks Marketing mobile, phone, PAN and bank/account fields masked (email visible). The [lead list](https://labs.tinyepic.in/ai-crm/leads) masks mobile; [lead #40 detail](https://labs.tinyepic.in/ai-crm/leads/40) masked mobile but displayed full email. Yet [list #3](https://labs.tinyepic.in/ai-crm/lists/3) displayed the full synthetic mobile, and a seeded list displayed full member mobiles. **Expected:** Encode the clarified policy in one server-side field-access model and apply it consistently to lists, lead lists/details, search, email merge, exports and API responses. Treat export as its own capability decision; Marketing list Export currently opens a download flow but ultimately returns `Your role (marketing_manager) cannot do this`, which is a separate UX mismatch. Do not grant export solely because view is unmasked without an explicit business decision.

### QA-07 · P1 · Case changes still bypass the requested review/confirmation step

**Related:** Part 4 case feedback. On [case #9](https://labs.tinyepic.in/ai-crm/tickets/9), changing Manage status `Open → Pending` saved immediately. Clicking **Escalate** directly changed Medium→High, Nikhil Rao→Anil Deshpande and added an internal entry. Clicking **Mark resolved** directly resolved the case and triggered the simulated CSAT flow. There was no pre-action summary, escalation matrix, action checklist, **Save/Cancel**, or confirmation. The `Internal note` checkbox showed no explanatory text when selected. The AI case summary was briefly stale after escalation, showing the former priority/assignee. **Expected:** Stage changes remain drafts until Save; escalation and resolution show the specified consequence/recipient/timing summary and explicit Confirm/Cancel. Refresh the AI summary or label it with an as-of time after mutation. Do not change the underlying SLA/assignment effects while adding the review flow.

### QA-08 · P1 · Tasks accepts an unlinked record despite its mandatory-link requirement

**Problem:** A task can be created with no lead, client, partner or case link.

The [Tasks page](https://labs.tinyepic.in/ai-crm/tasks) says every task must have a linked record and a due date. New task has title, due, priority and assignee, but **no linked-record selector**. Entering a valid date/time enabled Add task; submitting `QA Cannot Create Unlinked 20260930` succeeded and the table shows **Linked to —**. The title reflects the original probe, not the final result.

**Expected/fix:** Add a searchable entity selector and enforce the intended link rule at the API. If unlinked personal tasks are intended, revise the requirement and label their scope explicitly. Keep due-date validation. Lead-linked creation and completion were tested separately and worked.

**Correction:** The previous report’s “cannot be completed” conclusion was incorrect and is superseded by this result.

### QA-09 · P1 · Partner client stage and live-account measures disagree

In the Partner Portal, Aarav Malhotra's row said **Trading**, KYC Complete and AUM ₹2.40L; opening it showed **Stage New**. The internal [Clients page](https://labs.tinyepic.in/ai-crm/clients) showed **0 live accounts**, while internal Products and Revenue showed 13 active product interests and about ₹56L active value. The partner's ₹54,400 “lifetime commission” also includes an **Accrued** ₹16,000 statement row; distinguish accrued from paid totals. **Expected:** Define and label lead stage, account activation/trading status, active product state, AUM, accrued commission and paid commission separately; derive each presentation from the authoritative entity. Fix seed data if this is fixture inconsistency. Do not equate an active product card with an issued UCC unless the business explicitly approves that meaning.

### QA-10 · P1 · The call panel remains hard to use in both themes

**Related:** Part 4 Start Call feedback. On [lead #40](https://labs.tinyepic.in/ai-crm/leads/40), **Start call** opened a large translucent overlay. The page behind visibly bleeds through in light and dark themes; the upper-right **End call** control appears as a blank white rectangle; 11 products make the center column long and hide useful content below the viewport. The panel offers **Mark Warm** while this product is already Warm, and its own note says actions are “indicative” and state changes occur elsewhere. Ending the simulated call exposes a transcript/disposition panel with sample scripts, but no call event was certified against a real dialer. **Expected:** Opaque, contrast-safe, scrollable panel with a visible primary control, concise active-product context, state-aware actions, and a clear outcome of every action. Test at desktop and Sales RM mobile widths.

### QA-11 · P1 · Supported email merge fields remain unresolved in the recorded message

**Problem:** The logged simulated email contains placeholders for fields the composer explicitly offers.

**Repro:** Superadmin → [lead #42](https://labs.tinyepic.in/ai-crm/leads/42) → email. Send a synthetic body using the selector’s supported tokens:
`Lead={{full_name}}; RM={{rm}}; Owner={{owner}}; City={{city}}; Mobile={{mobile}}; Email={{email}}.`
The toast says **“Recorded and logged. No mail was actually delivered — SMTP credentials are not configured yet.”** Reload the lead and read the Email activity. Full name resolves to QA CRUD Lead Edited 20260930 and RM resolves to Rohit Menon; **owner, city, mobile and email remain literal tokens**.

The selector also shows static Aarav/Sneha/Vikram examples unrelated to this compose context. Treat those as an example/preview UX issue; do not infer wrong recipient delivery. Unsupported initial probes such as `sender_name` were excluded.

**Expected/fix:** Use one documented merge-field resolver for preview, test, direct send and campaign send. Every offered token must resolve from the correct role/record context, obey field access, or show a clear pre-send error; never silently log/send unresolved supported placeholders. Verify exact rendered body after refresh. Actual SMTP delivery remains untested.

### QA-12 · P1 · API access screen instructs users to use HTTP for secrets

The [API access tab](https://labs.tinyepic.in/ai-crm/setup/logs) advertises base URL **`http://labs.tinyepic.in`**, followed by `X-Api-Key` and `X-Api-Secret` headers, even though the CRM is served at HTTPS. The issue-credential dialog otherwise presents sensible user binding and optional narrowing; no credential was issued. Superadmin retest confirmed the HTTP base URL is still present and there are zero active credentials. Admin’s denied API access has a separate UI error-handling defect (QA-41). **Expected:** Show the verified HTTPS API base URL and reject or redirect insecure credential-bearing requests before accepting headers. Confirm environment/base-path generation and documentation together.

## 3. Remaining functional and UX gaps

| ID | Priority | Evidence and requested outcome |
|---|---|---|
| QA-13 | P1 decision | [Partner Portal](https://labs.tinyepic.in/ai-crm/portal) referral picker shows all 20 Bonanza/Bigul products, including two `Mutual Funds` and two `Global Investing`, while a Bonanza [referral lead #41](https://labs.tinyepic.in/ai-crm/leads/41) has only 11 Bonanza product slots. The public [DKYC entry](https://labs.tinyepic.in/ai-crm/dkyc) says “Open your Bonanza account” yet offers Bigul products. Bonanza Equity's in-call pitch says “Bigul flat plan.” Resolve the business-scope question below, then filter/label the catalog and review brand-specific copy in every entry point. |
| QA-14 | P2 | [Pipeline](https://labs.tinyepic.in/ai-crm/pipeline) now populates 47 opportunities (Round 1 `BUG-20` improved), but Product is a single-select; stage columns have no quick search/filter. Part 4 asks multi-select products and per-stage filters that remain usable with thousands of rows. |
| QA-15 | P2 | [Leads](https://labs.tinyepic.in/ai-crm/leads) renders all 41 rows with no page-size or pagination control (`P3-37`). Only Lead and Stage headers expose sort buttons; relevant other columns do not (`P3-36`). Columns picker (`P3-38`) works structurally and keeps Lead mandatory. Bulk update (`P3-39`) offers selected/all/specific count and correctly warned that 42 exceeds 41, but its “across all pages” wording is premature until pagination works. |
| QA-16 | P2 | [Reports](https://labs.tinyepic.in/ai-crm/reports) has eight predefined views and a date window, but no visible custom report builder (`P3-06`). [Dashboards](https://labs.tinyepic.in/ai-crm/dashboards) has date presets, but no visible create-dashboard or chart-type controls (`P2-17`). Treat these as incomplete requested capabilities, not defects in the existing charts. |
| QA-17 | P2 | Date formatting remains inconsistent with Part 4's `DD-MM-YYYY` request: list dates use `30 Sept`, import history and calendar/holiday entries use ISO strings, and the new meeting-follow-up toast said `2026-10-03 09:00:00`. Establish a single display formatter (including time and timezone) while preserving ISO storage/API values. |
| QA-18 | P2 | App Launcher remains open when clicking outside on the page (`P3-31`); it closes only when toggled explicitly. Its role-filtered item list is useful, but Marketing can see apps such as Service Console that lead to a narrowed or unrelated view. |
| QA-19 | P2 | Marketing Home's **Create list** action was disabled with “Lead Lists is still in build,” yet [Lead Lists](https://labs.tinyepic.in/ai-crm/lists) allowed creation of list #3. Remove stale affordance/help or wire the shortcut to the working flow. |
| QA-20 | P2 | Tickets (0) still displays resolved history. On #42 Tasks (2) displays three rows: one completed and two open. The counts appear to mean open items, but the labels do not say so. Label “Open tasks/Open tickets” or count all visible history. |
| QA-21 | P2 | Sales RM request on #42 Mutual Funds created a High task assigned to Deepak Joshi and a Product RM cockpit notification naming Priya, the lead and product. Lead owner stayed Priya: routing works in this test. The sender acknowledgement remains generic and lacks a linked assignee/handoff brief. Exact 60-second delivery timing was not measured. |
| QA-22 | P2 | [Market](https://labs.tinyepic.in/ai-crm/market) presents six news headlines as static text, not links to articles (`ENH-09`). The simulated market feed is labeled, which is good; distinguish source/date clearly before live financial use. |
| QA-23 | P2 | [Data residency](https://labs.tinyepic.in/ai-crm/setup/residency) says **no frontier provider is configured and every call is served locally**, yet its “egress evidence” table labels ticketSummary rows **Sent**, while four capabilities are described as routing outside India. Clarify whether `Sent` means a simulated local invocation or actual egress; audit evidence must not overstate real cross-border traffic. No network egress was independently verified. |
| QA-24 | P2 | Partner case #10 and the [lead list](https://labs.tinyepic.in/ai-crm/leads) show unresolved business data quality: a Bonanza partner case was unclassified, while several lead rows have lead stage `Won` but product states Exploring/On hold/Lost or no product interest. Define validation/seed checks so “Won” and partner service reports mean what business users expect. |
| QA-25 | P2 | On Customer Care Home, Copilot's suggested **Any SLA breaches?** question returned one case, BNZ-00008, while the main `SLA BREACHED` tile showed four and the assigned-queue strip showed one. The answer is consistent with the assigned queue but does not state that scope. The right drawer also covers the last dashboard cards at the tested desktop width; it is usable and closes cleanly. Label the answer “in your assigned queue,” link to that exact filtered set, and ensure underlying dashboard controls remain reachable or reflow when the drawer opens. |


## 3A. Findings added by the CRUD and KYC retest

P0 means block pilot until resolved; P1 means repair before the affected workflow is accepted; P2 means a functional or UX correction. “Decision” and “capability gap” are not automatically confirmed bugs.

### QA-26 · P1 · Empty lead name exposes a database constraint error

**Problem:** Save accepts the invalid form far enough to expose **`NOT NULL constraint failed: leads.name`**.

**Repro:** Superadmin → #42 Details → Edit → clear Name → Save changes. The dialog stays open; the old valid name remains persisted. A subsequent valid name/city/risk/owner edit saved correctly. After Save scrolls to the dialog footer, the error is above the viewport; focusing Name brings it into view. The final response screenshot shows both the error and empty Name.

**Fix/acceptance:** Required-field validation on the form and every server write, trim whitespace, return a readable field error without database internals. Reject empty/whitespace/import/automation names; preserve the last saved record.

### QA-27 · P2 · Successful soft delete leaves an unexplained “Lead not found” page

**Problem:** Deleting synthetic #42 leaves the user on its detail URL showing **“Lead not found.”**

Exact-name confirmation works: wrong text keeps Delete disabled. Deletion succeeded, Recycle bin listed #42, and Restore recovered the edited fields, note, tasks and product cards.

**Fix/acceptance:** On success, give an explicit confirmation and return to the appropriate list with an Undo/Recycle bin link. Reserve the error state for an actual lookup failure. Test delete → list count → restore → readback.

### QA-28 · P1 · AI-created High compliance case has no category or SLA deadlines

**Problem:** The complaint disposition created [BNZ-00011](https://labs.tinyepic.in/ai-crm/tickets/11) with High priority, **Uncategorised**, and **Response due / Resolution due / SLA remaining all —**.

The editable simulated call summary was confirmed before application. The activity, +3 score, linked follow-up task and compliance case were created. Setup has High defaults of 60 minutes response / 8 hours resolution, but this case did not display deadlines. Public reply and an internal note subsequently worked.

**Fix/acceptance:** Route all case creation paths through the same category/assignment/calendar/SLA initialization. Verify an AI compliance case, manual case, portal case and integration case have the intended business/category and due timestamps. Preserve the exception/reason explicitly if any case may have no SLA.

### QA-29 · P2 · Static list stays empty after a successful member import

**Problem:** List #4 still showed **Static · 0 / empty list** while the toast said **1 lead added**. Reload showed the one member.

Import by mobile used one synthetic match and one nonexistent number; the result correctly reported one added and one missing. Bulk City edit on that member persisted.

**Fix/acceptance:** Refresh list membership, count and empty-state data after import. Reopen/close the modal, then verify the same member/count without a manual reload; keep missing-row results accessible.

### QA-30 · P1 · Campaign can send without selecting approved content

**Problem:** Campaign creation offers **Choose an approved template**, but leaving it unset still enables Create, Test on me and Send.

Synthetic email campaign #3 targeted only list #4/#42. Test returned **“Sent to you only. No lead contacted.”** Send returned **“Send done.”**, marked Sent 1, and created an Email activity titled **“Bonanza update”** from a fallback body. The missing approved-template/content requirement was not explained.

The consent test is a positive result: duplicated campaign #4, with #42 opted out, reported **“1 person was skipped — opted out, no contact details, or a number flagged invalid.”**, Sent 0, and created no new lead activity.

**Fix/acceptance:** Define and enforce the approved-content rule. If an approved template is required, block draft creation/send until selected; if another approved content route is allowed, expose that route and its approval. Show exact audience, purpose, rendered message and suppressed count before sending. Test the API guard and every channel; this pass certified only simulated email and consent suppression.

### QA-31 · P2 · Product minimum amount allows only multiples of ₹1,000

**Problem:** The browser rejects ₹500 with **“Please enter a valid value. The two nearest valid values are 0 and 1000.”**

The existing catalogue includes Mutual Funds ₹500 and Research Subscription ₹2,999. The input step prevents entering comparable amounts in a new product.

**Fix/acceptance:** Use a step compatible with the business’s currency precision and validate nonnegative values at the API. Verify 0, 500, 999, 2,999 and any supported decimal precision.

### QA-32 · P1 · Product creation fails because the promised generated code is missing

**Problem:** A valid product form returns **“Code and name are required”** although the screen says the permanent code is generated and has no editable Code input.

Superadmin entered QA CRUD Product 20261001, category QA Synthetic, minimum ₹1,000, no lock-in, risk Not stated and KYC off. Save failed; catalogue remained 20 products. **The error is rendered on the underlying Products page and obscured by the still-open dialog; closing Cancel reveals it.** The response screenshot below was recaptured after uncovering that banner. Therefore new-product editing, retirement and existing-lead backfill could not be tested safely on a new record.

**Fix/acceptance:** Align form and API generation. Create a unique immutable product code on the server or expose a required code field with clear validation. Verify create → readback → edit allowed metadata → retire and the BRD’s backfill of product slots on existing leads.

### QA-33 · P0 · Superadmin can activate a partner at 0/8 onboarding and immediately issue portal access

**Problem:** Clicking **Elevate to partner entity** on synthetic [partner #9](https://labs.tinyepic.in/ai-crm/partners/9) immediately made it **ACTIVE · BNZ-P0009 · Portal access**, while onboarding remained **0/8**. There was no review/approval confirmation.

The prospect was explicitly synthetic. The unexpected credential banner was not used or included in shared evidence; a fresh screenshot shows only state/code/access. No visible revoke/deactivate/delete control was available.

**Narrowed by role retest:** Partner RM created #10, advanced the business-profile step to 1/8, then Request elevation correctly refused with **“7 onboarding step(s) still incomplete.”** The defect is in the privileged direct-activation path, not a claim that every elevation path lacks a guard.

**Fix/acceptance:** Enforce prerequisites and approval at the server for the normal path. If Superadmin emergency override is intended, require a distinct, explicit override with reason, consequence summary and immutable audit; do not silently bypass the normal flow. Verify no partner code/credential/session is issued on refusal. **Revoke synthetic partner #9’s portal access during cleanup.** Never reproduce with a real partner.

### QA-34 · P1 · DKYC completes with invalid identity, bank and nominee values

**Problem:** The complete simulated journey accepted **mobile 123, PAN BAD, IFSC BAD, account number 123, PIN 000000 and nominee allocation 150%**. Mobile 123 and PAN BAD remained on [lead #43](https://labs.tinyepic.in/ai-crm/leads/43) after Finish.

The initial mobile was 9000000044, but step 1 asked for it again and accepted the shorter value. Bank failure correctly introduced Bank proof; income/segment choices correctly introduced Income proof. Missing required proof/consent and a wrong OTP were blocked. Invalid email received browser validation.

**Fix/acceptance:** Apply field-format, required-field, date/age and nominee-total rules before advancement and at every persistence endpoint. Preserve the starting mobile or clearly explain/change it with re-verification. The simulator should still validate the input envelope, while provider verification can remain simulated. Add valid/invalid/boundary tests for Indian mobile/PAN/IFSC/PIN, supported bank lengths, future DOB, nominee percentages and totals, and all API bypass paths. No real provider or legal-account acceptance was certified here.

### QA-35 · P2 · KYC-complete lead says “no active products” while showing an Active card

**Problem:** #43’s Trading & Demat Account card is **Active**, but its summary says **“no active products.”**

The public success message also says operations will review and activate the account within one working day. That may be a different account state from product-card Active; the present labels do not explain the distinction.

**Fix/acceptance:** Correct the active-card summary query, then agree separate meanings for KYC complete, product Active, operations reviewed, account activated and UCC issued. Test zero-value Active cards and each transition. Do not automatically equate a product state with an issued trading account.

### QA-36 · P1 · Sales edit dialog reveals contact values masked in the read view

**Problem:** Sales RM/Sales Supervisor read views mask #42’s mobile/email, while the Edit dialog reveals their complete values without an explicit unmask action.

Sales RM stage and owner fields were correctly disabled. Product RM detail was masked and read-only. Dealer’s #44 editor kept contact fields masked and disabled and allowed City editing, so this is role-specific.

**Fix/acceptance:** Agree and enforce the view/edit policy consistently. If a role may see the value while editing, make that intentional policy visible in Setup and read views; otherwise never populate full PII into its form. Test list/detail/edit/search/merge/export/API projections with the same role. No direct API exfiltration test was performed.

### QA-37 · P2 capability gap · Several configurable entities lack a complete lifecycle

**Problem:** Applicable create paths exist, but ordinary rename/edit/retire/archive/remove actions are absent from the inspected UI.

| Entity | Verified behavior / missing control |
|---|---|
| Static list | Create/import/bulk member edit work; no list rename/archive/delete or remove-member control. “Delete every member” soft-deletes leads and must not substitute for list deletion. |
| Campaign | Create/duplicate/send work; no draft edit/delete controls. |
| Library/content | Create/submit/reject/resubmit/independent approval work; no visible edit/version/withdraw/archive/delete. |
| Partner | Prospect create/onboarding/note work; no visible contact editor, retire/revoke or delete. Revoke is especially needed for QA-33 cleanup. |
| Tasks | Linked/unlinked creation and completion work; no visible title/due/assignee editor or cancellation/delete. |
| Notes/cases/activities | Create history works; no inspected history edit/delete control. Confirm retention/correction policy rather than adding destructive history deletion by default. |
| Automation container / rule | Draft/rule creation and edit work; step delete works with confirmation. No container rename/delete or rule delete control observed. |
| Holiday | Add/remove works; no edit control. |
| SLA / KYC configuration | Read-only tables in Superadmin. No visible policy/category editor or journey composer. Eight Bigul KYC-required products show 0 configured steps, yet runtime used a 14-step fallback and 16 with branches; distinguish configured and fallback definitions. |
| Message template | Create/edit/delete works, but Delete removed the test row without confirmation or visible success feedback. |

**Fix/acceptance:** Define lifecycle and permissions per entity with recoverable retirement/archival where appropriate. Show blocked actions with a reason and a usable cleanup path. Do not label retained immutable audit history a defect merely because hard deletion is absent.

### QA-38 · P2 · Opted-out lead’s email entry points apply different purpose rules

**Problem:** On opted-out #42, Actions → Send email is disabled as marketing, while the header email button opens a composer where **Service** is allowed and **Marketing** is disabled.

The Marketing guard and campaign suppression worked. The discrepancy prevents a permitted service action from the menu.

**Fix/acceptance:** Route both entry points to the same purpose-aware composer/permission decision. Preserve marketing suppression and clearly distinguish service messages; test email/SMS/WhatsApp purpose rules.

### QA-39 · P2 · Manual message timeline says “system” instead of its initiator

**Problem:** Admin Kavita sent two synthetic service messages; both bodies persisted, but the SMS/WhatsApp timeline labels the actor **system**.

**Evidence limit:** API audit correctly names Kavita for the two `POST /api/leads/42/message` requests (201). Server audit is present.

**Fix/acceptance:** Show the initiating user and delivery adapter separately. Keep system labeling for genuinely automated sends. Verify actor provenance for direct, campaign, rule and integration messages.

### QA-40 · P2 · Monitoring counters say zero while tables contain thousands of entries

**Problem:** API and portal access says **0 entries**, every channel tab shows **0**, while the table footer shows **most recent 100 of 8,646** (later 8,657).

Filtered message requests still show two recorded rows, while the zero count remains.

**Fix/acceptance:** Use a consistent count contract for category total, filtered result count and displayed page size. Handle loading separately from zero. Test no rows, nonempty rows, filtering, refresh and retention boundaries.

### QA-41 · P2 · A refused Admin API tab stays at “Loading”

**Problem:** Admin → Setup → API & logs → API access stays at **Loading**, including reload/retry. API audit records `GET /api/setup/api-credentials` **403** for Kavita.

Superadmin opens the tab normally (and still shows the HTTP guidance in QA-12). The server restriction itself may be intentional.

**Fix/acceptance:** Show an explicit role restriction or error with a way back; hide/disable the tab if access is not allowed. Handle 403/404/500/network failure without permanent spinners. Preserve the server permission.

### QA-42 · P1 · Dealer’s enabled Start engaging action produces no visible result

**Problem:** Dealer Vikram opened its temporarily assigned synthetic #44, clicked Mutual Funds **Start engaging**, but the card stayed **Not engaged**, Activity stayed 0 and no error/explanation was displayed; reload preserved the unchanged state.

Dealer could edit City and that save persisted, with masked contact fields and disabled stage/owner. The visible filtered API audit contains that PATCH 200, but no product mutation entry for this attempt. **Root cause is not established; this is not reported as an observed server 403.**

**Fix/acceptance:** Wire the enabled action to the intended Dealer transition, or disable it with a policy reason. Show in-flight/success/error state, verify card/activity/audit after reload, and test Dealer Warm refusal separately. Do not claim the Dealer’s full AI disposition/handoff workflow passed from this observation.

### QA-43 · P1 · Product Supervisor KYC list includes a journey its detail API refuses

**Problem:** Meera’s KYC health/Completed list includes Bigul synthetic #43 (journey #14), but Open stays at Loading; API audit records `GET /api/kyc/journeys/14` **403**. A Bonanza journey (Diya) opens with Force complete controls.

**Fix/acceptance:** Apply the same authorized business/record scope to list, cockpit and detail. If cross-business supervisor access is intended, align the permitted detail API; if it is not, remove the unauthorized list data. Always show a refusal instead of an endless spinner. Verify both businesses and own/other-product/other-team scopes before calling this an isolation pass.


## 4. Regression against earlier feedback

**Verified in this session** means the named UI/control and, where stated, one synthetic path were observed. It does not assert complete coverage of every subpoint.

| Earlier item | Current status | Evidence / remaining work |
|---|---|---|
| Round 1 `BUG-20` Pipeline empty | Improved | Pipeline displayed 47 opportunities; filtering enhancement remains QA-14. |
| Round 1 `BUG-07` Copilot panel/layout | Partly improved | A suggested question produced a case-linked answer and the drawer closed cleanly. The drawer obscured right-hand dashboard cards, and breach scope was not explicit; see QA-25. |
| Round 1 `BUG-25` Lead Lists broken | Improved | Created refreshable list #3 and saw one matching member; Marketing Home shortcut is stale (QA-19). |
| Round 1 `ENH-06`, Part 2 `P2-08/P2-09` email | Partly improved | Composer opens with attachment and approved collateral. Simulated send/readback leaves supported tokens unresolved (QA-11); no SMTP delivery. |
| Round 1 `ENH-05/05a`, Part 2 `P2-13/P2-17c` drill-through | **Open** | QA-04 and QA-05. |
| Round 1 `ENH-09` market links | **Open** | QA-22. |
| Round 1 `ENH-16` masking | **Open against clarified policy** | QA-06; Setup is configurable but the Marketing rule is inconsistent. |
| Round 1 `BUG-27/ENH-28` portals | Partly improved | Associate and Remisier sign-in, referral, support, earnings, onboarding and training views opened; a training module displayed detail. The Remisier's list contained only its two seeded clients and not the Associate's synthetic referral, a positive UI isolation check. Complete simulated Bigul DKYC #43 exercised with proof branches and pause/resume. Partner activation and KYC data validation remain QA-33/34; partner data/status and product scope QA-03/09/13. |
| Round 1 `BUG-26` Clients blank | Unresolved definition/data | Clients is still empty while product cards and partner dashboards describe active/trading business; see QA-09. The simulated Trading DB may explain the empty UCC book, but the current labels need a consistent definition. |
| Part 2 `P2-03` UAT/production promotion | Partial | Setup has package, preview/apply and “development” label. A separate UAT/Production target and rollback were not demonstrated. |
| Part 2 `P2-04/P2-05` user/role admin | Partial | Users, 11-role matrix, ghost-login/reset/edit controls present. Sensitive changes and full hierarchy were not exercised. |
| Part 2 `P2-14/P2-15/P2-25`, Part 3 `P3-20` integrations | Partial | Twelve adapter statuses, API credentials/logs, telephony and webhooks screens exist; most providers are simulated. The general Integrations screen is largely status/config-by-environment rather than the requested guided connector marketplace. |
| Part 3 `P3-01/P3-22/P3-23/P3-24/P3-25` monitoring controls | Present, surface verified | Audit filters/export, API log filters, database export, residency filters/export visible. API log filtering and named message actor verified. Zero counters contradict populated rows (QA-40), and a refused Admin API tab remains loading (QA-41). Exported files and retention behavior were not validated. |
| Part 3 `P3-02/P3-04/P3-11` admin UX | Present, surface verified | User export allowed selecting 7 of 22 fields; advanced-search field picker has search; masking setup offers Add a field. |
| Part 3 `P3-07/P3-08` hierarchy/groups | Partial | Sales groups show a business/group tree, but Roles & permissions remains a flat 11-role list; requested multi-level role hierarchy was not visible. |
| Part 3 `P3-10` geolocation | **Not certified** | Submitted a synthetic Meeting activity. No visible location prompt or location in its timeline entry; no mobile/browser-permission test was performed. Check stored activity and denied-permission behavior before closing. |
| Part 3 `P3-16` advanced automation | Partial, urgent reliability issue | Created/edited disabled rule #6; two-condition dry run exact. Automation #2 trigger/node edits and activation guards tested; node delete confirmed. Container lifecycle gaps QA-37; existing scheduler QA-02. |
| Part 3 `P3-17/P3-18` templates/Meta | Partial | Synthetic WhatsApp template create/edit/delete worked. Approval-required content submit/send-back/resubmit, self-approval rejection and independent Admin approval worked. Meta console has default field mapping, deliveries and paused campaign creation, but account/page/permission management and notification/report controls requested in `P3-18` were not visible. |
| Part 3 `P3-31` Launcher outside click | **Open** | QA-18. |
| Part 3 `P3-33/P3-34/P3-41` lead import | Present, partial verification | Four-step Import leads page and sample control surfaced. Separate Data Tools CSV path tested: three rows previewed 1 valid, 1 duplicate, 1 invalid; commit created #44 and skipped the other two. That route does not update duplicates. The four-step upload/mapping route and updated-count behavior remain untested. |
| Part 3 `P3-36/P3-37/P3-38/P3-39` lead list | Mixed | QA-15; column chooser and bulk count validation observed, pagination and most sorting absent. |
| Part 3 `P3-42/P3-43` supervisor | Partial | Sales Supervisor changed #42 New→Contacted; reload and actor history verified. Sales RM stage/owner controls denied. Import/export masking and hierarchy approvals still need dedicated tests. |
| Part 4 case confirmation, internal note, tiles | **Open** | QA-05 and QA-07. Conversation overflow at >50 and Run SLA Sweep were not exercised. |
| Part 4 Sales RM owner | **Open, severe** | QA-01. |
| Part 4 product handoff and call overlay | **Open** | QA-10 and QA-21. |
| Part 4 pipeline filters / date format | **Open** | QA-14 and QA-17. |

Part 3 `P3-19` LAPPS equivalent and `P3-21` internal messaging were not certified in this browser pass. Treat “not visible” as a discovery item, not proof that backend work is absent. Similarly, Round 1 login alignment/dark contrast, all Part 2 chart types, Part 3 AI summary action buttons, 50-plus case messages, call recording/transcription, real telephony, and every button in 28 Setup screens still require targeted passes.

## 5. Role and module coverage ledger

The demo exposes **11 internal roles plus the separately authenticated Partner role**: 12 role categories. Both Associate and Remisier portal personas were signed in. Public DKYC is a separate customer surface, not an extra internal role. The audit used the visible demo identities; it did not create new users or credentials.

| Role / surface | Actually checked | Remaining acceptance work |
|---|---|---|
| Superadmin | Core CRUD, recycle/restore, product states, AI disposition writes, case reply/internal note/resolve, list/campaign/rules/automation/content, Setup fields/outcomes/calendar/product creation, monitoring, full simulated DKYC readback | Product creation blocked; dangerous activation path QA-33; API and infrastructure gates |
| Admin (Kavita) | Independent content approval; approved collateral visibility; campaign duplicate/opt-out suppression; purpose-aware email, SMS/WhatsApp sends; custom-field retirement; API tab refusal | User/role/security mutations, exports, provider settings; QA-39/40/41 |
| Sales RM (Priya) | Lead create/visibility failure; restored own record; edit restrictions; MF Product RM request and task readback | Owner precedence QA-01; edit masking QA-36; mobile and approved stage-request path |
| Sales Supervisor (Anil) | Own team lead #42 edit, New→Contacted persisted and actor history; owner remained Priya | Import/export masking, hierarchy/group boundary, approval/reassignment combinations |
| Caller (Sneha) | Other Caller-owned #42 denied; own #40 masked/read-only; MF Exploring write succeeded, Warm control refused | Full role-specific AI disposition and hand-to-Sales RM chain; direct API negative tests |
| Dealer (Vikram) | Temporarily assigned synthetic #44 visible; contacts remained masked/disabled in edit; allowed City saved/reloaded; stage/owner denied; Start engaging had no result | QA-42; full call/disposition, Warm denial and Sales RM handoff |
| Product RM (Deepak, MF) | Received #42 High task and named handoff notification; masked/read-only lead detail; owner remained Priya | Exact 60s timer; other-product direct API denial; complete product-action workflow |
| Product Supervisor (Meera) | KYC health tabs; listed #43 refused at detail; Bonanza journey opens with Force complete controls | QA-43; reason-required synthetic override/write/audit and reassignment (disabled in UI) |
| Partner RM (Jimish) | Created own prospect #10; first onboarding step saved; incomplete elevation refused; simulated training completion saved | Eight-step evidence and separate Admin approval; full activation/sign-in, commission decisions and payouts |
| Customer Care (Fatima) | Created #9; status/escalate/resolve; partner-case assignment mismatch; case queue/tile/Copilot scope; replies/internal note on AI case also tested as Superadmin | SLA sweep, reopen via portal reply, merge, >50 messages, CSAT submission and scope/API tests |
| Marketing Manager (Tanvi) | List creation/read; lead/action scope, PII/list-export mismatch; campaign/template/library views; disabled Home shortcut | Role-specific campaign write/send not certified (send was Superadmin/Admin); reports/export policy; QA-06/19 |
| Partner Portal — Associate (Girish) | Overview, clients/detail, earnings, products, onboarding/support/training detail; referral #41 and support #10 created | Full partner lifecycle, reply/reopen, documents, commission calculations; API isolation |
| Partner Portal — Remisier (Lakshmi) | Sign-in, Overview and distinct two-client list; Associate’s synthetic referral absent | Other tab writes, model-specific permissions, other two published models and Authorised Person |
| Public DKYC | Bigul Trading proof branches; mobile/email OTP negative tests; consent/proof guard; simulated files/camera; pause/reload; simulated Finish; internal #43 readback | Format failures QA-34; genuine upload/security, all product/nominee branches, timers/abandonment, mobile/resume expiry |

Operational pages opened: Home, Leads/detail, Pipeline, Clients, Lead Lists, Tasks, Calendar, KYC Console, Products, Market, Approvals, Cases, Client Master, Partners, My Team, Revenue, KRA, Incentives, Campaigns, Marketing Hub, Reports, Dashboards, Data Tools.

Setup pages opened: Users, Roles, Navigation, Sales groups, Masking, Targets, Objects & fields, Products, Automations, Rule builder, Capture forms, Call outcomes, SLA, Working calendars, KYC journeys, Templates, Content, Campaigns, Messaging, Integrations, Webhooks, Telephony, Meta, Audit, API & logs, Database, Promotion, Residency.

**An opened page is surface coverage.** It is not a pass of all its controls. Section 8 separates verified mutations from absent controls and untested capabilities; no “all features passed” claim is made.

## 6. Implementation sequence and acceptance checks for Claude Code

1. **Protect record boundaries and repair data:** reproduce QA-01 and QA-03 with the identified synthetic records; fix server-side owner precedence/category/assignee derivation and reject cross-business IDs. Audit previously misrouted cases and owner changes. Add tests for every lead creator and partner support for Bonanza and Bigul.
2. **Make background actions idempotent:** inspect the three enabled rule definitions, scheduled-run logs and produced tasks/notifications; introduce per-rule/per-record/per-transition idempotency and bounded retries; establish retention. Re-run the scheduler repeatedly and prove no duplicate task, notification, score or assignment effect. Reconcile existing duplicate records only after preserving audit evidence.
3. **Use one filter contract for metrics:** for every role, each tile's count and clicked list must use the same business, role, date, status and ownership predicates. Regression-test zero, mixed-status, and empty-period results; refresh the destination URL and verify the total remains exact.
4. **Complete user-confirmed case flows:** Save/Cancel for Manage changes; confirmation details for Escalate and Resolve; explicit internal-note help; clickable case summary cards; verify one synthetic ticket through response/resolution and daily counters.
5. **Repair validation and configuration:** resolve new-product creation/code/minimum, mandatory task links, empty-name errors, DKYC format/nominee rules, and approved campaign content. Test each at both UI and API boundaries, including import/automation writes. Repair AI-created case SLA initialization.
6. **Protect partner activation:** enforce onboarding/approval on every elevation route, add an explicit audited privileged override only if intended, and provide a revocation/retirement path. Revoke #9 test access after preserving evidence.
7. **Unify data presentation:** apply Marketing’s clarified PII policy and edit-field masking consistently, resolve supported email tokens, dates, counts, stale list refresh, product/account status labels, timeline actor and refusal/loading states. Run role-based view/export/API tests.
8. **Finish requested capabilities in scoped increments:** custom reports/dashboards, connector setup, Meta console, role hierarchy, mobile geolocation and in-call experience. Use the original item IDs above when reporting completion; do not close an item based only on a visible button.
9. **Certify the BRD pilot gates:** provide implementation evidence and automated tests for credential storage, session expiry/revocation, API authorisation, partner scoping, KYC document encryption/retention, consent and DND, India residency, pilot database choice, response time and availability. Treat simulator-only results as development evidence.

### Minimum test evidence to attach to each fix

- A before/after screen or short recording with role, business, URL, local date/time and record ID.
- The exact list count and filter/query for a clicked metric.
- The audit event and linked task/notification/case ID for a background effect, including repeat-run evidence.
- A role/business matrix covering allowed, denied, masked and exported values at both UI and API layers.
- A note of seeded/test data and cleanup steps so the environment remains trustworthy.

## 7. Decisions and remaining verification

- **Already resolved by owner:** Marketing Manager may view unmasked PII. Implement consistently; keep export permission a separate explicit decision.
- **Needs owner answer:** May a Bonanza partner refer Bigul products, and may Bonanza-branded DKYC open Bigul accounts? If yes, the interface must clearly identify the business and route the correct product/account journey. If no, filter the relevant product catalog by business. The Bonanza Equity pitch mentioning the Bigul flat plan requires copy review either way.
- **Needs product definition:** What constitutes `Won` lead stage, `Trading` partner-client status, `Active` product card, issued UCC, accrued commission and paid commission? Current screens conflate some of these.
- **Needs environment proof:** The integrations are simulated, and the UI explicitly says current environment is development. Real CUBE/Smartping/email/Meta/DKYC callbacks, consent/DND, data residency claims, mobile geolocation, performance at 100k leads, and UAT→Production rollback remain outside this pass. Do not infer readiness from simulator success.

**Retest gate:** Claude Code should return per-ID status (`fixed`, `partly fixed`, `not started`, or `needs decision`) with evidence against this document and earlier feedback IDs. Prioritize QA-01/02/03/33, then QA-28/30/32/34/36, and rerun the linked reproduction paths after deployment.


## 8. Create, edit, delete and response ledger

**PASS** means this specific operation and visible result were verified. **FAIL** means a reproduced defect. **ABSENT** means no applicable control was found on the inspected UI; it is not a claim that no backend exists. **UNTESTED** is not a pass. All writes below use synthetic data.

| Module / tab | Create / submit | Edit / change | Delete / retire / recovery | Recorded response / result |
|---|---|---|---|---|
| Leads | #40 and #42 Sales RM; #41 portal; #43 DKYC; #44 CSV | #42 name/city/risk/owner; supervisor stage; #44 Dealer City | #42 exact-name soft delete, Recycle bin Restore | Create scope FAIL QA-01; valid edits PASS; empty name FAIL QA-26; delete persisted but UX QA-27; restored related data PASS |
| Lead Products | Existing slots automatically present | MF state transitions on #42; Caller #40 Exploring | Card deletion not offered / retirement policy not certified | #42 score 10→13→16 and activities; Caller Warm refused; Dealer engagement FAIL QA-42 |
| Lead Details / custom fields | Optional synthetic lead Text field | Label changed; synthetic value on #42 saved | Active unchecked; retired, history retained | Field propagated to Details/Edit; later hidden from active layout |
| Notes (lead/partner) | Synthetic lead note and #9 partner note | No editor found | No delete found | Creation persisted; immutable-history/correction policy needs a decision |
| Lead Tasks / Tasks | Linked task on #42; AI task; Product RM task; main-page unlinked task | Completion checkbox worked | No title/due/assignee editor or cancel/delete found | Mandatory link FAIL QA-08; completion PASS; count label QA-20 |
| Cases / Tickets | #9 Care, #10 portal, #11 AI | Status, priority/escalation, public reply and internal note; Resolve | No case/history delete or subject editor found | Writes PASS; review flow QA-07; #10 routing QA-03; #11 SLA QA-28 |
| Activity / call / meeting | Synthetic meeting #40; call disposition #42 | Editable AI review before Confirm; generated task title edited | No post-save correction/delete found | Confirm created linked activity/task/case +3 score; real call/media/timing UNTESTED |
| Email | Supported-token simulated email on #42 | Body/purpose; approved collateral selector | Sent-history deletion not offered | “Recorded and logged… SMTP credentials are not configured”; literal tokens QA-11 |
| SMS / WhatsApp | Service messages to synthetic #42 | Freeform bodies; purpose controls | History deletion not offered | SMS sent / WhatsApp sent; body persisted; timeline actor QA-39; providers simulated |
| Lead Lists | Refreshable #3; static #4 | Member import by mobile; one-member bulk City update | No rename/archive/delete/remove-member found | Import 1 added / 1 missing; stale until reload QA-29; lifecycle QA-37 |
| Campaigns | #3 Draft; Test on me; Send; duplicate #4 | No draft editor found | No draft delete found | #3 Sent 1 without template FAIL QA-30; #4 opt-out skipped / Sent 0 PASS |
| Marketing Hub / content | Library and draft Link content | Submit, send back with required reason, resubmit, independent approval | No edit/version/withdraw/archive/delete found | Author approval refused; Admin approved; approved collateral appears in Email PASS |
| Templates | WhatsApp Utility `qa_crud_20260930` | Body saved and read back | Test template Delete removed row | Create/Edit/Delete PASS; no confirm/success feedback QA-37 |
| Rule builder | Disabled #6, two conditions | Name and conditions edited; dry run | No delete found; kept disabled | “2 of 42” matching #40/#42; nothing sent; existing repeated scheduler QA-02 |
| Automation builder | Draft #2, lead-updated trigger, terminal step | Watch City/name filter and step labels/reason | Step delete after explicit confirmation; draft container retained | Missing watch/steps blocks Activate; valid step enables it; never activated |
| Setup Products | Attempted QA CRUD Product 20261001 | Blocked because create failed | No new product available for safe retire/backfill test | ₹500 invalid step QA-31; valid ₹1,000 Save “Code and name are required” QA-32 |
| Capture forms / interaction fields | Optional Text `qa_call_marker_20261001` | Label edited; removed from Call and saved order | Globally retired; reopened Active unchecked | Call removal persisted; other form membership existed before global retirement |
| Call outcomes | `QA_CALL_20261001`, Call/Connected | Label/hint changed; zero score/no action | Retire; verified retired row | Create/Edit/Retire PASS; historical references retained |
| Working calendars | Exchange-closed day 2099-12-30 | No holiday editor found | Remove | Created then removed PASS; seeded holidays unchanged |
| Calendar diary | Derived Outlook meetings visible | Day filter persisted after reload | No event CRUD control found | Read-only simulated diary; no Teams Join tested |
| Partners — Superadmin | #9 prospect; note | Direct elevation unexpectedly activates at 0/8 | No visible revoke/deactivate/delete | FAIL QA-33; test access cleanup required |
| Partners — Partner RM | #10 own prospect | First step → QUALIFYING 1/8; one simulated training → Completed/85 | No detail editor/delete found | Incomplete elevation refused “7 onboarding step(s) still incomplete” PASS |
| Partner Portal | Associate referral #41 and support #10 | Separate client/detail/training views | No portal record delete tested | Attribution PASS; support route FAIL QA-03; Remisier UI isolation PASS, API isolation UNTESTED |
| Public DKYC / internal KYC | Synthetic Bigul Trading journey #14 linked #43 | 16 steps with proof branches, pause/resume and simulated Finish | Journey delete not offered; supervisor override write UNTESTED | OTP/consent/proof guards PASS; formats FAIL QA-34; summary QA-35; supervisor list/detail QA-43 |
| SLA / journey configuration | No create controls found | Read-only policies/category/journey definitions | No retire/delete controls found | Capability gap QA-37; timers/sweeps/override UNTESTED |
| Clients / Client Master | Trading/UCC-derived lists; no independent synthetic live account opened | No safe independent CRUD path certified | Not exercised | Empty live-account definition QA-09; imports/sync reconciliation UNTESTED |
| Pipeline / Revenue | Derived from product interests | Existing product filter viewed | No independent entity deletion | Pipeline populated; single product selection QA-14; attribution/calculation edge cases UNTESTED |
| Reports / Dashboards | Predefined reports/charts | Date presets/window controls surfaced | Custom create/edit/delete absent | Requested builder capability gap QA-16; every chart/export UNTESTED |
| Approvals | Content approval tested in content UI; normal partner request refused before queue | Admin approval and self-approval denial | No money/access approval completed | Full commission/exception/access approval and duplicate/reject/withdraw routes UNTESTED |
| Users / roles / groups / masking / targets | Configuration surfaces read | No new user/credential/role grant made | No user/session deletion made | Security-changing actions need supervised action-time review; no server-wide permission certification |
| My Team / KRA / incentives | Read/derived performance views | No independent synthetic target/incentive write certified | Not exercised | Surface coverage; actual formula, hierarchy and payouts UNTESTED |
| Integrations / telephony / webhooks / Meta / messaging | Configuration/status surfaces read | No live provider credentials changed | No provider credential revoke tested | Twelve adapter statuses surfaced; callbacks, failure/retry and provider approval UNTESTED |
| Audit / API logs / database / residency | Existing entries/filtering | API filters verified | No purge/retention sweep/database delete | Actor PASS; counters QA-40; 403 UX QA-41; HTTP guidance QA-12; residency wording QA-23 |
| Promotion / UAT | Package/preview/apply surfaces inspected | No deployment promoted | Rollback not exercised | Separate environments and deployment rollback remain UNTESTED |

### DKYC step and validation record

The chosen Bigul product starts with a 14-step fallback. Annual income/segment choices added Income proof, and the failed penny-drop path added Bank proof, reaching 16. This is one branching journey, not certification of every product journey.

| Stage | Probe / observed result |
|---|---|
| Mobile + OTP | Starting mobile re-requested; 123 accepted to OTP. 000000 refused (“That code is not correct. Please try again.”); visible demo OTP accepted. |
| Email + OTP | Invalid email blocked by browser validation; example.invalid synthetic email and demo OTP proceeded. |
| PAN + DOB | BAD and synthetic adult DOB accepted; no format guard observed. |
| DigiLocker consent | Unchecked consent blocked (“Please complete: I consent to fetch my Aadhaar KYC from DigiLocker”); checked simulation proceeded. |
| Personal/financial | Synthetic address/parent/city/state; PIN 000000 accepted; income selection added proof branch. |
| Bank / Bank proof | Account 123 and IFSC BAD accepted; penny-drop failure introduced proof. Missing proof blocked; Choose file produced simulated `document-uploaded.pdf`. |
| Nominee | Synthetic nominee at 150% accepted; next screen displayed Segments. The screenshot shows advancement, not the originally entered percentage. |
| Segments / Income proof | F&O/depository/plan selections; required Income proof blocked if missing; simulated proof token proceeded. |
| Selfie / signature | Controls produced simulated image/file tokens; no actual camera capture, quality, MIME/size or malware test certified. |
| eSign / Finish | Pause/reload preserved progress; user specifically confirmed Finish simulation; demo OTP completed journey; “Onboarding successful,” 16 steps, about 5 minutes. |
| Internal readback | #43 KYC Complete and Active Trading card; invalid mobile/PAN remained saved; headline active-card mismatch QA-35. |

## 9. Test-data registry and cleanup

Keep reproduction evidence before cleanup. Restrict cleanup to the listed synthetic records; do not bulk-delete seeded/customer records. Normal recovery and retained history are part of the expected lifecycle.

| Synthetic record / identifier | State at end of audit | Cleanup / reproduction note |
|---|---|---|
| [Lead #40](https://labs.tinyepic.in/ai-crm/leads/40) QA Audit Lead 20260930 | Caller Sneha; MF Exploring; Equity previously Warm; synthetic meeting/task | Owner/routing and Caller boundary evidence; no real meeting occurred |
| [Lead #41](https://labs.tinyepic.in/ai-crm/leads/41) QA Partner Referral 20260930 | Bonanza partner-attributed referral | Preserve for portal attribution/isolation/routing |
| [Lead #42](https://labs.tinyepic.in/ai-crm/leads/42) QA CRUD Lead Edited 20260930 | Restored, owner Priya, stage Contacted, MF Warm, marketing opt-out restored No | Contains synthetic note/tasks/case/messages; lead field is retired but historical value retained |
| [Lead #43](https://labs.tinyepic.in/ai-crm/leads/43) QA Synthetic Account Holder | BIGUL, owner Rhea; KYC Complete; deliberately invalid mobile123/PANBAD; simulated Active card | No real account/legal agreement. Preserve for validation/scope defect; do not “correct” before reproduction |
| [Lead #44](https://labs.tinyepic.in/ai-crm/leads/44) QA Import Lead 20261001 | Owner restored Rohit; City QA Dealer Edited City; source Import | Dealer assignment/allowed edit audit retained; failed engagement left MF Not engaged |
| [Case #9](https://labs.tinyepic.in/ai-crm/tickets/9) BNZ-00009 | Resolved; simulated CSAT | Case review/metrics reproduction |
| [Case #10](https://labs.tinyepic.in/ai-crm/tickets/10) BNZ-00010 | Open, partner Girish, Divya assignee, Uncategorised | Cross-business support defect; preserve routing audit |
| [Case #11](https://labs.tinyepic.in/ai-crm/tickets/11) BNZ-00011 | Resolved High AI compliance case; no due values observed on creation | Linked #42, reply/internal note and simulated CSAT; preserve initial SLA evidence |
| [List #3](https://labs.tinyepic.in/ai-crm/lists/3) QA Audit List 20260930 | Refreshable synthetic list | No archive/delete UI found |
| [List #4](https://labs.tinyepic.in/ai-crm/lists/4) QA CRUD Static List 20260930 | One member #42 | Do not use “Delete every member” as list cleanup; that deletes leads |
| Campaign #3 and #4 | QA CRUD Campaign 20260930 and copy; Sent1 and Sent0 | No edit/delete found; keep synthetic activity/consent evidence |
| QA CRUD Library / QA CRUD Content 20260930 | Link content approved by independent Admin; example.invalid URL | No withdraw/archive/delete UI found; remove from active collateral through a supported lifecycle after reproduction |
| [Partner #9](https://labs.tinyepic.in/ai-crm/partners/9) QA CRUD Partner 20261001 / BNZ-P0009 | **ACTIVE / Portal access / 0 of 8 steps** | **Priority cleanup: revoke synthetic portal access and sessions.** No visible revoke found; no credential was used or included in handoff |
| [Partner #10](https://labs.tinyepic.in/ai-crm/partners/10) QA Partner RM Prospect 20261001 | QUALIFYING1/8; owner Jimish; one simulated training complete | Elevation refused; no new portal access. Normal retire/delete UI absent |
| Rule #6 QA CRUD Rule Edited 20260930 | Disabled; Website AND age0; Star action | Never activated; remove through supported config lifecycle |
| [Automation #2](https://labs.tinyepic.in/ai-crm/setup/automations/2) QA CRUD draft | Inactive draft; test terminal step deleted | Trigger watch/filter retained; no container delete visible |
| Lead field `qa_audit_marker_20261001` | Retired | Value/history retained intentionally |
| Interaction field `qa_call_marker_20261001` | Retired globally; Call layout removal saved | Reopened editor verified Active unchecked; historical definition retained |
| Outcome `QA_CALL_20261001` | Retired | Retention/reactivation is supported |
| Template `qa_crud_20260930` | **Deleted** | Verified row removed; no seeded template changed |
| Holiday QA Synthetic Holiday 20261001 / 2099-12-30 | **Removed** | Verified calendar table; seeded dates unchanged |
| QA CRUD Product 20261001 | **Not created** | Save blocked, so no product cleanup required |
| Synthetic tasks/notes/messages | Linked IDs/titles in record history; main unlinked task remains | No ordinary task/history deletion controls found. Do not purge logs/database to remove these |

The developer should provide a scoped, auditable cleanup mechanism for retained test entities that the UI cannot retire. Preview exact IDs and dependencies before cleanup; retain the evidence needed to retest fixes.

## 10. Screenshot evidence and highlighted problem statements

Original images are preserved. **Bold problem captions identify what to inspect**, and the accompanying HTML gallery highlights those statements in red alongside the screenshot. A filename is an evidence reference, not proof of an invisible value or a backend cause. Where a screenshot shows the next screen rather than the submitted input, the caption says so.

The screenshots contain development/demo data and clearly marked synthetic records. Some DKYC screenshots show the synthetic resume link; treat the evidence as an internal handoff. No newly issued partner password or API secret is included.


### QA-01

**Problem statement:** QA-01 · Before submit: Sales RM selected Assign to me.

![QA-01 · Before submit: Sales RM selected Assign to me.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA01-sales-create-assign-to-me.jpg>)

### QA-01

**Problem statement:** QA-01 · After successful creation: the lead is outside the creator’s visibility scope.

![QA-01 · After successful creation: the lead is outside the creator’s visibility scope.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA01-sales-created-denied.jpg>)

### QA-01

**Problem statement:** QA-01 · Audit identifies the routing rule that replaced the owner.

![QA-01 · Audit identifies the routing rule that replaced the owner.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA01-audit-routing-cause.jpg>)

### QA-02

**Problem statement:** QA-02 · Scheduled firing counters remain high and increase; use task/audit evidence to diagnose side effects.

![QA-02 · Scheduled firing counters remain high and increase; use task/audit evidence to diagnose side effects.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA02-rule-counters-retested.jpg>)

### QA-03

**Problem statement:** QA-03 · Bonanza portal case #10 is Uncategorised and assigned to Divya; the user record identifies Divya as Bigul Care.

![QA-03 · Bonanza portal case #10 is Uncategorised and assigned to Divya; the user record identifies Divya as Bigul Care.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA03-partner-case-cross-business-assignee.jpg>)

### QA-04

**Problem statement:** QA-04 · 1 October tile counts two new leads. Compare the next screenshot.

![QA-04 · 1 October tile counts two new leads. Compare the next screenshot.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA04-date-tile-two-leads.jpg>)

### QA-04 / QA-15

**Problem statement:** QA-04 / QA-15 · The tile’s date URL opens 44 leads, including older dates.

![QA-04 / QA-15 · The tile’s date URL opens 44 leads, including older dates.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA04-date-drill-through-44-leads.jpg>)

### QA-05

**Problem statement:** QA-05 · Care summary and assigned/all-open queue use different scopes.

![QA-05 · Care summary and assigned/all-open queue use different scopes.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA05-care-summary-before.jpg>)

### QA-07

**Problem statement:** QA-07 · Manage status change is already saved without a Save/Cancel review.

![QA-07 · Manage status change is already saved without a Save/Cancel review.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA07-case-edit-autosaved.jpg>)

### QA-08

**Problem statement:** QA-08 · Corrected result: the main Tasks page created an unlinked task.

![QA-08 · Corrected result: the main Tasks page created an unlinked task.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA08-unlinked-task-submit-response.jpg>)

### QA-10

**Problem statement:** QA-10 · Translucent call overlay and unclear End call control.

![QA-10 · Translucent call overlay and unclear End call control.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA10-call-overlay.jpg>)

### QA-11

**Problem statement:** QA-11 · Reloaded activity retains offered owner/city/mobile/email placeholders.

![QA-11 · Reloaded activity retains offered owner/city/mobile/email placeholders.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA11-supported-merge-tokens-unresolved.jpg>)

### QA-12

**Problem statement:** QA-12 · HTTP base URL is advertised alongside API secret headers.

![QA-12 · HTTP base URL is advertised alongside API secret headers.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA12-api-http-secret-guidance.jpg>)

### QA-14

**Problem statement:** QA-14 · Pipeline populated; product control remains single-select.

![QA-14 · Pipeline populated; product control remains single-select.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA14-pipeline-single-product-filter.jpg>)

### QA-16

**Problem statement:** QA-16 · Predefined reports present; requested custom builder absent from this surface.

![QA-16 · Predefined reports present; requested custom builder absent from this surface.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA16-predefined-reports-no-builder.jpg>)

### QA-23

**Problem statement:** QA-23 · Offline local mode and outside-India/Sent labels need consistent explanation.

![QA-23 · Offline local mode and outside-India/Sent labels need consistent explanation.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA23-local-provider-versus-egress-labels.jpg>)

### QA-26

**Problem statement:** QA-26 · Empty Name produces a raw database error. Both are visible in this final screenshot.

![QA-26 · Empty Name produces a raw database error. Both are visible in this final screenshot.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA26-empty-name-error-dialog-top.jpg>)

### Delete guard PASS

**Verified result:** Delete guard PASS · Wrong name blocks deletion; exact-name confirmation is required.

![Delete guard PASS · Wrong name blocks deletion; exact-name confirmation is required.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/CRUD-lead-delete-confirmation.jpg>)

### QA-27

**Problem statement:** QA-27 · Successful delete leaves Lead not found at the deleted detail URL.

![QA-27 · Successful delete leaves Lead not found at the deleted detail URL.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/CRUD-lead-delete-result.jpg>)

### Recovery PASS

**Verified result:** Recovery PASS · Deleted synthetic lead appears in Recycle bin.

![Recovery PASS · Deleted synthetic lead appears in Recycle bin.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/CRUD-lead-in-recycle-bin.jpg>)

### Recovery PASS

**Verified result:** Recovery PASS · Restore recovers the synthetic record and related tabs.

![Recovery PASS · Restore recovers the synthetic record and related tabs.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/CRUD-lead-restored.jpg>)

### QA-28

**Problem statement:** QA-28 · AI High compliance case has no category or SLA due values.

![QA-28 · AI High compliance case has no category or SLA due values.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA28-compliance-case-no-sla.jpg>)

### QA-29

**Problem statement:** QA-29 · Successful import toast contradicts the empty/zero-member list until reload.

![QA-29 · Successful import toast contradicts the empty/zero-member list until reload.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA29-list-stale-after-import.jpg>)

### QA-30

**Problem statement:** QA-30 · Campaign creation is allowed with no approved template chosen.

![QA-30 · Campaign creation is allowed with no approved template chosen.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA30-campaign-create-without-template.jpg>)

### QA-30

**Problem statement:** QA-30 · The synthetic campaign becomes Sent without a chosen template.

![QA-30 · The synthetic campaign becomes Sent without a chosen template.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA30-campaign-send-without-template.jpg>)

### QA-31

**Problem statement:** QA-31 · Product minimum step rejects the catalog’s ₹500-style amount.

![QA-31 · Product minimum step rejects the catalog’s ₹500-style amount.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA31-product-minimum-step-validation.jpg>)

### QA-32

**Problem statement:** QA-32 · Form promises a generated code and has no Code input. This frame does not show the covered error.

![QA-32 · Form promises a generated code and has no Code input. This frame does not show the covered error.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA32-product-create-code-required.jpg>)

### QA-32

**Problem statement:** QA-32 · After closing the obstructing modal, the actual Code and name are required banner is visible.

![QA-32 · After closing the obstructing modal, the actual Code and name are required banner is visible.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA32-product-error-after-closing-modal.jpg>)

### QA-33

**Problem statement:** QA-33 · Synthetic partner is Active with Portal access while onboarding remains 0/8.

![QA-33 · Synthetic partner is Active with Portal access while onboarding remains 0/8.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA33-partner-active-zero-onboarding.jpg>)

### Partner RM guard PASS

**Verified result:** Partner RM guard PASS · Normal request refuses seven incomplete steps; no access issued.

![Partner RM guard PASS · Normal request refuses seven incomplete steps; no access issued.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/PASS-partner-rm-elevation-incomplete-denied.jpg>)

### QA-34

**Problem statement:** QA-34 · Complete simulated KYC retained invalid mobile/PAN values in the internal record.

![QA-34 · Complete simulated KYC retained invalid mobile/PAN values in the internal record.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA34-kyc-invalid-data-persisted.jpg>)

### DKYC Finish PASS in simulator

**Verified result:** DKYC Finish PASS in simulator · Final success reached after specific user confirmation.

![DKYC Finish PASS in simulator · Final success reached after specific user confirmation.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/CRUD-kyc-completed.jpg>)

### QA-35

**Problem statement:** QA-35 · Active product card conflicts with no active products summary.

![QA-35 · Active product card conflicts with no active products summary.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA35-active-card-no-active-products.jpg>)

### QA-36

**Problem statement:** QA-36 · Sales edit reveals full contact values while the read view is masked.

![QA-36 · Sales edit reveals full contact values while the read view is masked.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA36-sales-edit-unmasks-contact.jpg>)

### Dealer masking PASS

**Verified result:** Dealer masking PASS · Contact fields stay masked and disabled; allowed City edit works.

![Dealer masking PASS · Contact fields stay masked and disabled; allowed City edit works.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/PASS-dealer-edit-masked-fields.jpg>)

### Content approval PASS

**Verified result:** Content approval PASS · Author cannot approve their own item.

![Content approval PASS · Author cannot approve their own item.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/PASS-content-self-approval-rejected.jpg>)

### Content approval PASS

**Verified result:** Content approval PASS · A different Admin approves the item.

![Content approval PASS · A different Admin approves the item.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/PASS-content-independent-approval.jpg>)

### Consent PASS

**Verified result:** Consent PASS · Opted-out synthetic audience member is skipped; sent count is zero.

![Consent PASS · Opted-out synthetic audience member is skipped; sent count is zero.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/PASS-campaign-opt-out-skipped.jpg>)

### QA-38

**Problem statement:** QA-38 · Email menu action is disabled although header composer permits Service purpose.

![QA-38 · Email menu action is disabled although header composer permits Service purpose.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA38-service-email-action-disabled.jpg>)

### QA-39

**Problem statement:** QA-39 · Manual service message bodies persist, but timeline actor is system.

![QA-39 · Manual service message bodies persist, but timeline actor is system.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/PASS-sms-whatsapp-activities.jpg>)

### QA-39 limit

**Verified result:** QA-39 limit · API audit correctly identifies Kavita; server actor audit exists.

![QA-39 limit · API audit correctly identifies Kavita; server actor audit exists.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA39-message-actor-present-in-api-log.jpg>)

### QA-40

**Problem statement:** QA-40 · Zero entry counters contradict a populated audit table.

![QA-40 · Zero entry counters contradict a populated audit table.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA40-log-counts-zero-with-entries.jpg>)

### QA-41

**Problem statement:** QA-41 · Refused Admin API tab remains at Loading.

![QA-41 · Refused Admin API tab remains at Loading.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA41-admin-api-access-stuck-loading.jpg>)

### QA-41

**Problem statement:** QA-41 · Log records Admin API credentials request as 403.

![QA-41 · Log records Admin API credentials request as 403.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA41-admin-api-denial-log.jpg>)

### QA-42

**Problem statement:** QA-42 · Enabled Dealer engagement action left the synthetic card unchanged; root cause unconfirmed.

![QA-42 · Enabled Dealer engagement action left the synthetic card unchanged; root cause unconfirmed.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA42-dealer-start-engaging-no-change.jpg>)

### QA-43

**Problem statement:** QA-43 · Product Supervisor’s listed journey detail is refused with 403.

![QA-43 · Product Supervisor’s listed journey detail is refused with 403.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/QA43-kyc-listed-journey-forbidden-log.jpg>)

### Import PASS

**Verified result:** Import PASS · Preview separates a valid row, duplicate and invalid mobile.

![Import PASS · Preview separates a valid row, duplicate and invalid mobile.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/PASS-import-preview-valid-duplicate-invalid.jpg>)

### Import PASS

**Verified result:** Import PASS · Commit creates one and skips the duplicate/invalid rows.

![Import PASS · Commit creates one and skips the duplicate/invalid rows.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/PASS-import-result.jpg>)

### Rule dry-run PASS

**Verified result:** Rule dry-run PASS · Two conditions match only the named synthetic leads; nothing sent.

![Rule dry-run PASS · Two conditions match only the named synthetic leads; nothing sent.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/CRUD-rule-dry-run-result.jpg>)

### Automation step deletion

**Verified result:** Automation step deletion · Review explicitly explains run-history consequences and disabling alternative.

![Automation step deletion · Review explicitly explains run-history consequences and disabling alternative.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/CRUD-automation-card-delete-confirm.jpg>)

### Cleanup PASS

**Verified result:** Cleanup PASS · Test interaction field Active is unchecked after saved retirement.

![Cleanup PASS · Test interaction field Active is unchecked after saved retirement.](<C:/Users/Admin/OneDrive - Bonanza Group/^Bonanza AI CRM/QA_Evidence_2026-09-30/CRUD-capture-field-retired.jpg>)

## 11. Claude Code completion contract

Return a table with every QA ID, original feedback ID where applicable, change made, automated evidence, browser evidence, and remaining decision. Do not close an item on a visible control alone. Reproduce using the stated role and synthetic ID, confirm persisted results, and retest denial paths. Respect the owner’s Marketing PII decision and do not infer cross-brand product scope. Start with partner-access cleanup and the pilot-blocking workflows.

