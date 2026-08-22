# LeadSquared → New CRM: System of Record Reference

**Tenant audited:** Bonanza Portfolio Limited / "Bigul" brand (retail broking & trading, India)
**LeadSquared Account No:** 57437 · **Region:** India (`in21`)
**Audited by:** Claude, as Administrator (Ritesh Thakur), 21 Aug 2026
**Purpose:** Ground-truth reference for designing and building a replacement CRM.

---

## HOW TO USE THIS DOCUMENT

This is a **requirements-bearing audit**, not a feature list. Every section has
two halves:

1. **WHAT EXISTS** — verified facts read directly from the live tenant.
   Field names, codes, counts and configuration are exact. Nothing is assumed.
2. **WHAT IT IMPLIES** — the design conclusion for the new CRM.

Where a number is given (e.g. "14,140,741 automation triggers", "4,810 lists"),
it was read from the instance and is real. Treat those as the load-bearing
evidence; they are what distinguishes this from generic CRM advice.

**Scale context for every decision below:**

| Metric | Value |
|---|---|
| Leads | **495,118** |
| Lead fields | **338** (49 system, 289 custom) |
| Lead stages | **32** |
| Opportunity types (pipelines) | **35** |
| Activity types | **54** |
| Published automations | **51** |
| Lists | **4,810** |
| Smart Views | 14 |
| Forms | 14 · **Processes** 10 · **LAPPS** 15 |
| Active users | 83 of 132 licensed |
| Teams | 16 · **Sales Groups** 9 · **Roles** 4 · **Permission Templates** 12+ |
| Task types | 2 To-Do + 2 Appointment |
| Marketplace connectors installed | 18 of 149 |

---

## PART 1 — THE TEN FINDINGS THAT SHOULD SHAPE THE BUILD

Ordered by leverage. If the new CRM gets only these ten right, it will be a
material improvement regardless of what else it does.

### 1. "Lead Stage" is four different concepts crushed into one enum
32 stages mix: KYC/onboarding step completion (CONTACT INFO SUBMITTED → PAN
SUBMITTED → DIGILOCKER/KRA → PERSONAL INFO → BANK INFO → SIGNATURE → SELFIE →
SEGMENT INFO → DOCUMENTS → ESIGN → APPLICATION VERIFIED → ACCOUNT OPENED),
customer lifecycle (PROSPECT / CUSTOMER / ACCOUNT CLOSED / REOPEN ACCOUNT),
disqualification reasons (NOT INTERESTED / RELEVANT - NOT INTERESTED /
INACTIVE (NO RESPONSE)), and a parallel partner journey (PARTNER ESIGN DONE /
PARTNER APPLICATION VERIFIED / ARN INFO SUBMITTED).

**Because a record can only hold one value**, the tenant compensated with dozens
of `mx_` fields re-encoding the same journey (`mx_KRA_status`,
`mx_Email_Verification`, `mx_Mobile_Verification`, `mx_DIY_Account_Opened`,
`mx_Ready_To_Trade`, `mx_First_Dropoff_Application_Status`, …).

→ **Split into orthogonal dimensions**: `lifecycle_stage` (small stable enum) +
an **Application/Onboarding child entity** (own status, per-step timestamps,
multiple per person: equity / MF / partner / reactivation) +
`disqualification_reason` (nullable, separate) + `party_roles` (a person can be
Customer AND Partner simultaneously — roles, not mutually-exclusive stages).
This single change eliminates a large share of the field sprawl.

### 2. "Opportunity" is being used as a generic work item — 35 pipelines
They are not 35 kinds of deal. They are four different entities:
- **Deals** (12): Bigul Customer, Bigul Partner, Product Demo, Global Investments, Mutual Fund, Quant Algo, …
- **Support cases** (7): C.S-Account Closure-Retention, C.S-Required Trading Assistance, C.S-Subscription Plans, C.S.-Bigul Algo Related, Dealer Support, Sales Support, IPO Support — no value, no close date, no win/loss
- **Segments/campaigns** (7): App Login But not Traded, Last Month And Not Traded, Brokerage is more than 100 but not Traded, Dormant., Cross Sale RRT - 15 Days, High Intent Trading-DIY Client — records land here by *rule match*, not human pursuit. **This corrupts every conversion metric in the business.**
- **Process instances** (4): Client Profiling, Client KYC Reactivation, Fund Collection, MF App

→ **Model four first-class entities**: `Deal`, `Case`, `Segment membership`
(computed, not a stored owned record), `ProcessInstance`. 35 pipelines collapse
to ~4 entity types with configurable subtypes — and the funnel becomes
trustworthy for the first time.

