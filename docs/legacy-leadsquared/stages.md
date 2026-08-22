# Lead Stages (ProspectStage) — 32 active stages
Source: Settings > Leads > Lead Stages
Schema Name: `ProspectStage` | Display Name: "Lead Stage"
Properties available on the stage field: Enable Comments on Stage Change,
Is Mandatory, Include in Mail Merge, Show in Quick Add, Show in Import.
Stages are split into Active Stages / Inactive Stages lists.

## Active stages, in configured order
1. PROSPECT
2. CONTACT INFO SUBMITTED
3. PAN SUBMITTED
4. DIGILOCKER /KRA COMPLETED
5. PERSONAL INFO SUBMITTED
6. BANK INFO SUBMITTED
7. SIGNATURE UPDATED
8. SELFIE UPDATED
9. SEGMENT INFO SUBMITTED
10. DOCUMENTS UPLOADED
11. ESIGN DONE
12. UNDER OBJECTION
13. APPLICATION RESUBMITTED
14. ESIGN PENDING
15. APPLICATION VERIFIED
16. DIGILOCKER COMPLETED
17. ACCOUNT OPENED
18. READY TO TRADE
19. REOPEN ACCOUNT
20. CUSTOMER
21. NOT INTERESTED
22. INACTIVE (NO RESPONSE)
23. RELEVANT - NOT INTERESTED
24. ACCOUNT CLOSED
25. SHIFTING/REACTIVATION INITIATED
26. SHIFTING+REACTIVATION SUBMITTED
27. SHIFTING SUBMITTED
28. REACTIVATION SUBMITTED
29. PARTNER ESIGN DONE
30. PARTNER APPLICATION VERIFIED
31. ARN INFO SUBMITTED

## Analysis — this is the single most important structure in the tenant

The "Lead Stage" field is doing the work of **four different concepts at once**:

1. **A KYC/onboarding progress tracker** (stages 2-17): CONTACT INFO SUBMITTED →
   PAN SUBMITTED → DIGILOCKER/KRA → PERSONAL INFO → BANK INFO → SIGNATURE →
   SELFIE → SEGMENT INFO → DOCUMENTS → ESIGN → VERIFIED → ACCOUNT OPENED.
   This is a *multi-step form completion state*, not a sales stage.
2. **A customer lifecycle state** (PROSPECT, CUSTOMER, ACCOUNT CLOSED, REOPEN ACCOUNT).
3. **A disqualification reason** (NOT INTERESTED, RELEVANT - NOT INTERESTED,
   INACTIVE (NO RESPONSE)).
4. **A separate parallel journey for partners/distributors**
   (PARTNER ESIGN DONE, PARTNER APPLICATION VERIFIED, ARN INFO SUBMITTED) and
   for shifting/reactivation (4 more stages).

### Why this matters for the new CRM
A single enum cannot express "PAN submitted AND under objection AND is a partner".
Because the stage is one value, the tenant has had to compensate with dozens of
`mx_` boolean/date fields (mx_First_Dropoff_Application_Status, mx_KRA_status,
mx_Email_Verification, mx_Mobile_Verification, mx_DIY_Account_Opened,
mx_Ready_To_Trade, mx_Customer_Active_Status ...) that re-encode the same journey.

**Recommendation for the new CRM data model — split into orthogonal dimensions:**
- `lifecycle_stage` (Prospect / Applicant / Customer / Dormant / Closed) — small, stable enum
- `onboarding_application` — a **child entity** with its own status + per-step
  completion timestamps (pan_submitted_at, kra_completed_at, esign_at, ...),
  supporting multiple applications per person (equity, MF, partner, reactivation)
- `disqualification_reason` — separate nullable field, only set when disqualified
- `party_role` — a person can be Customer AND Partner simultaneously; model as roles,
  not as mutually exclusive stages
This one change removes a large share of the mx_ field sprawl documented in lead-fields.md.
