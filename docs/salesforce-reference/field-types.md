# Salesforce Field Type System — verified from New Custom Field wizard

The complete data-type palette an admin can choose from. Note it is grouped:
**derived types**, then **relationship types**, then **primitive types**.

## DERIVED / COMPUTED TYPES (read-only, system-maintained)

| Type | Behaviour |
|---|---|
| **Auto Number** | System-generated sequence using a display format you define. Auto-increments per record. |
| **Formula** | Read-only, derives value from a formula expression. Recalculates when any source field changes. |
| **Roll-Up Summary** | Read-only. SUM / MIN / MAX of a field on a related list, or COUNT of related records. |

> **This is finding #3 and #4 from the LeadSquared audit, solved at the platform
> level.** LeadSquared has no computed fields, so `Activity Score` (8.0M automation
> triggers) and every `mx_*_Count` / `mx_*_Attempts` counter must be maintained by
> automation writing to a stored field. Salesforce makes "derived value" a *field
> type*. The new CRM must have Formula and Roll-Up equivalents — they delete an
> entire category of automation.

## RELATIONSHIP TYPES

| Type | Behaviour |
|---|---|
| **Lookup Relationship** | Links this object to another object. Loosely coupled — child survives parent deletion. |
| **External Lookup Relationship** | Links to an *external object* whose data lives outside Salesforce. |
| *(Master-Detail)* | Available on custom objects: tightly coupled, cascade delete, child inherits parent sharing, enables roll-up summaries. Not offered on Lead because Lead cannot be a detail. |

> Relationships are **typed and declared**, e.g. `Lookup(Account)`,
> `Lookup(User,Group)`. The target object is part of the field definition.
> Contrast LeadSquared's `mx_RM_Name` — the same relationship stored as free text.

## PRIMITIVE TYPES

| Type | Behaviour / limit |
|---|---|
| **Checkbox** | True/False. |
| **Currency** | Currency amount, auto-formatted. Precision/scale declared, e.g. Currency(16,2). |
| **Date** | Date with date picker. |
| **Date/Time** | Date + time. |
| **Email** | Validated for email format. Wired into "Send an Email" on Lead/Contact. |
| **Geolocation** | Compound: latitude + longitude. Supports distance calculation. |
| **Number** | Any number; leading zeros stripped. Precision/scale declared. |
| **Percent** | Percentage. Precision/scale declared, e.g. Percent(3,0). |
| **Phone** | Phone number. |
| **Picklist** | Single-select from a defined value set. |
| **Picklist (Multi-Select)** | Multi-select from a defined value set. |
| **Text** | Letters and numbers, single line. Length declared, e.g. Text(120). |
| **Text Area** | Up to 255 chars, multi-line. |
| **Text Area (Long)** | Up to 131,072 chars. |
| **Text Area (Rich)** | Formatted text, images, links. Up to 131,072 chars. |
| **Text (Encrypted)** | Stored encrypted at rest. |
| **Time** | Local time only. |
| **URL** | Validated website address; opens in new window. |

## COMPOUND TYPES (standard fields only, not creatable)
Observed on Lead:
- **Name** — a single logical field composed of `Salutation` + `FirstName` + `LastName`,
  addressable both as the compound `Name` and as its components.
- **Address** — compound of street/city/state/postal/country/geocode.
- **Geolocation** — latitude + longitude.

> Compound fields let the platform present one concept to the user while keeping
> queryable components underneath. LeadSquared has `mx_Street1`, `mx_Street2`,
> `mx_City`, `mx_State`, `mx_Country`, `mx_Zip` as six unrelated text fields.

## FIELD-LEVEL PROPERTIES (beyond type)
Visible in the field list and field detail:
- **Field Label** (user-facing) vs **Field Name / API Name** (`__c` suffix for custom) — decoupled, so renaming a label never breaks integrations
- **Data Type** with declared precision/length
- **Controlling Field** — for dependent picklists
- **Indexed** — surfaced to the admin as a managed property
- Required, Unique, External ID, Default Value, Help Text, Description
- Field History Tracking (per field, toggled at object level via "Set History Tracking")

## KEY STRUCTURAL IDEAS TO COPY

1. **Label ≠ API name.** Two separate identifiers per field. Business users rename
   labels freely; integrations bind to the immutable API name. This directly solves
   LeadSquared's permanent-typo problem (`mx_Subscription_End_dtae` can never be fixed).
2. **`__c` suffix is a contract**, not a convention — custom vs standard is
   unambiguous everywhere: API, formulas, reports, code.
3. **Precision is part of the type**, not a separate validation rule.
4. **Derived values are a field type**, not an automation job.
5. **Dependent picklists are declared via a Controlling Field on the field itself** —
   see "Field Dependencies" in the Fields & Relationships toolbar. LeadSquared has
   this capability and uses it **zero times**; here it's a first-class column in
   the field list, so its absence is visible.
6. **Encrypted text is a type**, so PII protection is a schema decision, not an
   application-layer afterthought — relevant for PAN/bank data in a broking CRM.
