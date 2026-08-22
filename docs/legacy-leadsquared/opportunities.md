# Opportunity Types — 35 configured pipelines
Source: Settings > Opportunities > Opportunity Types
Each Opportunity Type = its own pipeline with its own fields, forms and statuses.
Codes are tenant-assigned in the 12000-12058 band.

| Code | Opportunity Type | Description | Last modified by | Modified |
|---|---|---|---|---|
| 12000 | Customer (Other Products) | Any customer for Insurance, Mutual funds or bonds | Pritee Mahore | 09/16/2025 |
| 12001 | Bigul Customer | Any customer converted for Bigul | madhushree prabhu | 09/16/2025 |
| 12003 | Bigul Partner | All partners who refer clients for Bigul | — | 09/16/2025 |
| 12004 | Product Demo | Creating opportunity for scheduling Product Demo | Pritee Mahore | 09/16/2025 |
| 12005 | Bigul Algo Trading | — | Pritee Mahore | 09/16/2025 |
| 12006 | High Intent Trading-DIY Client | High Intent Trading-DIY Client | Vikrant Dale | 09/16/2025 |
| 12008 | C.S-Account Closure-Retention | Raised by Customer Support | System | 09/16/2025 |
| 12009 | C.S-.Required Trading Assistance | Raised by Customer Support | System | 09/16/2025 |
| 12011 | C.S-Subscription Plans | Raised by Customer Support | System | 09/16/2025 |
| 12012 | All Opportunities | — | Ritesh Thakur | 01/19/2026 |
| 12013 | C.S.-Bigul Algo Related | Raised by Customer Support | System | 09/16/2025 |
| 12019 | App Login But not Traded | — | System | 09/16/2025 |
| 12022 | Last Month And Not Traded | — | Ritesh Thakur | 05/26/2026 |
| 12023 | Dealer Support | — | Apoorva Goel | 10/31/2025 |
| 12025 | Last Month Traded and Not Traded | traded in last month and not traded in this month | Vikrant Dale | 09/16/2025 |
| 12027 | Activation - Presales | Activation - Presales | Manjushri Bajwa | 07/02/2026 |
| 12036 | Cross Sale RRT - 15 Days | — | Piyush Goyal | 01/02/2026 |
| 12037 | Sales Support Opportunity | Sales Support Opportunity | Ritesh Thakur | 06/02/2026 |
| 12038 | Dormant. | Dormant. | Pritee Mahore | 09/16/2025 |
| 12039 | Presales Opportunity | Presales Opportunity | Pritee Mahore | 09/16/2025 |
| 12040 | Activate B2B Partners | — | Himanshu Masurkar | 01/15/2026 |
| 12042 | IPO Support Opportunity | IPO Support Opportunity | Pritee Mahore | 09/16/2025 |
| 12043 | Brokerage is more than 100 but not Traded | (same) | Pritee Mahore | 09/16/2025 |
| 12044 | Zoom Webinar | — | Pritee Mahore | 09/16/2025 |
| 12045 | TJSB | Old Stratzy, TJSB NEW | Ritesh Thakur | 07/24/2026 |
| 12046 | Partner Opportunity | Partner Opportunity | System | 09/16/2025 |
| 12047 | Registered zoom webinar client opportunity | (same) | Pritee Mahore | 09/16/2025 |
| 12048 | Fund Collection | — | Vikrant Dale | 09/16/2025 |
| 12049 | Global Investments | Opportunity for Bigul-GI product. | Ritesh Thakur | 05/13/2026 |
| 12050 | Client Profiling | After E-sign is completed, used for client profiling for Algo & Non-algo products | Apoorva Goel | 11/12/2025 |
| 12051 | Client KYC Reactivation | — | Manjushri Bajwa | 01/13/2026 |
| 12054 | Mutual Fund | — | Himanshu Masurkar | 01/15/2026 |
| 12057 | MF App | Capture MF app logins for existing Equity users not ready to invest in MF | Ritesh Thakur | 03/16/2026 |
| 12058 | Quant Algo | Client interested in Quant Algo | Vikrant Dale | 05/07/2026 |
| — | ALNT / LM And NT / clientkycreativation / Demo / Bigul Customers / Bigul Partners / Bonanza Global Investments / QUANTALGO | nav aliases seen in menu; some are display-name variants of the above | | |

## Analysis — the Opportunity object is being used as a generic "work item"

35 pipelines is far beyond what "sales opportunity" means. Grouping them by what
they actually are:

**(a) Genuine sales opportunities** (a deal you can win or lose):
Bigul Customer, Customer (Other Products), Bigul Partner, Partner Opportunity,
Activate B2B Partners, Product Demo, Presales Opportunity, Global Investments,
Mutual Fund, Bigul Algo Trading, Quant Algo, TJSB

**(b) Customer-support tickets wearing an Opportunity costume**:
C.S-Account Closure-Retention, C.S-.Required Trading Assistance,
C.S-Subscription Plans, C.S.-Bigul Algo Related, Dealer Support,
Sales Support Opportunity, IPO Support Opportunity
→ These are *cases*, not deals. They have no value, no close date, no win/loss.

**(c) Campaign/segment membership modelled as a pipeline**:
App Login But not Traded, Last Month And Not Traded,
Last Month Traded and Not Traded, Brokerage is more than 100 but not Traded,
Dormant., Cross Sale RRT - 15 Days, High Intent Trading-DIY Client
→ These are *saved segments / triggered campaigns*. A record lands here because
it matched a rule, not because a human is pursuing a deal. Modelling them as
Opportunities inflates pipeline counts and corrupts every conversion metric.

**(d) Onboarding/process instances**:
Client Profiling, Client KYC Reactivation, Fund Collection, MF App

**(e) Event attendance**:
Zoom Webinar, Registered zoom webinar client opportunity

**(f) Meta/aggregate**: "All Opportunities" (12012) — a container type, not a pipeline.

### Recommendation for the new CRM
Split the single Opportunity concept into **four first-class entities**:
1. **Deal** — has value, stage, close date, win/loss reason, owner. Only category (a).
2. **Case / Ticket** — has priority, SLA, resolution, category. Category (b).
3. **Segment / Campaign membership** — computed, not stored as a record a human owns.
   Category (c) becomes saved queries + campaign enrolment, not pipeline rows.
4. **Process instance / Application** — onboarding, KYC, reactivation, fund collection.
   Category (d), with defined steps and per-step timestamps (see stages.md).

This is probably the single highest-leverage architectural decision in the rebuild:
it collapses 35 pipelines into ~4 entity types with configurable subtypes, and it
makes the funnel metrics trustworthy for the first time.

### Naming-hygiene observations
- "Dormant." has a trailing period; "TJSB" is described as "Old Stratzy, TJSB NEW".
- Near-duplicates: "Last Month And Not Traded" (12022) vs
  "Last Month Traded and Not Traded" (12025); "Zoom Webinar" (12044) vs
  "Registered zoom webinar client opportunity" (12047);
  "Partner Opportunity" (12046) vs "Bigul Partner" (12003) vs "Activate B2B Partners" (12040).
- Codes 12002, 12007, 12010, 12014-12018, 12020-12021, 12024, 12026, 12028-12035,
  12041, 12052-12053, 12055-12056 are absent → deleted types. Historic records may
  still reference them; a migration must handle orphaned type codes.