### 3. Two automations account for the majority of all execution — both are data-propagation
`Add Activity on Opportunity as per Lead` — **14,140,741 lifetime triggers**.
`Activity Score` — **8,023,974 triggers**.
The first copies activities from Lead to Opportunity. The second recomputes a score.

→ Neither should need to exist. **One shared timeline/interaction entity** that
both Lead and Deal reference removes the first. **Computed/materialised
projections** (score as a derived value, not a stamped field) removes the second.

### 4. Six automations exist purely to stamp timestamps
`Capture Created Date Field`, `Capture PAN Submitted Date`, `Capture MQL Date`,
`Capture 'First Intent' Field`, `Update RTT Date Field`, plus stage-entry stamps.
LeadSquared has no queryable field-change history, so every reportable date has
to be manufactured by automation into an `mx_` field.

→ **First-class field-change history and stage-entry/exit timestamps, built in
and queryable.** Removes ~6 automations and ~15 fields on day one.

### 5. Multiple automations write the same fields on the same trigger — undefined order
At least three "Lead Updated" automations (`Lead Update Automation 20-03-2026`,
`Lead Update Automation 9th March'26 - RTT Leads Excluded - Clone`,
`New Automation for RTT Leads - 12th August 2026`) fire on the same event over
overlapping populations. Execution order is neither guaranteed nor documented.
This is a **live race condition** in production today.

