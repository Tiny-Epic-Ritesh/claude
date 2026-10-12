# Migrating stages and sources — a proposal

**Written 12 October 2026, for Ritesh to approve or correct.** Nothing is built
from this yet. It proposes the lists the new CRM should hold, and what every
value in LeadSquared becomes when it is brought across.

Read with `BONANZA-TENANT-AUDIT.md` (where the Bonanza numbers come from) and
`stages.md` (the Bigul stage analysis, which reached the same conclusion from
the other tenant).

---

## 1 · The principle: one value per question

LeadSquared's Lead Stage answers four questions at once — how far through
onboarding a person is, whether they are a customer, why they were
disqualified, and whether they are a partner. That is why the tenant grew
thirty stages and dozens of `mx_` date fields re-encoding the same journey.

The new CRM already separates them, so the migration is mostly **moving each
legacy stage to the dimension it belongs in**, not renaming it:

| Question | Where it lives in the new CRM |
|---|---|
| Where is this lead in the sales conversation? | `lead.stage` — six values |
| How far through account opening? | the KYC journey, 16 steps with timestamps |
| Is the account opening stuck, rejected, done? | `kyc_status` — derived, not typed |
| What is happening on each product? | the product card — 8 states, per product |
| Is this person a client, and in what condition? | `client.status` — Active / Dormant / Suspended / Closed |
| Is this person a partner, and how far through? | the partner record — its own six states |
| Why did we lose them? | `lost_reason` on the product card |

**Nothing below adds a stage to make a legacy value fit.** Where a legacy stage
says something the model cannot hold, that is called out as a gap with a
recommendation, not papered over.

---

## 2 · Sources

### 2a · What is there now

In the last 30 days the Bonanza tenant recorded 2,757 leads across 19 source
values. **2,170 of them — 78.7% — have no source at all.** The other 587 use
values that are mostly the same few things spelled differently.

> Bigul's live source list has not been read yet; it needs the same pass. The
> list below is built from Bonanza's values plus the thirteen the new CRM is
> seeded with, and should be re-checked against Bigul before it is final.

### 2b · The proposed list — 16 values, per business

Each business keeps its own list (N-10), seeded identically, so Bigul can add
"Bigul app" campaigns without them appearing on Bonanza's dialog.

| # | Source | Means |
|---|---|---|
| 1 | Website | Our own site, including organic and direct arrivals |
| 2 | DKYC portal | Self-service account opening, started by the client |
| 3 | Bigul app | The mobile app |
| 4 | Google Ads | Paid search |
| 5 | Facebook Lead Ads | Meta lead form, Facebook |
| 6 | Instagram Lead Ads | Meta lead form, Instagram |
| 7 | WhatsApp campaign | Outbound WhatsApp |
| 8 | Webinar | Events and webinars |
| 9 | Walk-in branch | Came into an office |
| 10 | Outbound call | We called them first |
| 11 | Partner referral | Referred by a partner of any kind |
| 12 | Referral — existing client | Referred by a client |
| 13 | IPO enquiry | Enquiry about a specific IPO |
| 14 | Campaign — other | A campaign without its own source |
| 15 | Manual | Typed in by a person |
| 16 | Import | Loaded from a file |

### 2c · What each legacy value becomes

| LeadSquared value | Leads (30d) | Becomes | Note |
|---|---:|---|---|
| *(blank / Unknown)* | 2,170 | **left blank** | See 2d |
| google | 129 | Google Ads | |
| ig | 118 | Instagram Lead Ads | |
| Self | 57 | DKYC portal | **Confirm:** "Self" is read as self-service account opening |
| DSA | 47 | Partner referral | DSA is a *kind of partner*, not a source — see 2e |
| Partner Client | 46 | Partner referral | |
| Outbound Phone call | 41 | Outbound call | |
| Organic | 35 | Website | |
| BA | 21 | Partner referral | Business Associate — a partner kind |
| Partner Referral | 14 | Partner referral | |
| fb | 13 | Facebook Lead Ads | |
| Organic Search | 13 | Website | |
| Direct Traffic | 13 | Website | |
| New Leads for DSA | 12 | Partner referral | A list name that became a source |
| CLIENT | 11 | Referral — existing client | |
| Direct | 8 | Website | |
| Franchise | 6 | Partner referral | Franchise — a partner kind |
| whatsapp | 2 | WhatsApp campaign | |
| Fresh Insurance | 1 | *not a source* | A product interest: becomes an Insurance product card, source left blank |

