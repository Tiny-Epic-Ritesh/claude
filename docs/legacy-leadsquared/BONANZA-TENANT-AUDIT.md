# The Bonanza LeadSquared tenant — first pass

**Read 12 October 2026, read-only.** Nothing in LeadSquared was changed.

## Why this document exists

`LEADSQUARED-CRM-REFERENCE.md` and everything beside it describe **one** tenant.
Bonanza runs **two**, and until now only the first was looked at. Every number
in the older documents — 495,118 leads, 83 users, 51 automations, 15 LAPPS, the
24 stages — belongs to the **Bigul** tenant. This file is the first pass over
the other one.

| | Bigul tenant | Bonanza tenant |
|---|---|---|
| Tenant id | 57437 | **63762** |
| Branding in the app | "bigul" logo | plain LeadSquared logo |
| Account name in the avatar menu | Bonanza Portfolio Limited | Bonanza Portfolio Ltd |
| Users' email domain | `@bigul.co` | mostly `@bonanzaonline.com`, some `@bigul.co` |
| Covered by the older audit | yes | **no** |

Both are on the India cluster (`app-in21.leadsquared.com`). **The avatar menu's
company name is the same on both and cannot be used to tell them apart** — read
the tenant id in that menu, or a LAPP id's prefix (`da_57437_` / `da_63762_`).
Only one can be signed in at a time in a browser.

## 1 · Automations — 25 published

Bigul has 55. Volumes here are an order of magnitude smaller: the busiest flow
has fired 97,408 times against Bigul's 3,401,771.

| Runs | Automation | Trigger |
|---:|---|---|
| 97,408 | Meeting Activity | Activity Added |
| 17,563 | MF Campaign Opportunity Automation | Lead Created |
| 15,815 | Whatsapp Activity | Activity Added |
| 13,874 | Mail Marge Owner Field In partner Form | Activity Added |
| 13,814 | No of Connects and Attempts | Activity Added |
| 11,884 | Lead Stage Change For Bonanza Partner Team v2 | Activity Added |
| 11,779 | Phone Call Activity - 26 May 2023 | Activity Added |
| 9,270 | Meeting Task Create | Activity Added |
| 8,546 | Capture Created Date Field | Lead Created |
| 6,937 | Lead Flow Time Calculation (Lead Field Update) | Activity Added |
| 6,216 | Bonanza Partner Lead Distribution - 2May2025 | Lead Created |
| 3,086 | Capture MQL Date | Lead Updated |
| 2,128 | Capture PAN Submitted Date | Lead Updated |
| 1,368 | Meeting Task Create - Bonanza Sales Team | Activity Added |
| 1,098 | SRC Lead Distribution | Lead Created |
| 467 | MF Auto Dial Automation - Lead Capture Activity_05.05.2026 | Activity Added |
| 463 | Automation_45 | At Regular Intervals |
| 332 | MF WhatsApp Drip Campaign_24.04.2026 - 30th April 2026 | Activity Added |
| 214 | Distribute FB LeadGen Leads to Amaan Shaikh | Lead Created |
| 213 | Lead Recapture event for FB - Amaan Shaikh | Activity Added |
| 22 | Opportunity Stage Change For Bonanza Partner Team V1 | Opportunity Activity Added |
| 22 | No of Connects and Attempts on opportunity | Opportunity Activity Added |
| 17 | Opportunity Mail Marge Owner Field In partner Form V1 | Opportunity Activity Added |
| 14 | Notify MF Users For New Lead Assignment | Lead Updated |
| 11 | AIF Opportunity Automation | Lead Created |

**What it says.**

1. **The same compensations as Bigul.** *Capture Created Date*, *Capture MQL
   Date*, *Capture PAN Submitted Date* and *Lead Flow Time Calculation* exist
   only because LeadSquared has no stage entry/exit timestamps, which are
   first-class here (non-negotiable 4). *No of Connects and Attempts* is
   counter-stamping, which roll-ups replace. Four of the twenty-five are
   features this product already has.
2. **A named person is wired into the flow.** *Distribute FB LeadGen Leads to
   Amaan Shaikh* and *Lead Recapture event for FB - Amaan Shaikh* route by a
   person's name, the same brittleness as Bigul's per-RM WhatsApp branches.
3. **Opportunity-side automation exists here and barely runs** — three flows
   between 17 and 22 executions, against six-figure lead-side flows.
4. **The port list doubles.** The ten flows scoped for migration are Bigul's.
   None of these twenty-five is among them, and the business logic worth
   carrying across — partner lead distribution, MF campaign opportunities, the
   WhatsApp drip, SRC distribution — has not been scoped at all.