→ **Explicit rule priority/ordering, plus static conflict detection** ("these two
rules both write `X` on the same trigger"). Also: make "what writes to this field?"
a queryable question — today it is unanswerable, which is the root cause.

### 6. Free-text fields are being used as append-only interaction logs
Real value observed in `mx_Disposition_Notes_Remarks` on a live record:
`"verify | from submitted | no response call back | ringing | | | ringing |
issue in selfie | say do | say do | pitch done say do | lunch kr rahe hai ..."`
Multiple agents, multiple months, concatenated with `|` into one text field.
Unreportable, unsearchable, no attribution, no timestamps.

→ **Notes and outcomes belong on the interaction record**, never appended to the
parent. Non-negotiable.

### 7. Shared login accounts destroy attribution and auditability
`bigulcaller17`, `BigulCaller11`, `Bigulcallerdm81`, `Bigulcross.RM1`,
`Biguldealer5@…`, `Presales Common Id`. Activity cannot be traced to a human;
offboarding is impossible; per-agent performance data is meaningless.

→ **One identity per human, SSO-backed.** Where a shared inbox/queue is genuinely
needed, model it as a **Queue entity** that individually-authenticated users pull
from — never a shared credential.

### 8. 4,810 lists against 495,118 leads
Names like `All Active Clients 210826.csv`, `Pledge Rejected 210826.csv` reveal the
pattern: export to CSV → manipulate in Excel → re-import as a static list → never
delete. Date suffixes show it is a *daily* habit.

**The root cause is query power.** Advanced Search offers only a flat
"Any Criteria / All Criteria" across rows — you cannot express `(A AND B) OR (C AND D)`.
So people leave the product to do real segmentation.

→ **A proper nested query builder / saved live segments**, plus list ownership,
purpose and TTL with auto-archive. And: **interview the heavy CSV users
(Siddharth Sanghvi, Ketki Naik, Manjushri Bajwa) about what they do in Excel** —
that is a ready-made requirements backlog.

### 9. Zero dependent field relationships configured
`Settings > Dependent Lead Fields` is **empty**, despite the tenant having
`mx_Disposition` (Connected / Not Contactable / Other / Invalid data) with
`mx_Sub_Disposition`, plus `mx_Non_Contactable_Reason(s)`,
`mx_Not_Interested_Reason`, `mx_Objection_or_Concern_Category`/`_Handling`.
Nothing stops "Disposition = Connected" + "Sub-Disposition = Number not reachable".

→ **Cascading picklists enforced at the API layer, not just the UI** — a large
share of writes arrive via API/automation and would bypass UI-only validation.

### 10. No versioning anywhere → date-stamped names and "- Clone" everywhere
One capability, "Profiling / Trading / Reactivation", is spread across
**5 forms** (F46, F78, F93, F94, F98), **3 processes** (incl. two with identical
truncated names), and **2 activity types** (code 226 "…Form old", code 242 "…V4"),
with V3 and V4 both live and "old" still enabled. Automations are named
`…22April2025`, `…19Aug 2025V4-`, `… - Clone`.

→ **First-class versioning** for forms, processes, schemas and automations: one
logical artefact, many versions, explicit "current" pointer, documented migration
for in-flight records, and a diff view. Plus **retire-by-default** lifecycle.

---

## PART 2 — CORE DATA MODEL (as built today)

### 2.1 Entity types the platform recognises
LeadSquared exposes only two first-class custom entity types:
`{"1": Lead, "5": Opportunity}`. Everything else (Activity, Task, List,
Custom Field Set) hangs off those. **This constraint is the origin of most of
the mis-modelling in Part 1.**

### 2.2 Lead object — 338 fields

**Type distribution (exact):**

| Field type | System | Custom |
|---|---:|---:|
| Text | 22 | 113 |
| Dropdown | 5 | 82 |
| Number | 8 | 40 |
| Date | 5 | 35 |
| Multi-select | 0 | 7 |
| Email | 1 | 3 |
| Boolean | 4 | 2 |
| Phone | 2 | 2 |
| Website | 1 | 2 |
| Time | 0 | 1 |
| Custom Field Set | 0 | 3 |
| **Total** | **49** | **289** |

> Note the shape: **113 custom Text fields but only 2 custom Boolean fields.**
> Flags are being stored as free text (`mx_Equity_active`, `mx_App_Installed`,
> `mx_Fresher` are Dropdowns, not Booleans). Expect dirty values ("Yes"/"YES"/"Y"/"1")
> on migration. **Audit actual values before mapping — do not trust the type.**

**System/standard fields (49):**
`Mobile, ConversionReferrerURL, CreatedByName, CreatedOn, CurrentOptInStatus,
DoNotCall, DoNotEmail, DoNotSMS, DoNotTrack, EmailAddress, EngagementScore,
FacebookId, FirstName, GooglePlusId, GTalkId, LastName, Latitude, LeadAge,
ProspectAutoId, Origin, QualityScore01, Score, Source, ProspectStage, LinkedInId,
Longitude, MailingPreferences, Phone, ModifiedByName, ModifiedOn, Notes,
OptInDate, OptInDetails, OwnerId, OwnerIdName, LastOptInEmailSentDate, PhotoUrl,
LeadConversionDate, Groups, SkypeId, SourceCampaign, SourceContent,
SourceIPAddress, SourceMedium, SourceReferrerURL, TimeZone, Revenue, TwitterId,
Website, JobTitle`

Worth keeping in the new CRM: consent/compliance block (DoNotCall/Email/SMS/Track,
CurrentOptInStatus, OptInDate, OptInDetails, MailingPreferences) — this is
regulatory surface for a SEBI-regulated broker and must not be lost in migration.
Worth dropping: the social-handle block (GTalk, GooglePlus, Skype, Twitter,
LinkedIn, Facebook Id) — legacy-era, near-certainly empty.

**Custom fields by business domain** — full inventory in `lead-fields.md`.
Summary of the domains present:
Identity/KYC/Account · Address/Geography · Trading activity & product usage ·
Financial/revenue · RFM & scoring · BANT qualification · Call-centre dispositions ·
Ownership/assignment · Partner/channel · Marketing attribution ·
Product/subscription · App & digital engagement · Trading profile survey ·
CSAT/feedback · Zipteams (vendor) · Workflow dates.

### 2.3 Known technical debt in the field layer (carry NONE of this forward)

| Debt | Examples |
|---|---|
| **Duplicate/near-duplicate fields** | `mx_Disposition` vs `mx_Contacted_Disposition` vs `mx_Phone_call_disposition_2`; `mx_Sub_Disposition` vs `mx_Sub_disposition_2`; `mx_Income` vs `mx_Income_2` vs `mx_Annual_Income` vs `mx_Income_Category`; `mx_Objection_or_Concern_*` vs `mx_Objection_Concern_*`; `mx_Non_Contactable_Reason` vs `_Reasons`; `mx_Path_to_Conversion` vs `2`; `mx_How_Much_Margin_Pitched` vs `_2`; `mx_Intent_Justification` vs `_2` |
| **Repeating group flattened into columns** | `mx_Client_Code`, `_2`, `_3`, `_4`, `_5`, `_6` → this is a one-to-many. In the new CRM it is a child **Account** entity. |
| **Typos permanent in schema** | `mx_Subscription_End_dtae`, `mx_Presales_Initial_Margin_Commitmnt`, `mx1_RM_Code` (inconsistent prefix). LSQ schema names are immutable — errors are forever. |
| **Test fields in production** | `mx_test`, `mx_test_field`, `mx_or`, `mx_ASC` |
| **Vendor namespaces on the core record** | `mx_Zipteams_*` (7 fields), `mx_utm_af*`, `mx_Appsflyer_*` — integration data written onto Lead rather than an integration-owned sub-object |
| **Denormalised user data** | `mx_RM_Name`, `mx_RM_Email`, `mx_RM_Code_New`, `mx_RM_Mobile_Number`, `mx_Team_Leader`, `mx_Partner_Business_RM_*` — should be a lookup to a User/Employee entity |
| **Counters maintained by automation** | `mx_ConnectedAttempts`, `mx_Not_Connected_Attempts`, `mx_Number_of_Follow_Up`, `mx_SMS_Counter`, `mx_WhatsApp_Count`, `mx_Total_Connects_and_Attempts` — should be computed aggregates over the timeline |

→ **Governance requirement**: a field-creation gate (naming convention, duplicate
check, owner, retirement date, documented purpose) before any field goes live.
The absence of this gate is visibly what produced 289 custom fields.

### 2.4 Lead stages (32) — full list in `stages.md`
`PROSPECT · CONTACT INFO SUBMITTED · PAN SUBMITTED · DIGILOCKER /KRA COMPLETED ·
PERSONAL INFO SUBMITTED · BANK INFO SUBMITTED · SIGNATURE UPDATED · SELFIE UPDATED ·
SEGMENT INFO SUBMITTED · DOCUMENTS UPLOADED · ESIGN DONE · UNDER OBJECTION ·
APPLICATION RESUBMITTED · ESIGN PENDING · APPLICATION VERIFIED · DIGILOCKER COMPLETED ·
ACCOUNT OPENED · READY TO TRADE · REOPEN ACCOUNT · CUSTOMER · NOT INTERESTED ·
INACTIVE (NO RESPONSE) · RELEVANT - NOT INTERESTED · ACCOUNT CLOSED ·
SHIFTING/REACTIVATION INITIATED · SHIFTING+REACTIVATION SUBMITTED · SHIFTING SUBMITTED ·
REACTIVATION SUBMITTED · PARTNER ESIGN DONE · PARTNER APPLICATION VERIFIED ·
ARN INFO SUBMITTED`

Stage field properties LSQ offers: Enable Comments on Stage Change · Is Mandatory ·
Include in Mail Merge · Show in Quick Add · Show in Import.

### 2.5 Opportunity types (35 pipelines) — full table with codes in `opportunities.md`
Codes run 12000–12058 with ~20 gaps (deleted types). **Migration must handle
orphaned type codes on historic records.**

### 2.6 Activity types (54) — full table with codes in `activities.md`
Codes 29, 36, 150, 200–253, plus 21600 (Document Generation, a platform-reserved
range). Codes are **tenant-assigned** — any integration must resolve them at
runtime, never hard-code.

Scoring is vestigial: **46 of 54 types score zero.** Only Support Ticket (10),
Trading Activity (10), Call & Trade (10), Opportunity Added (10),
Zipteams Notes (2), Zipteams Meeting (2), Email Received (1),
Profiling Form old (1) carry any score.
→ Either commit to event-based scoring properly, or replace with an explicit model.

### 2.7 Custom Field Sets (8)
`mxCallInsights` · `Opportunity` · `Presales Profiling` · `Geolocation` ·
`mx_Source` · `Post Sales Details` · `Activity Score` · `mx_Status`

### 2.8 Task model — thin
To-Do types: **Follow-Up, Phone Call**. Appointment types: **Meeting,
Client Support On Call**. That is all.

→ Against 54 activity types and 35 opportunity types, a 4-type task model is
strikingly thin. Work that *should* be "a task, assigned, with a due date and SLA"
is instead being modelled as Opportunities. **A proper Task/Work-item entity with
queues, SLAs and escalation will absorb a large share of the mis-modelled
Opportunity pipelines.**

---

## PART 3 — AUTOMATION & PROCESS LAYER

### 3.1 Trigger vocabulary (the platform's full set, as used here)
`Lead Created` · `Lead Updated` · `Activity Added` · `Opportunity Added` ·
`Opportunity Activity Added` · `At Regular Intervals` (scheduled) ·
`On WorkDay End` (user-availability) · `Sub Automation` (composition primitive)

### 3.2 What the 51 automations actually do
1. **Lead distribution / round-robin** — DIY Journey 1/2/3, DIY Drop Off, Lead Creation Automation - Distribute + UTM, Interested client Distribution, Payment Payin Lead Transfer
2. **Field stamping / derived-value writeback** (largest category) — the six "Capture X Date" jobs, Update User's RM Name (232,055 triggers), Dealer Opp Fields Reset, Product to Pitch based on campaign (703,024), Connects and Attempts (154,036)
3. **Scoring** — Activity Score (8.0M), Activity Score-2 Opportunity
4. **Cross-entity mirroring** — Add Activity on Opportunity as per Lead (14.1M), Activity on Lead (8.5M)
5. **Opportunity auto-creation** — Global Investment Leads pushed to Opportunity, Create GI Opp using FB lead form, Zoom Webinar Daily Registered Client Opportunity Creation, CS. Algo trading Opportunity
6. **Outbound messaging** — Whatsapp on Not Connected Calls (274,401), Day 1 Journey Client Profiling WhatsApp Triggers, B2B Partner Not Contactable WhatsApp, WhatsApp to Lead stage Under Objection, Welcome Emails for Partner Onboarding, Vcard Send on RTT
7. **Reactivation / dormancy** — June-Aug Not traded in Oct-nov, High Intent Trading-DIY Client, New Automation for RTT Leads
8. **Housekeeping** — Auto Check Out 8:00 PM (128,482), regular-interval sweeps

Full table with all 51 names, trigger types and lifetime counts: `automations.md`.

### 3.3 Dead and orphaned config (live in production)
`Mobileapp1 leads on prospects - Clone` (0 triggers) ·
`Welcome Email on lead creation for Partner Onboarding` (1 trigger since Oct 2025) ·
`Automation_231` (default unnamed) · `60001589 No Cross-Sell` (a bare account number
as a name) · activity type `test` (code 251) · form `Test Client code` (F106) ·
`Dummy Lapp`, `Lapp 10`, `Lapp 11 (Draft)` · 5 unassigned Permission Templates ·
`Test Permission Template`, `UAT Permission Template` · empty teams
`Bonanza Group 1`, `Smart View Access for Intent Leads` · `SmartPing Test Team`

### 3.4 Business logic bound to individuals — continuity risk
`Leads On System and Manjushri's Id` · `Partner Acqusition- Richa Camp` (sic) ·
Permission template `Permission Template-Anup Sir Marketing`.
→ Automations and permissions must reference **roles/queues**, never named people.

### 3.5 Processes (10) & Forms (14)
All 10 processes use trigger `At Specific Work Area` — i.e. **agent-invoked
guided scripts** (call scripts, information capture), not background automation.
That is a genuinely different feature from automation and should be designed as
such in the new CRM ("guided agent task / call script").
Form ids run F4–F106 with only 14 alive → ~90 forms created and deleted over the
tenant's life. Details in `forms-processes.md`.

---

## PART 4 — ACCESS CONTROL

### 4.1 Four overlapping mechanisms (the core problem)

| Mechanism | Controls | Count |
|---|---|---|
| **Role** | Coarse persona, base feature set — **fixed at 4, not extensible** | 4 |
| **Permission Template** | Granular feature/field permissions, assignable to users *or* groups | 12+ |
| **Team** | Hierarchical org unit; drives Smart View assignment & reporting rollup | 16 |
| **Sales Group** | Lead-access sharing group with Managers + Sales Users | 9 |

A user carries 1 Role + N Permission Templates + 1 Team + N Sales Groups.
**No single screen answers "what can this person actually see?"**

→ **New CRM: one coherent model.** Extensible roles + attribute/record-level
policies, with a **"simulate access as this user"** capability. Every real persona
here (dealer, telecaller, supervisor, post-sales, partner RM, B2B manager) had to
be expressed via Permission Templates because only 4 roles exist.

### 4.2 Roles (4, fixed)
Administrator · Marketing User · Sales Manager · Sales User

### 4.3 Team hierarchy (16)
```
Bonanza Group                          (250 cumulative / 44 direct)
├── Bigul                              (180 / 5)
│   ├── Digital Onboarding Team
│   │   └── Customer Success Team
│   ├── Digital Onboarding Team 1
│   │   ├── Navi Mumbai team
│   │   ├── OS-Sales-Team Bhopal
│   │   └── OS Sales Hyderabad
│   ├── Client Onboarding Team
│   └── Cross Sales Team
├── Bonanza Wealth                     (3 / 3)
├── Admin                              (7 / 7)
├── Bonanza Group 1                    (0 / 0)   ← empty
├── SmartPing Test Team                (1 / 1)   ← test
├── Smart View Access for Intent Leads (0 / 0)   ← a team created purely as an ACL hack
└── GSM Calling                        (15 / 15)
```
Geography (Navi Mumbai, Bhopal, Hyderabad, Indore) is encoded in **team names**
rather than as a location attribute → model location as data in the new CRM.

### 4.4 Sales Groups — the manager/user inversion
`Bigul Dealer Team`: **12 managers, 1 sales user.**
`Call & Trade Team`: **4 managers, 0 sales users.**
The "Manager" slot is being used to grant *visibility*, not to express reporting
lines. → Separate **"can see"** from **"manages"** in the new model.

### 4.5 Workforce management is bundled into the CRM
User Check-in · Work Day Templates ("Bigul Working Hours") · Holiday Calendar ·
Leave Tracker · Lead Assignment Quota · Opportunity Assignment Quota ·
IP Whitelisting restriction.
The `Auto Check Out 8:00 PM` automation has 128,482 triggers — this is **actively used**.
→ **Explicit decision required**: does attendance/shift/leave belong in the new
CRM, or in an HRMS with an integration? Do not let this default silently.

Full detail incl. permission template inventory and shared-account list: `users-roles.md`.

---

## PART 5 — INTEGRATION LANDSCAPE

### 5.1 Installed connectors (18 of 149 available)
Universal Telephony Connector · SMS Marketing App · Facebook/Instagram Lead Ads ·
WhatsApp Business · Custom Lead and List Actions · Custom Dashlets Builder ·
LeadSquared Email Sync · Universal Data Sync · Custom Menu For Web App ·
Google Ads Lead Form Connector · Nudges Connector · Adwords Data Sync (+6 more)

Tenant-configured apps: Connect My Inbox · R2Win Digital SMS · Kaleyra SMS Details ·
WhatsApp Templates/Reports · Adwords Lead Form Report · Support Ticket Logs ·
SMS Templates

### 5.2 LAPPS — 15 custom serverless functions
**Five of fifteen exist solely to normalise call dispositions from different
dialler vendors**: Auto disposition GSM, Auto Disposition Smartping,
Cube lead call dispose API, Cube opportunity call dispose API, Lead Call Dispose
Lapp, Opportunity Call Dispose Lapp, Slash RTC Auto Dial.

`Cube lead call dispose API`: **27,000 calls in 7 days, 17 errors**, no evident alerting.
Test/Live drift: `Auto Disposition Smartping` and `Cube opportunity call dispose API`
are published to Test but never promoted to Live. No deployment gate.
12 of 15 show author "System" — the human author is unrecoverable.

### 5.3 Vendor sprawl — the highest migration risk
**Telephony/dialler (≥4):** GSM Calling · Smartping · Slash RTC · "Cube" ·
plus Universal + Generic Telephony Connectors
**Messaging (3):** Kaleyra · R2Win Digital SMS · WhatsApp Business
**Meetings:** Zoom (Meeting, Meeting Started, Webinar) · Zipteams
**Ads:** Google Ads · Facebook/Instagram · AppsFlyer

→ **Build a vendor-neutral event contract.** One ingestion endpoint, one
normalised `CallEvent` / `MessageEvent` / `MeetingEvent` schema, thin adapters per
vendor. Today each vendor gets its own LAPP, its own activity type, and its own
`mx_` fields — which is why swapping a dialler is currently a project rather than
a config change.

→ **Model the event, not the vendor.** "Meeting Held, channel=Zoom" — not a
`Zoom Meeting` activity type. Same for SMS, WhatsApp, calls.

### 5.4 API surface
REST API + webhooks, key-based auth, keys at `Settings > API and Webhooks >
User Access Keys`. **Keys were deliberately not extracted during this audit.**
Before cutover: inventory which integration holds which key, and rotate all on migration.

Region note: this tenant is on the **India cluster** (`in21`). The API host is
region-specific and must be confirmed from the tenant — a wrong host returns 401,
not 404. Do not hard-code from documentation.

---

## PART 6 — WORKING UI (what agents actually use)

**Lead grid default columns:** Lead Name · Mobile Number · Lead Stage · Owner ·
Created On · Modified On · First Intent · Intent · Lead Source · Client Code · Actions
**Quick filters:** Lead Stage · Lead Source · Owner · Date Range
(Date field selectable: Last Activity / Created On / Modified On;
presets: All Time, Custom, Yesterday, Today, Last/This Week, Last/This Month,
Last/This Year, Last 7 Days, Last 30 Days)

**Bulk actions:** Export Leads · Bulk Update · Send Email · Add to List ·
Add Activity · Add Opportunity · Change Owner · Change Stage · Delete ·
Reset all Filters · Messaging · **Kaleyra Send SMS** · **Add to Zoom Webinar** · Merge Leads
→ Note vendor names leaking into the core bulk menu. The new CRM needs a proper
**action-extension point** so connectors add actions without branding the core UX.

**Lead detail tabs:** Activity History · Lead Details · Opportunities · Tasks ·
Notes · Documents · **Lead Share History** · **Audit Trail**
(Record-level audit trail and share history DO exist natively — confirm exactly
what they capture before assuming the new CRM must rebuild from zero.)

**KPI tiles on lead detail:** Lead Score · No Of Not Connects · No of Connects ·
Number of Pitch Done — all driven by automation-maintained counter fields.
→ Should be computed aggregates over the timeline.

**Advanced Search:** `[Field] [Operator] [Value]` rows, `+ Add`, match mode
**Any Criteria (OR) / All Criteria (AND)** — flat only. Cannot express
`(A AND B) OR (C AND D)`. Save as Quick Filter available.
→ **This limitation is the direct cause of the 4,810-list problem.**

**Smart Views (14):** work queues assigned to Teams, each with 1–11 Tabs.
Telecaller Smart View and Client Onboarding Team each have **10–11 parallel tabs** —
agents work many queues simultaneously. This is a real requirement for the new
CRM's work-queue design. 9 of 14 have no team assigned (dead or relying on
permission templates instead).

