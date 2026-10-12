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

## 5 · Lead stages — 30 active, 4 retired

Bigul has 24, and the two lists are not the same. In order:

NEW LEAD · CONTACTED · MEETING FIXED · MEETING DONE · ONBOARDED · DOCUMENTS
SUBMITTED · UNDER OBJECTION · UNDER REVIEW · INTERNALLY VERIFIED · CUSTODIAN
VERIFIED · ACCOUNT CREATED · FUNDS TRANSFERRED · INTERESTED · DOCUMENTION DONE ·
FIRST BUSINESS · ONBOARDING & TRAINING · NOT INTERESTED · PROSPECT · CONTACT
INFO SUBMITTED · PAN SUBMITTED · DIGILOCKER /KRA COMPLETED · PERSONAL INFO
SUBMITTED · BANK INFO SUBMITTED · SEGMENT INFO SUBMITTED · SIGNATURE UPDATED ·
SELFIE UPDATED · ESIGN DONE · APPLICATION VERIFIED · READY TO TRADE · CUSTOMER

Retired: INVALID NUMBER · IRRELEVANT - NOT INTERESTED · NO RESPONSE ·
RELEVANT - NOT INTERESTED.

Three things to notice. *DOCUMENTION DONE* is a typo that is now a stored value
on every lead that reached it. Eleven of the thirty are steps of one KYC
journey — PAN, DigiLocker, personal info, bank info, segment, signature,
selfie, e-sign, verified — which is a checklist modelled as a pipeline, the
shape non-negotiable 9 warns against. And *NOT INTERESTED* is an active stage
while *RELEVANT - NOT INTERESTED* is retired, so "not interested" is recorded
two ways.

## 6 · Lead fields — 200

Two hundred fields on the lead object, across eight pages. The grid offers no
"custom only" filter, so the split between system and custom was not counted;
the Bigul audit's `lead-fields.md` is the comparison once it is.

## 7 · Lead sources — the strongest argument for OPS-14

The Lead Sources settings screen renders blank in this tenant and could not be
read. The Lead Source Report gives the live picture instead — **2,757 leads in
the last 30 days, across 19 distinct source values**:

| Source | Leads | |
|---|---:|---|
| **Unknown** | **2,170** | **78.7%** |
| google | 129 | 4.7% |
| ig | 118 | 4.3% |
| Self | 57 | 2.1% |
| DSA | 47 | 1.7% |
| Partner Client | 46 | 1.7% |
| Outbound Phone call | 41 | 1.5% |
| Organic | 35 | 1.3% |
| BA | 21 | 0.8% |
| Partner Referral | 14 | 0.5% |
| fb · Organic Search · Direct Traffic | 13 each | 0.5% each |
| New Leads for DSA | 12 | 0.4% |
| CLIENT | 11 | 0.4% |
| Direct | 8 | 0.3% |
| Franchise | 6 | 0.2% |
| whatsapp | 2 | 0.1% |
| Fresh Insurance | 1 | 0.04% |

**Nearly four in five leads have no source at all.** Of the rest, the values
are the free-text sprawl OPS-14's dropdown exists to stop: `google` beside
`Organic Search` and `Organic`; `Direct` beside `Direct Traffic`; `fb`,
`ig` and `whatsapp` in lower case; `DSA` beside `New Leads for DSA`;
`CLIENT` beside `Partner Client`. Nine of the nineteen are arguably four.

This is the migration's source-mapping table, and the reason the new CRM
refuses a source that is not on the list.

## 8 · Opportunity types — 25

Account Opening Customer · Ace Algo · AIF opportunity · Alpha Portfolio · Bigul
Products · Bonanza Partner · Bonanza Partner Team · Bond Customer · Business
Associate · E-Broking Customer · Equity Customer · Franchise · Game Changer
DSA · GIFT IFSC · Insurance Customer · IPO Customer · Merchant Banking
Customer · Multiple Opportunity · Mutual Fund · Mutual Funds Customer ·
Obsolete Customer · Partner Activation · PMS · Reactivation - Margin
Collection · Sunglow Loan

Each is a product line, which is what this CRM's product cards are. The
overlaps are the interesting part: *Mutual Fund* (added this June, "for MF
outbound calling") sits beside *Mutual Funds Customer*; *Bonanza Partner*
beside *Bonanza Partner Team*; and *Obsolete Customer* is a type called
obsolete that nobody deleted. *Multiple Opportunity* is a type for having more
than one, which the data model should express rather than a type.

## 9 · Installed apps — 13

Universal Telephony Connector · Facebook/Instagram Lead Ads · WhatsApp
Business · Custom Tab Connector · Custom Lead and List Actions · Universal Data
Sync · Custom Menu For Web App · Nudges Connector · Custom Opportunity Tab
Connector · Custom Opportunity Actions · Zoom Meeting Connector · Zip based
lead distribution · **Freshdesk**

Bigul has 18. Two matter for the build:

- **Freshdesk** is installed here, so customer support tickets live in
  Freshdesk rather than in LeadSquared. Our Cases module has to know whether it
  replaces Freshdesk or integrates with it — a question for Ritesh.
- **Zip based lead distribution** assigns leads by PIN code, which is a routing
  rule this CRM's assignment engine does not have today.

No Google Ads connector here, where Bigul has two.

## 10 · Not yet captured

- Forms, Process Designer processes and Smart Views
- Lead and activity volumes (the Bigul audit's 495,118 leads has no counterpart
  here yet)
- The split of the 200 lead fields into system and custom
- The two Cube LAPPS' code (the export button reports success and produces no
  file)

## 11 · What this changes

1. **Every migration estimate so far covers one of two tenants.** Fields,
   stages, sources, automations, LAPPS, opportunity types and reports all have
   a second set.
2. **The ten flows to port are Bigul's.** Bonanza's business logic is
   unscoped, and its own distribution and campaign flows will need the same
   treatment.
3. **Two tenants, one CRM, two books.** The book boundary the CRM already
   enforces is the right shape for this, but the configuration that hangs off
   each book — stages, sources, templates, dialler campaigns, DLT headers —
   has to be loaded per business rather than once.
4. **Source and stage migration needs a mapping table, not a copy.** 78.7% of
   recent Bonanza leads have no source, the rest use nineteen values that are
   really about ten, and the stage list carries a typo and a duplicate
   "not interested". Importing either list as-is would carry the mess across.
5. **Freshdesk is a live dependency** nobody has ruled on.