Nineteen values become nine. Five of them (DSA, BA, Franchise, Partner Client,
New Leads for DSA) are one source plus a partner attribute.

### 2d · The 78.7% with no source

They are migrated **blank**, not as a value called "Unknown".

A stored "Unknown" would be offered on every dialog from day one, and an RM
picking it is indistinguishable from an import that never knew. Blank already
means "nobody recorded it", reports count it, and the field is optional
(OPS-14). If you would rather see it as an explicit value on reports, say so
and I will seed `Unknown (migrated)` instead, retired from the picker so no
new lead can be saved with it.

**The number matters more than the mapping.** Four in five new leads arriving
without attribution is an intake problem, not a migration one: the web forms,
the ads connectors and the DKYC portal each have to stamp their own source.
That is part of the connectors build, and it is worth fixing before migration
rather than after, or the new CRM inherits the same blank column.

### 2e · Partner kinds are not sources

DSA, BA and Franchise describe *what kind of partner referred the lead*. The
CRM holds that on the partner record as `partner_model`, seeded today with
Remisier / Agent / Trainee Entrepreneur / Associate / Authorised Person — which
does not include DSA, BA or Franchise. **Recommendation:** add those three to
`partner_model`, and migrate these leads as "Partner referral" pointed at the
partner, so "how many leads did DSAs send us" is answered from the partner
rather than from a text field on the lead.

---

## 3 · Stages

### 3a · The proposed list — the six that exist, unchanged

New · Contacted · Qualified · In Progress · Won · Lost

Each answers one question: how far the *conversation* has got. Account opening,
product interest and client health are already modelled separately, and the
cost of adding a stage is real — the funnel, the cockpit tiles and the Won/Lost
logic key on these six names (OPS-13).

### 3b · Bonanza's 30 active stages

| LeadSquared stage | Becomes |
|---|---|
| NEW LEAD | stage **New** |
| PROSPECT | stage **New** |
| CONTACTED | stage **Contacted** |
| INTERESTED | stage **Qualified** |
| MEETING FIXED | stage **Qualified** + a meeting task on the lead |
| MEETING DONE | stage **Qualified** + a logged meeting activity |
| CONTACT INFO SUBMITTED | stage **In Progress** + journey steps MOBILE/EMAIL complete |
| PAN SUBMITTED | stage **In Progress** + journey step PAN complete |
| DIGILOCKER /KRA COMPLETED | stage **In Progress** + AADHAAR_DIGILOCKER complete |
| PERSONAL INFO SUBMITTED | stage **In Progress** + PERSONAL complete |
| BANK INFO SUBMITTED | stage **In Progress** + BANK complete |
| SEGMENT INFO SUBMITTED | stage **In Progress** + SEGMENTS complete |
| SIGNATURE UPDATED | stage **In Progress** + SIGNATURE complete |
| SELFIE UPDATED | stage **In Progress** + SELFIE complete |
| DOCUMENTS SUBMITTED | stage **In Progress** + BANK_PROOF / INCOME_PROOF complete |
| DOCUMENTION DONE *(typo)* | same as DOCUMENTS SUBMITTED — the two merge |
| ESIGN DONE | stage **In Progress** + ESIGN complete |
| UNDER REVIEW | stage **In Progress**, journey awaiting verification — see gap 1 |
| INTERNALLY VERIFIED | stage **In Progress**, journey verified internally — gap 1 |
| CUSTODIAN VERIFIED | stage **In Progress**, journey verified by the custodian — gap 1 |
| APPLICATION VERIFIED | stage **In Progress**, `kyc_status` **Complete** |
| UNDER OBJECTION | stage **In Progress**, `kyc_status` **Rejected** + reason — gap 2 |
| ACCOUNT CREATED | stage **Won** + client created |
| ONBOARDED | stage **Won** + client created |
| READY TO TRADE | stage **Won**, client **Active** |
| CUSTOMER | stage **Won**, client **Active** |
| FUNDS TRANSFERRED | stage **Won**, client **Active** + first funding recorded — gap 3 |
| FIRST BUSINESS | stage **Won**, client **Active** + first trade recorded — gap 3 |
| ONBOARDING & TRAINING | stage **Won** + a post-sale onboarding task |
| NOT INTERESTED | stage **Lost**, card lost_reason "Not interested" |