**Evidence from a real record** (Lead Age 643 days, Score 335):
41 "Not Connects" vs 26 "Connects" — a 61% non-contact rate sustained over two
years with no attempt-governance (max attempts, cooling-off, auto-retire).
Simultaneously `Telecaller Calling Status = "Not Contactable"` while
`Lead Stage = READY TO TRADE` — contradictory states coexisting because different
automations maintain each with no cross-validation.

Full UI detail: `ui-surface.md`.

---

## PART 7 — PROPOSED TARGET DATA MODEL (starting point, not a conclusion)

Derived from the findings above. **This is a hypothesis to argue with, not a spec.**

```
Party (person or organisation)
├── identifiers: pan, client_codes[] (1..n, was mx_Client_Code_1..6), boid, dp_id
├── roles[]: Prospect | Customer | Partner/AP | Employee   ← concurrent, not exclusive
├── lifecycle_stage: Prospect | Applicant | Customer | Dormant | Closed
├── consent: do_not_call, do_not_email, do_not_sms, opt_in_status, opt_in_at, opt_in_source
├── attribution: first_touch{}, last_touch{}   ← structured, not 20 flat mx_ fields
└── computed: score, rfm{recency, frequency, monetary}, engagement  ← derived, never stamped

Application  (was: 16 KYC lead stages + ~15 mx_ status fields)
├── type: Equity | MF | Partner | Reactivation | Shifting | GlobalInvestments
├── status + per-step timestamps: pan_submitted_at, kra_completed_at,
│   personal_info_at, bank_info_at, signature_at, selfie_at, segment_info_at,
│   documents_at, esign_at, verified_at, account_opened_at
├── objection{raised_at, reason, resolved_at}
└── many per Party, concurrent

Account  (was: mx_Client_Code_1..6 + segment activation fields)
├── client_code, depository, segments_active[], ddpi
├── activated_at per segment (equity, derivatives, commodity, currency, MF, GI)
└── holdings_value, ledger_balance, margin   ← or better: read-model from source system

Deal          (was: ~12 of 35 Opportunity types)
├── pipeline, stage, value, expected_close, owner, win_loss_reason
Case          (was: ~7 "C.S-*" / "*Support" Opportunity types)
├── category, priority, sla_due, resolution, owner
ProcessInstance (was: Client Profiling, KYC Reactivation, Fund Collection, MF App)
├── definition_version, current_step, step_outcomes[]

Interaction   ← ONE shared timeline; removes the 14.1M-trigger mirroring automation
├── channel: call | whatsapp | sms | email | meeting | chat | app_event
├── direction, occurred_at, duration, outcome{disposition, sub_disposition}  ← cascading, validated
├── notes  ← per-interaction, attributed, timestamped (fixes the "|"-concatenation problem)
├── actor: User (never a shared login)
├── vendor_ref{provider, external_id}  ← vendor detail quarantined here
└── links: party, application?, deal?, case?, process_instance?

Task / WorkItem   (was: badly modelled as Opportunities)
├── type, due_at, sla, queue, assignee, status, escalation_policy

Segment       ← computed membership, NOT a stored owned record
└── definition (nested boolean query), live evaluation, optional snapshot with TTL
```

