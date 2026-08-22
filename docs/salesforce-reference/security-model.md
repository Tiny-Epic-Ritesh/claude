# Salesforce Security & Access Model — verified from org

Salesforce answers "who can see what?" with **five composable layers** that
resolve in a defined order. This is the part of the platform most worth copying,
because LeadSquared's four overlapping mechanisms (Role / Permission Template /
Team / Sales Group) produce an unanswerable access question.

## THE LAYER STACK (most restrictive first, then progressively widened)

```
1. Organization-Wide Defaults (OWD)   ← the floor. Locks everything down.
2. Role Hierarchy                     ← managers inherit subordinates' access
3. Sharing Rules                      ← criteria-based or ownership-based widening
4. Manual Sharing / Teams             ← per-record, ad hoc
5. Profiles + Permission Sets         ← what you can DO (object + field + system)
```

**The mental model: OWD sets the baseline restriction; every other layer can only
GRANT more access, never take it away.** That single rule is what makes the model
reasonable to debug — you can always answer "why can this person see this?" by
walking the grant chain.

## 1. ORGANIZATION-WIDE DEFAULTS (actual values in this org)

| Object | Default Internal Access | Default External Access |
|---|---|---|
| **Lead** | Public Read/Write/Transfer | Private |
| **Account and Contract** | Public Read/Write | Private |
| **Contact** | Controlled by Parent | Controlled by Parent |
| **Order** | Controlled by Parent | Controlled by Parent |
| **Asset** | Controlled by Parent | Controlled by Parent |
| **Opportunity** | Public Read/Write | Private |
| **Case** | Public Read/Write/Transfer | Private |
| **Campaign** | Public Full Access | Private |
| **Campaign Member** | Controlled by Campaign | Controlled by Campaign |
| **User** | Public Read Only | Private |
| **Activity** | Private | Private |
| **Calendar** | Hide Details and Add Events | Hide Details and Add Events |
| **Price Book** | Use | Use |
| **Product** | Public Read/Write | Public Read/Write |
| **Individual** | Public Read/Write | Private |
| *(all other objects)* | Private | Private |

### The available OWD access levels
`Private` · `Public Read Only` · `Public Read/Write` ·
`Public Read/Write/Transfer` · `Public Full Access` · `Controlled by Parent` ·
`Use` (Price Book) · `Hide Details and Add Events` (Calendar)

### Design ideas worth stealing
- **Internal vs External access are separate columns.** Partner/customer-portal
  users get a different baseline than employees, declared once per object.
  Directly relevant: Bigul has partners/APs who need a genuinely different floor.
- **`Controlled by Parent`** — a child object can inherit its parent's access
  rather than declaring its own. Contact inherits Account; Order and Asset inherit
  their parent; Campaign Member inherits Campaign. This is how you avoid
  re-implementing access logic per child entity.
- **`Transfer` is a distinct right from Read/Write.** Reassigning ownership is
  modelled as its own permission — exactly the "can see" vs "manages" distinction
  that LeadSquared's manager-heavy Sales Groups fudge (12 managers, 1 user).
- **Activity is Private by default** even though Lead/Opportunity are public.
  Interaction history is treated as more sensitive than the record itself.

## 2. ROLE HIERARCHY
- A tree of roles; a user in a parent role inherits record access from users below.
- Per-object toggle: **"Grant Access Using Hierarchies"** — so you can disable
  upward inheritance for specific objects.
- Roles control **record visibility**, NOT feature permissions. That separation
  is the key idea: *Role = which records; Profile/PermSet = which capabilities.*

## 3. SHARING RULES
Configured per object (Lead Sharing Rules, Account Sharing Rules, Opportunity
Sharing Rules, Case Sharing Rules, …). Two flavours:
- **Owner-based** — records owned by members of group/role X are shared with Y
- **Criteria-based** — records WHERE field = value are shared with Y

> Currently "No sharing rules specified" in this org — it's a vanilla dev org.
> The *structure* is the reference, not the contents.

## 4. OTHER SHARING SETTINGS (org-level toggles observed)
- Manager Groups
- Secure guest user record access
- Require permission to view record names in lookup fields
- Test asynchronous sharing recalculation in Apex tests
- Grant access using hierarchies by default in new queues

## 5. PROFILES vs PERMISSION SETS vs PERMISSION SET GROUPS

Setup > Users exposes: **Profiles · Permission Sets · Permission Set Groups ·
Roles · Public Groups · Queues · Analytics Groups · User Management Settings**

| Construct | Cardinality | Purpose |
|---|---|---|
| **Profile** | exactly 1 per user | Baseline: object CRUD, field-level security, tab visibility, app access, login hours/IP, page layout assignment, record type assignment |
| **Permission Set** | many per user | Additive grants layered on top of the profile. Never subtracts. |
| **Permission Set Group** | many per user | A bundle of permission sets, with **muting** — the one place you can subtract |
| **Public Group** | many per user | A collection of users/roles/groups used as a *target* for sharing rules |
| **Queue** | many per user | An ownership target — records can be owned by a queue, users pull from it |
| **Role** | exactly 1 per user | Record visibility via hierarchy |

### Why this beats the LeadSquared model
- **One profile, many permission sets** is a clear rule. LeadSquared allows N
  permission templates with no stated precedence, so effective access is emergent.
- **Permission Set Groups with muting** give you composition *and* an escape hatch,
  without inventing a second mechanism.
- **Queues are an ownership target, not a login.** `Lead.OwnerId` is
  `Lookup(User,Group)` — polymorphic, so a record can be owned by a queue and
  individuals pull from it while staying individually authenticated.
  **This is the exact fix for LeadSquared's shared-login problem**
  (`bigulcaller17`, `Presales Common Id`), which destroys attribution today.
- **Public Group vs Queue vs Role are three different things** with three
  different jobs, instead of LeadSquared's Team/Sales Group overlap where a Team
  gets created purely as an ACL hack ("Smart View Access for Intent Leads").

## 6. FIELD-LEVEL SECURITY
- Set per profile/permission set, per field: **Visible** and **Read-Only**.
- Reachable two ways: from the field (Object Manager > Field Access) and from the
  profile. Also a dedicated **Field Accessibility** tool that shows the *computed*
  result per field across profiles — i.e. an answer to "who can actually see this?"
- **This is the "simulate access as user" capability** the LeadSquared audit
  identified as missing.

## 7. SECURITY / IDENTITY SURFACE (Security Controls, observed)
Health Check · Sharing Settings · Field Accessibility · Password Policies ·
Session Settings · Login Flows · Network Access · Activations · Session Management ·
Login Access Policies · Certificate and Key Management · **Single Sign-On Settings** ·
Auth Providers · Identity Provider · Identity Verification · **View Setup Audit Trail** ·
Expire All Passwords · **Delegated Administration** · Remote Site Settings ·
Trusted URLs · Named Credentials · File Upload and Download Security · CORS ·
OAuth Custom Scopes · OAuth and OpenID Connect Settings · Token Exchange Handlers ·
Event Monitoring · **Platform Encryption**

Two to highlight for the new CRM:
- **View Setup Audit Trail** — every configuration change is logged with who/when.
  LeadSquared has no equivalent, which is why admins date-stamp automation names.
- **Delegated Administration** — grant limited admin rights (e.g. reset passwords
  for one role's users) without full admin. Relevant for a 83-user, multi-branch org.