Retired stages, for leads that still hold them:

| LeadSquared stage | Becomes |
|---|---|
| INVALID NUMBER | stage **Lost**, reason "Invalid number", and `mobile_invalid` set |
| NO RESPONSE | stage **Lost**, reason "No response" |
| IRRELEVANT - NOT INTERESTED | stage **Lost**, reason "Not relevant" |
| RELEVANT - NOT INTERESTED | stage **Lost**, reason "Not interested" |

### 3c · Bigul's extra stages

Bigul shares most of the above. These are the ones it has and Bonanza does not:

| LeadSquared stage | Becomes |
|---|---|
| DOCUMENTS UPLOADED | as DOCUMENTS SUBMITTED |
| APPLICATION RESUBMITTED | journey re-entered after an objection — gap 2 |
| ESIGN PENDING | stage **In Progress**, ESIGN step open |
| DIGILOCKER COMPLETED | merges with DIGILOCKER /KRA COMPLETED |
| ACCOUNT OPENED | as ACCOUNT CREATED |
| REOPEN ACCOUNT | client **Active** again, via a reactivation journey — gap 4 |
| ACCOUNT CLOSED | client **Closed** |
| INACTIVE (NO RESPONSE) | stage **Lost**, reason "No response" |
| SHIFTING/REACTIVATION INITIATED | a reactivation journey — gap 4 |
| SHIFTING+REACTIVATION SUBMITTED | a reactivation journey — gap 4 |
| SHIFTING SUBMITTED | a shifting journey — gap 4 |
| REACTIVATION SUBMITTED | a reactivation journey — gap 4 |
| PARTNER ESIGN DONE | partner record, state **ONBOARDING** — gap 5 |
| PARTNER APPLICATION VERIFIED | partner record, state **ONBOARDING** — gap 5 |
| ARN INFO SUBMITTED | partner record, ARN field — gap 5 |

### 3d · The five gaps, and what I would do

1. **Verification has three steps the journey does not model** — under review,
   internally verified, custodian verified. *Recommendation:* add a
   `VERIFICATION` step to the KYC journey with three outcomes, so "waiting on
   the custodian" is visible rather than inferred. Small change.
2. **"Under objection" is not the same as rejected.** An objection is "fix this
   and resubmit"; rejection ends it. The CRM's `kyc_status` has Rejected but no
   objection. *Recommendation:* add **Objection** to the status list, with the
   objection text, because the whole *APPLICATION RESUBMITTED* loop depends on
   telling the two apart.
3. **"Funds transferred" and "first business" are client facts, not lead
   stages.** *Recommendation:* record them on the client — first funding date
   and first trade date — which also gives OPS-02's dormancy automations
   something real to read.
4. **Shifting and reactivation are journeys of their own**, and Bigul has four
   stages for them. *Recommendation:* model them as journey types alongside
   account opening, so a client being reactivated does not overwrite the lead
   stage of the original sale.
5. **The partner journey belongs on the partner record**, which already has
   six states. *Recommendation:* migrate those three stages onto the partner,
   and add the ARN as a partner field.

Gaps 1 and 2 are small. Gaps 3, 4 and 5 are each a piece of work and should be
sized before they are promised.

---

## 4 · What I need from you

| # | Question | My recommendation |
|---|---|---|
| 1 | Does "Self" mean the client started the account themselves on the DKYC portal? | Yes — map to DKYC portal |
| 2 | Are DSA, BA and Franchise kinds of partner? | Yes — add to `partner_model`, source becomes "Partner referral" |
| 3 | Is "Fresh Insurance" a product interest rather than a source? | Yes — becomes an Insurance product card |
| 4 | The 78.7% with no source: blank, or a visible "Unknown (migrated)"? | Blank |
| 5 | Do the two businesses keep separate source and stage lists? | Yes, one per business (N-10) |
| 6 | Does the business distinguish "under objection" from "rejected"? | Yes — add an Objection status |
| 7 | Are shifting and reactivation worth modelling as journeys now, or later? | Later, but sized now |
| 8 | Anything in the mapping tables above that is simply wrong? | — |

Answer 1 to 6 and the mapping is ready to build against. 7 and 8 can follow.
