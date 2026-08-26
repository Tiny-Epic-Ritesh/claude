# Migration map — LeadSquared to the Bonanza CRM

**Status: draft, written from the audit rather than from data.**
Every routing decision below is derived from `docs/legacy-leadsquared/`, which
records the field list, the automations and the UI surface as read from the live
tenant. What it does *not* record is how full each field is or what values it
actually holds — so the decisions marked **NEEDS DATA** are proposals, not
conclusions. See [What is still needed](#what-is-still-needed) at the end.

---

## The shape of the problem

| | Legacy | New | Change |
|---|---|---|---|
| Lead fields | ~330 (system + `mx_` custom) | 21 core + custom as configured | **−94% before custom fields** |
| Records | 495,118 leads | — | all of it |
| Users | 83 active | 27 seeded, no seat cap | — |

The 21 is not a target and not a cap. It is what remains once four things stop
being fields:

1. **Computed values become Formula and Roll-Up fields.** `mx_Activity_Score`,
   `mx_Recency_Rating`, `mx_Frequency_Rating`, `mx_Monetary_rating`,
   `mx_ConnectedAttempts`, `mx_Talk_Time_duration` and about thirty siblings are
   all derivable from the interaction timeline. They do not migrate; they are
   defined once and computed on read.
2. **Repeating values become child records.** Six `mx_Client_Code_*` columns are
   a one-to-many relationship written sideways.
3. **Stamped dates become field history.** Every `*_Date` that exists only
   because an automation wrote it is answered by `field_history` instead.
4. **Vendor telemetry stops living on the lead.** Trading activity, holdings and
   brokerage belong in the systems that own them, read when needed.

---

## Routing by domain

Each group below says where it goes and why. **Carry** means the data moves.
**Derive** means the new CRM computes it and the legacy values are discarded.
**Drop** means it does not come across at all.

### Identity — CARRY

| Legacy | Destination | Note |
|---|---|---|
| `FirstName`, `LastName` | `leads.name` | Joined. The split bought nothing and cost every screen a concatenation. |
| `EmailAddress` | `leads.email` | |
| `Mobile`, `Phone` | `leads.mobile` | **NEEDS DATA** — which is authoritative when they disagree, and how often they do. |
| `mx_PAN_Number` | `leads.pan` | Re-encrypted under the new master key on load. Never migrated in plaintext. |
| `mx_Date_of_Birth`, `mx_Gender`, `mx_Father_Name`, `mx_Marital_Status` | custom fields on `lead` | KYC-required, so they earn their place. |
| `mx_Politically_Exposed_Person` | custom field, `checkbox` | Regulatory. Must not be lost. |
| `ProspectAutoId` | custom field `legacy_id`, indexed | **Keep permanently.** Every support conversation for the next two years will quote it. |

### Client codes — CARRY, RESHAPED

`mx_Client_Code`, `_2` … `_6`, `mx_Submit_Client_Code`, `mx_Client_BOID`,
`mx_Terminal_Code`, `mx_DOT_Code`, `mx_BA_Code` → **a `client_codes` child table**.

Six numbered columns is a one-to-many relationship someone flattened because the
platform made a child object expensive. A client with seven codes silently loses
one today.

> **NEEDS DATA** — how many leads use `_4`, `_5`, `_6` at all. If the real
> maximum is two, this is over-engineering and two columns will do.

### Consent — CARRY, AND IT MATTERS

| Legacy | Destination |
|---|---|
| `DoNotCall` | `leads.mobile_invalid` is *not* the same thing — needs its own field |
| `DoNotEmail`, `DoNotSMS`, `DoNotTrack` | per-channel consent |
| `CurrentOptInStatus`, `OptInDate`, `OptInDetails` | consent record with provenance |
| `MailingPreferences` | **NEEDS DATA** — free text or a controlled list? |

The new CRM has `marketing_opt_out` as a single flag. Legacy has **four
independent do-not flags plus an opt-in status with a date and a reason**. That
is richer, and it is richer in the direction regulators care about.

> **This is the highest-risk group in the migration.** Collapsing four channel
> flags into one boolean either over-blocks (losing contactability the client
> never withdrew) or under-blocks (contacting someone who said stop on that
> channel). Under TRAI DND rules the second is the one with a penalty attached.
>
> **Recommendation:** widen the new schema to per-channel consent *before*
> cutover rather than lossily collapsing on the way in. This is a small schema
> change now and an unwinnable data-recovery problem later.

### Dispositions — CARRY THE LATEST, DERIVE THE REST

Legacy holds roughly 30 disposition-shaped fields on the lead:
`mx_Disposition`, `mx_Sub_Disposition`, `mx_Sub_disposition_2`,
`mx_Contacted_Disposition`, `mx_Phone_call_disposition_2`,
`mx_Phone_call_subdisposition`, `mx_AI_Disposition_Status`,
`mx_Telecaller_Calling_Status`, `mx_Dealer_Calling`, and counters
`mx_ConnectedAttempts`, `mx_Not_Connected_Attempts`, `mx_First_Attempt`,
`mx_Last_Attempts`, `mx_Number_of_Follow_Up`, `mx_Number_of_No_Response`,
`mx_Talk_Time_duration`…

**All of it is the interaction timeline, denormalised onto the parent.**

- The **latest** disposition → the most recent `activities` row, so history is preserved
- Every **counter** → Roll-Up field over `activities` — already supported
- Every **"last X date"** → derived, not stored

> **NEEDS DATA** — the distinct values in `mx_Disposition` and
> `mx_Sub_Disposition`, with counts. The new disposition matrix has 22 entries;
> if legacy has 60 in active use, the matrix needs extending or the extras need
> an explicit mapping. **This is the single most valuable thing the export can
> tell us**, because dispositions drive the follow-up engine.

### Trading activity, holdings, brokerage — DO NOT MIGRATE

`mx_Equity_active`, `mx_Derivatives_active`, `mx_MF_active`, `mx_FO_*_Active`,
`mx_Segments`, `mx_First_Traded_Date`, `mx_Last_Traded_Date`,
`mx_Trades_Placed_Last_1_Year`, `mx_Trades_Placed_Yesterday`,
`mx_ISIN_COUNT`, `mx_HOLDING_VALUE`, `mx_Total_Holding_Value`,
`mx_Brokerage_*`, `mx_Ledger_Balance`, `mx_Current_Margin`, `mx_Total_margin`,
`mx_Today_Payin`, `mx_Payment_*`, `mx_Collateral` — **roughly 40 fields.**

None of this originates in the CRM. It is a nightly copy of the trading and back
office systems, and a copy is stale the moment it is written. The CRM already
treats AUM this way — a projection, not a column.

**Instead:** an integration contract that reads it when a screen needs it, in the
shape `engine/metrics.js` already uses.

> This is the largest single reduction — about 40 fields — and the one most
> likely to be argued about, because people are used to filtering on them.
> Segments answer that: a live query against the trading feed, not a stale
> column.

### Scores and ratings — DERIVE

`Score`, `EngagementScore`, `QualityScore01`, `mx_Activity_Score`,
`mx_Intent_Score`, `mx_Recency_Rating`, `mx_Frequency_Rating`,
`mx_Monetary_rating`, `mx_Call_Quality_Score`, `mx_Lead_Status`.

The new CRM already computes score from a versioned model in `score_models`,
with `explainScore()` answering "why 72?". Legacy scores do not migrate — they
would be immediately contradicted by the projection.

**Carry one thing:** the legacy `Score` into a custom field `legacy_score`,
read-only, for the first quarter. Reps who have built intuition around the old
number deserve to see it while they calibrate against the new one, and it costs
one column to keep the transition honest.

### Ownership — CARRY, RESHAPED

`OwnerId` → `leads.owner_id`. But `mx_RM_Name`, `mx_RM_Email`, `mx_RM_Code_New`,
`mx1_RM_Code`, `mx_RM_Mobile_Number`, `mx_Team_Leader`, `mx_Opportunity_Owner`,
`mx_Cross_Sale_Team_Owner`, `mx_From_Owner`, `mx_To_Owner`, `mx_Partner_RM` are
**a foreign key written out longhand, eleven times.**

They become one `owner_id` plus the reassignment trail in `field_history`, which
already tracks owner changes.

> Note `mx1_RM_Code` — an inconsistent prefix that cannot be renamed because
> integrations bind to it. Exactly what label/API-name separation prevents.

### Partner and channel — CARRY

`mx_Partner_Code`, `mx_Partner_DOT_Code`, `mx_Referral_Id`, `mx_Referrer_Name`
→ `leads.partner_id` plus fields on `partners`.

> **NEEDS DATA** — whether `mx_Partner_Code` reliably resolves to a partner
> record. Attribution decides commission; an unresolvable code is money routed
> to nobody, and the audit already flagged partner-code mismatches as a live
> problem.

### Marketing attribution — CARRY A SUBSET

Roughly 25 fields: `SourceCampaign`, `SourceMedium`, `SourceContent`,
`mx_Latest_Campaign/Content/Medium/Source/Term`, `mx_utm_*`, `mx_af_adset`,
`mx_Appsflyer_*`, `mx_Path_to_Conversion`, `mx_Path_to_Conversion2`.

Both a *first-touch* and a *latest-touch* set exist. That is a real distinction
and worth keeping — but as **two structured attribution records**, not
twenty-five columns.

> **NEEDS DATA** — fill rates. The AppsFlyer and `utm_af*` fields look like one
> campaign's residue. If they are under 1% full they are archaeology, not data.

### Survey, CSAT and Zipteams — DROP FROM THE LEAD

`mx_Trading_Experience`, `mx_Execution_Style`, `mx_Market_Knowledge`,
`mx_How_do_you_primarily_execute_your_trades`, all `mx_Rate_the_*`,
all seven `mx_Zipteams_*` — roughly 30 fields.

These are **survey responses**, which is to say interactions with a date and a
context. On the lead they are a single overwritten answer with no record of when
it was given or which survey asked.

They become interaction records of type `Survey`. The latest answer stays
reachable through a Roll-Up (`latest` aggregate) if a screen wants it.

> `mx_Zipteams_*` additionally depends on a third-party integration. **NEEDS
> DATA** — is Zipteams still in use? If not, this is 7 fields of a dead vendor.

### Test and junk — DROP

`mx_test`, `mx_test_field`, `mx_or`, `mx_ASC` — four test fields **live in
production**. They do not come across, and the new CRM's purpose-required gate on
field creation is there so this cannot recur.

`mx_Subscription_End_dtae` and `mx_Presales_Initial_Margin_Commitmnt` are typos
frozen into the schema because label and API name were the same thing. The data
carries over under corrected labels; the misspelled API names die here.

---

## Cutover sequence

1. **Freeze legacy field creation.** No new `mx_` fields from the day mapping starts. Every one added mid-migration is a mapping that has to be redone.
2. **Pull the data-quality export** (below) and turn every **NEEDS DATA** above into a decision.
3. **Widen consent to per-channel** before any data moves. The only item that must change the new schema first.
4. **Load reference data** — users, roles, partners, products, dispositions. Nothing lead-shaped yet.
5. **Dry-run 1,000 leads** into a copy. Compare field by field against source. Fix, repeat.
6. **Load leads and interactions.** Interactions are the bulk — roughly 30 lead columns collapse into timeline rows.
7. **Rebuild projections.** `lead_metrics`, roll-ups, scores. Nothing computed is imported.
8. **Reconcile.** Row counts, consent flags, partner attribution, client codes. Sign off per domain.
9. **Parallel run.** Both systems live, legacy read-only for a period.

## Cutover risks, ranked

| Risk | Consequence | Mitigation |
|---|---|---|
| Consent collapsed lossily | Contacting someone who withdrew consent on that channel — TRAI penalty | Per-channel consent before cutover. Non-negotiable. |
| PAN re-encryption | Unreadable identity data on 495k records | Re-encrypt on load under the new master key. Verify a sample before the bulk run. Never migrate plaintext. |
| Disposition mapping gaps | The follow-up engine silently does nothing for unmapped outcomes | Distinct-value export. Map every value or fail the load loudly. |
| Partner code mismatch | Commission routed to the wrong partner or nobody | Resolve every code to a partner before load; a report of unresolvable ones. |
| Losing `ProspectAutoId` | Support cannot find records customers quote | Carry as indexed `legacy_id`, permanently. |
| Trading telemetry "missing" | Users think data was lost | Segments over the live feed, demonstrated before cutover, not after. |

---

## What is still needed

One export from LeadSquared, and it is **aggregates only — no client rows leave
the tenant**:

1. **Per field, across all ~330:** fill rate (% non-null) and distinct-value count.
2. **For every picklist-shaped field**, the distinct values with counts. Most important: `mx_Disposition`, `mx_Sub_Disposition`, `mx_Lead_Status`, `mx_Lead_Type`, `mx_Non_Contactable_Reason`, `mx_Not_Interested_Reason`, `mx_Rejection_Reason`.
3. **Consent fields specifically:** how many leads carry each of `DoNotCall`, `DoNotEmail`, `DoNotSMS`, and the distribution of `CurrentOptInStatus`.
4. **Client codes:** how many leads populate `_2` through `_6`.
5. **Partner codes:** distinct `mx_Partner_Code` values and how many resolve to a known partner.

With those five, every **NEEDS DATA** above closes and this becomes a build
specification rather than a proposal.

### What can proceed without it

The consent widening (item 3 in the sequence) is a schema change justified by
the audit alone — legacy has four channel flags, the new CRM has one, and that
gap is visible without a single row of data. That work does not need the export
and is on the critical path for everything else.