## 2 · LAPPS — 8 serverless functions

Bigul has 15, with different names. Four of these are drafts from November 2022
that were never published.

| LAPP | Test | Live | Last published |
|---|---|---|---|
| Lead send to integration hub | Published | — | 22 May 2026 |
| MF Auto Dial Lapp | Published | Published | 6 May 2026 |
| Call Disposition - Cube API LAPP | Published | Published | 4 Nov 2024 |
| Lead Auto Dial - Cube LAPP | Published | — | 21 Jul 2023 |
| Lead Call Dispose Lapp | Draft | — | — |
| Email Mapping to Alternate Email Address | Draft | — | — |
| Opportunity Call Dispose Lapp | Draft | — | — |
| Slash RTC Auto Dial | Draft | — | — |

**MF Auto Dial Lapp** (read in full). Takes the lead's phone, lead id,
opportunity id and the owner's email from the automation payload and calls
CUBE's Click2Call on `raphsody.in/QuickCall61/Click2Call61.php`, campaign
`Bonanzaonline_MF_DEL`, with the client's phone number in the query string and
no authentication on the request.

**Lead send to integration hub** (read in full). Posts every newly created
lead — name, email, phone, city — to `integrations-uat.tinyepic.in/api/events`.
Published to Test only, never to Live. **Its API key is written into the source
in plain text**, readable by anyone who can open the LAPP screen. It should be
rotated and moved to the LAPP's own Keys screen, which is where the Cube LAPP
keeps its credentials.

**The two Cube LAPPS could not be read.** Their code is a zip upload, and the
export button reports success without the file reaching the browser. Bigul's
equivalent (`Cube lead call dispose API`) was read in full and is documented
under the CUBE contract; these are assumed to be the same shape until read.

## 3 · Reports

No pinned reports at all, against Bigul's six. The standard LeadSquared groups
are present (Account Insights, Administrative, Audit Logs, Customer Analysis,
Emails and Marketing Automation, Field Sales Tracking, Large Exportable
Reports, Lead Insights and the rest).

**Built by the team here:** Lead Activity Count Activity Owners Wise, Lead
Opportunity Report, Meeting Report v1, Opportunity Count, and two untagged —
Lead Source Report and Meeting Report V2. Six in total, against Bigul's eleven,
and none of Bigul's SIERA performance reporting.

## 4 · Users, roles and licences

**119 active users**, against Bigul's 83. The page states **45 active users are
allowed** and **63 active mobile users are allowed** — 108 licences for 119
active accounts, which is worth checking with LeadSquared before migration
rather than after.

Roles in use: Super Administrator, Administrator, Sales Manager, Sales User —
four, where the new CRM has its own role tree. Permission templates are in use
(*Sales User Permissions*, *Ami Sales User Permissions*, *Sales User Supervisor
…*, *Admin Permission for …*), which is the same "permission template instead
of a role" pattern Part 4.1 of the Bigul audit criticised. Teams seen include
Bonanza Group, Team of Ashutosh, and several named after a manager.

Some users carry `@bigul.co` addresses in this tenant, so the two tenants'
populations overlap.

## 5 · Lead stages

Different from Bigul's 24. Active, in order: NEW LEAD, CONTACTED, MEETING
FIXED, MEETING DONE, ONBOARDED, DOCUMENTS SUBMITTED, UNDER OBJECTION, UNDER
REVIEW, and more below the fold. Retired: INVALID NUMBER, IRRELEVANT - NOT
INTERESTED, NO RESPONSE, RELEVANT - NOT INTERESTED.

The stage vocabularies of the two tenants are **not the same list**, which the
CRM has to reconcile: one Stage picklist per business, or one shared list with
the union of both (OPS-13, OPS-14).

## 6 · Not yet captured

The browser could not render several Settings screens for long enough to read
them. Still to do on a second pass:

- the full active stage list below the fold, and Lead Sources (needed for the
  Source picklist per book — OPS-14)
- the lead field inventory, custom fields and dependent fields
- installed connectors and apps, and the API keys inventory
- forms and processes, opportunity types, smart views
- lead and activity volumes

## 7 · What this changes

1. **Every migration estimate so far covers one of two tenants.** Fields,
   stages, sources, automations, LAPPS and reports all have a second set.
2. **The ten flows to port are Bigul's.** Bonanza's business logic is
   unscoped, and its own distribution and campaign flows will need the same
   treatment.
3. **Two tenants, one CRM, two books.** The book boundary the CRM already
   enforces is the right shape for this, but the configuration that hangs off
   each book — stages, sources, templates, dialler campaigns, DLT headers —
   has to be loaded per business rather than once.