**Cross-cutting platform requirements** (each traceable to a finding above):
- Field-change history + stage-entry/exit timestamps, queryable → kills 6 automations, ~15 fields
- Explicit automation ordering + conflict detection → fixes the live race condition
- Versioned forms/processes/schemas with diff + migration path → kills "- Clone" and date-stamped names
- Cascading picklists enforced at the **API** layer → fixes zero-dependent-fields
- Nested query builder + live saved segments → kills the 4,810-list CSV cycle
- Vendor-neutral event ingestion contract → kills 5 duplicate dialler LAPPS
- SSO, one identity per human, queues instead of shared logins → restores attribution
- Field-creation governance gate → prevents a second 289-field sprawl
- "Simulate access as user" → makes the permission model comprehensible

---

## PART 8 — MIGRATION WATCH-LIST

1. **Orphaned type codes.** Opportunity codes 12000–12058 have ~20 gaps; activity
   codes 29/36/150/200–253/21600. Historic records may reference deleted types.
   Build a mapping table with an explicit "unknown/deleted" bucket.
2. **Codes are tenant-assigned.** Never hard-code activity `ActivityEvent` or
   opportunity codes; resolve at runtime from metadata.
3. **Dropdown fields holding boolean-ish text.** 113 custom Text + 82 Dropdown
   vs only 2 Boolean. Profile actual distinct values per field before mapping types.
