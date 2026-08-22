# Integrations, Apps, LAPPS & Extensibility

## INSTALLED MARKETPLACE CONNECTORS (18 installed of 149 available)
Confirmed installed (12 visible on page 1):

| Connector | Category | Purpose |
|---|---|---|
| Universal Telephony Connector | Telephony | Multiple contact centres into LSQ |
| SMS Marketing App | SMS | Bulk/transactional SMS |
| Facebook/Instagram Lead Ads | Online Ads | Lead capture from Meta ad forms |
| WhatsApp Business | Converse | WhatsApp messaging |
| Custom Lead and List Actions | UI Customization | Custom buttons on Leads/Lists pages |
| Custom Dashlets Builder | Analytics | Custom report dashlets |
| LeadSquared Email Sync | Email | 2-way email sync |
| Universal Data Sync | Lead Capture | Generic integration platform |
| Custom Menu For Web App | UI Customization | Custom web nav |
| Google Ads Lead Form Connector | Online Ads | Lead capture from Google ad forms |
| Nudges Connector | Converse | Sales-rep nudges |
| Adwords Data Sync | Online Ads | Click/source attribution sync |

Marketplace connector categories available on the platform:
Analytics, Converse, Email, Lead Capture, Mobile, Online Ads, Online Meeting,
Payment Gateway, Publisher, Real Estate, Scheduling, Service, SMS, Telephony,
Telephony-US, Ticketing, UI Customization, Verifications, WordPress.

## CONFIGURED CUSTOM APPS (from APPS nav — tenant-specific instances)
- Connect My Inbox
- Adwords Data Sync
- Nudges Connector
- Universal Data Sync
- Configure R2Win Digital SMS (+ Manage Templates, + Manage Reports)
- Adwords Lead Form Report
- Kaleyra SMS Details
- WhatsApp Templates
- WhatsApp Reports
- Facebook/Instagram Lead Ads
- SMS Templates
- Support Ticket Logs

## LAPPS — 15 custom serverless functions
LAPPS = LeadSquared Apps: custom code (JS) deployed to Test and Live, callable
by URL and from automations. Each has independent Test/Live publish state and
API-call statistics.

| LAPP | Test | Live | Last Published | API calls (7d, Test/Live) | Modified By |
|---|---|---|---|---|---|
| Auto disposition GSM | Published | Published | 01/28/2026 | 0 / 0 | System |
| Auto Disposition Smartping | Published | **not live** | 01/08/2026 | 0 / 0 | System |
| Cube lead call dispose API | Published | Published | 06/12/2025 | 27K (17 err) / 0 | Apoorva Goel |
| Client Code Referral ID MErge | Published | Published | 10/10/2024 | 0 / 3.7K | System |
| Referral ID Lead Owner Update | Published | Published | 09/23/2024 | — | System |
| Lapp 11 | **Draft** | — | — | — | System |
| Lapp 10 | — | — | — | — | System |
| Autodial for fresh leads | — | — | — | — | System |
| Dummy Lapp | — | — | — | — | System |
| Generate Activity against Opportunity | — | — | — | — | System |
| Cube opportunity call dispose API | Published | **not live** | 04/05/2023 | 0 / 0 | System |
| Slash RTC Auto Dial | — | — | — | — | System |
| Lead Call Dispose Lapp | — | — | — | — | System |
| Opportunity Call Dispose Lapp | — | — | — | — | System |
| Email Mapping to Alternate Email Address | — | — | — | — | System |

Available LAPP tooling: Create Lapp, Lapp Marketplace, Lapp Historical Usage
Report, SDK Developer Tokens, Plan Details. Per-LAPP actions: Edit, Unpublish
Test, Unpublish Live, API URL, View Logs, Export, Delete.

### LAPP findings
1. **Telephony auto-disposition is the dominant use case.** Five LAPPS
   (Auto disposition GSM, Auto Disposition Smartping, Cube lead/opportunity call
   dispose, Lead/Opportunity Call Dispose, Slash RTC Auto Dial) all exist to write
   call outcomes back onto records from different dialler vendors.
   → **The new CRM needs a single, vendor-neutral telephony/CTI event contract.**
   One ingestion endpoint, one normalised call-event schema, adapters per vendor —
   not five bespoke functions.
2. **"Dummy Lapp", "Lapp 10", "Lapp 11" (Draft)** — untracked scratch code in a
   production tenant.
3. **Test/Live drift**: `Auto Disposition Smartping` and
   `Cube opportunity call dispose API` are Published in Test but never promoted to
   Live. No visible deployment pipeline or approval gate.
4. **`Cube lead call dispose API`: 27,000 calls in 7 days with 17 errors** — a
   real production dependency with a ~0.06% error rate and no alerting evident.
5. **Ownership is "System" for 12 of 15** — the human author is unrecoverable.

## TELEPHONY VENDORS IN EVIDENCE
GSM Calling (team + `mx_GSM_Calling_Data` field), Smartping / SmartPing Test Team,
Slash RTC, "Cube", Kaleyra (SMS), R2Win Digital SMS, Zipteams (conversation
intelligence), Zoom (meetings/webinars), Converse (LSQ native chat).
Plus `Universal Telephony Connector` and `LeadSquared Generic Telephony Connector`.

**At least four telephony/dialler systems and three messaging vendors are wired in.**
This is the highest-risk integration area for migration and the strongest argument
for an abstraction layer in the new CRM.

## API & WEBHOOKS SETTINGS (structure only — no secrets recorded)
Settings > API and Webhooks > `/Settings/UserAccessKey` ("User Access Keys").
This screen holds live API access keys/secrets. **Deliberately not extracted.**
Before migration, inventory which integrations hold which keys, and rotate on cutover.

## PLATFORM EXTENSIBILITY SURFACE (what LSQ gives admins)
| Capability | Path | Notes |
|---|---|---|
| Automation (visual workflow) | /Automation | 8 trigger types; sub-automations |
| Process Designer | /ProcessDesigner | Guided multi-step processes |
| Forms | /Form | Lead capture + internal forms |
| Custom Field Sets | /Settings/CustomFieldSets | Grouped/repeating field structures |
| LAPPS | developerapp-in21… | Serverless custom code |
| Batch Jobs | /a/BatchJob | Scheduled bulk operations |
| Widgets | /a/Widget, /Widgets | Embeddable UI |
| Casa / HomeBuilder | /a/HomeBuilder | Custom home/landing pages in-app |
| Mavis | /a/Mavis | (LSQ AI/assistant module) |
| Marketplace connectors | /Apps/Marketplace | 149 available |
| REST API + Webhooks | /Settings/UserAccessKey | Key-based auth |

**Region/host note**: this tenant is on the India cluster.
App host `app-in21.leadsquared.com` (new UI) and `in21.leadsquared.com` (classic).
Developer/LAPP host `developerapp-in21.leadsquared.com`.
API host is region-specific — must be confirmed from the tenant, not assumed;
a wrong host returns 401 rather than 404.
