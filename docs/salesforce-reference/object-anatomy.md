# Salesforce Object Anatomy — verified from org

## PER-OBJECT CONFIGURATION CATEGORIES (Object Manager > Opportunity)

Every object in Salesforce exposes the SAME 19 configuration surfaces.
This uniformity is the single most important structural idea to copy:
**one object model, one configuration contract, applied identically to
standard and custom objects.**

| # | Category | What it controls |
|---|---|---|
| 1 | **Details** | Object-level settings: label, plural, API name, description, feature toggles (reports, activities, field history, search, sharing) |
| 2 | **Fields & Relationships** | The schema. Field label, API name, data type, controlling field, indexed flag |
| 3 | **Page Layouts** | Classic record layout: field arrangement, sections, related lists, buttons |
| 4 | **Lightning Record Pages** | Modern component-based record page (App Builder) |
| 5 | **Buttons, Links, and Actions** | Custom actions available on the record |
| 6 | **Compact Layouts** | The condensed field set shown in highlights panel / mobile |
| 7 | **Field Sets** | Named, reusable groupings of fields for programmatic use |
| 8 | **Object Limits** | Governor limits consumed vs available for this object |
| 9 | **Record Types** | Multiple business processes/layouts/picklist subsets on ONE object |
| 10 | **Related Lookup Filters** | Constrain which related records a lookup may select |
| 11 | **Search Layouts** | Which columns appear in search results, lookups, list views |
| 12 | **List View Button Layout** | Which buttons appear on list views |
| 13 | **Scoping Rules** | Narrow the record set a user sees by default (without changing access) |
| 14 | **Object Access** | Per-profile CRUD matrix for this object |
| 15 | **Field Access** | Per-profile field-level visibility/editability |
| 16 | **Triggers** | Apex triggers on this object |
| 17 | **Flow Triggers** | Record-triggered flows on this object |
| 18 | **Validation Rules** | Declarative constraints enforced on save |
| 19 | **Conditional Field Formatting** | Conditional display formatting |

### Why this matters for the new CRM
LeadSquared has none of this uniformity: Leads have one config surface,
Opportunities another, Activities another, and Custom Objects a fourth.
Salesforce's insight is that **every entity gets the same 19 levers**, so an
admin who learns one object can configure any object — and a developer builds
the configuration UI once, generically, rather than per entity.

---

## STANDARD OPPORTUNITY FIELDS (as shipped, verified)

| Field Label | API Name | Data Type | Indexed |
|---|---|---|---|
| Account Name | `AccountId` | Lookup(Account) | Yes |
| Amount | `Amount` | Currency(16,2) | No |
| Close Date | `CloseDate` | Date | Yes |
| Contract | `ContractId` | Lookup(Contract) | Yes |
| Created By | `CreatedById` | Lookup(User) | No |
| Current Generator(s) | `CurrentGenerators__c` | Text(100) | No |
| Delivery/Installation Status | `DeliveryInstallationStatus__c` | Picklist | No |
| Forecast Category | `ForecastCategoryName` | Picklist | No |
| Last Modified By | `LastModifiedById` | Lookup(User) | No |
| Lead Source | `LeadSource` | Picklist | No |
| Main Competitor(s) | `MainCompetitors__c` | Text(100) | No |
| Next Step | `NextStep` | Text(255) | No |
| Opportunity Name | `Name` | Text(120) | Yes |
| Opportunity Owner | `OwnerId` | Lookup(User) | Yes |
| Opportunity Score | `IqScore` | Number(9,0) | No |
| Order Number | `OrderNumber__c` | Text(8) | No |
| Price Book | `Pricebook2Id` | Lookup(Price Book) | Yes |
| Primary Campaign Source | `CampaignId` | Lookup(Campaign) | Yes |
| Private | `IsPrivate` | Checkbox | No |
| Probability (%) | `Probability` | Percent(3,0) | No |
| Quantity | `TotalOpportunityQuantity` | Number(16,2) | No |
| Stage | `StageName` | Picklist | No |
| Tracking Number | `TrackingNumber__c` | Text(12) | No |
| Type | `Type` | Picklist | No |

### Observations that matter

1. **A standard Opportunity ships with ~26 fields, not 338.**
   The platform gives you a deliberately small, well-chosen core and expects you
   to extend. Compare LeadSquared's Lead at 338 fields — the difference is a
   governance culture, not a technical limit.

2. **`__c` suffix marks custom fields, unambiguously.**
   `CurrentGenerators__c` vs `Amount`. You can tell at a glance, in any context —
   API response, formula, report — whether a field is platform or org-specific.
   This is a naming *contract*, not a convention. LeadSquared's `mx_` prefix
   attempts the same thing but is inconsistently applied (`mx1_RM_Code`).

3. **Data types carry precision in the type itself**: `Currency(16,2)`,
   `Text(120)`, `Percent(3,0)`, `Number(9,0)`. Length/scale is part of the
   declared type, not a separate validation.

4. **Relationships are typed, not stringly-typed**: `Lookup(Account)`,
   `Lookup(User)`, `Lookup(Price Book)`. The target object is part of the field
   definition, so referential integrity is structural. LeadSquared stores
   `mx_RM_Name` as free text — the same concept with no integrity.

5. **`Indexed` is surfaced to the admin.** Query performance is a visible,
   managed property of the schema, not a hidden DBA concern.

6. **`Probability` + `Forecast Category` + `Stage` are separate fields.**
   Stage drives probability and forecast category by default, but they remain
   independently addressable. Contrast LeadSquared cramming four concepts into
   one `ProspectStage` enum.

7. **`IsPrivate` on the record itself** — record-level privacy is a first-class
   field, not a permission workaround.