4. **The `|`-concatenated notes fields** (`mx_Disposition_Notes_Remarks` and
   similar) need a parsing/split strategy — or an explicit decision to migrate
   them as an opaque legacy blob attached to the Party.
5. **Consent data is regulatory.** DoNotCall/Email/SMS, opt-in status/date/details
   must migrate with full fidelity and provenance for a SEBI-regulated entity.
6. **Shared-login history is unattributable.** Decide now how activity created by
   `bigulcaller17` / `Presales Common Id` etc. is represented post-migration
   (suggest: a synthetic "Legacy Shared Account" actor, clearly flagged).
7. **API keys must be inventoried and rotated at cutover.**
8. **4,810 lists**: do not migrate by default. Migrate dynamic/refreshable lists
   as saved segments; archive static lists to cold storage with an owner ping.
9. **Two live form versions (V3 + V4) writing overlapping field sets** — decide the
   canonical version and back-fill before or during migration.
10. **Region/host**: India cluster (`in21`). Confirm API host from the tenant.

---

## PART 9 — WHAT THIS AUDIT DID NOT COVER

Stated plainly so nothing is assumed complete:
- **Option values for most dropdowns.** Captured `mx_Disposition`
  (Connected / Not Contactable / Other / Invalid data) and all 32 lead stages.
  The remaining ~81 custom dropdowns' option lists were not enumerated.
- **Per-Opportunity-type field configurations.** Each of the 35 types has its own
  fields/forms/statuses; these were not opened individually.
- **Automation internals.** Names, triggers, scope and lifetime counts captured;
  the step-by-step logic inside each of the 51 was not read.
- **Reports/SIERA.** The reporting layer was not audited.
- **Marketing assets** — Email Library, Campaigns, Landing Pages Pro, Website
  Widgets, Nurturing Programs — not audited.
- **API keys and webhook endpoint configuration** — deliberately not extracted.
- **Draft/unpublished automations, forms and processes** — only Published were listed.
- **Mobile app settings, Telephony settings, Converse settings, Marvin, Casa,
  Mavis, Batch Jobs** — enumerated as available but not opened.
- **Actual data quality profiling** — no field-level fill rates or value
  distributions were measured. This is the single most valuable next step.

**Recommended next passes, in priority order:**
1. Data-quality profile: fill rate + distinct values for all 338 lead fields.
   This tells you what to migrate vs abandon, and is quick to produce via export.
2. Enumerate option values for the ~81 remaining dropdowns (business vocabulary).
3. Open the 8–10 highest-volume automations and document their actual logic.
4. Per-Opportunity-type field configs for the ~12 genuine "Deal" pipelines.
5. Interview the heavy CSV/list users about what they do in Excel.

---

### Companion files
`lead-fields.md` · `stages.md` · `opportunities.md` · `activities.md` ·
`automations.md` · `users-roles.md` · `views-tasks-lists.md` ·
`integrations.md` · `forms-processes.md` · `ui-surface.md`
