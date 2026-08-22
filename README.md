# Bonanza AI CRM

Working prototype accompanying **BRD v5.0**. Three surfaces on one backend:

| Surface | URL | Who it is for |
|---|---|---|
| **Bonanza CRM** | `/` | 11 internal roles, each with its own cockpit |
| **DKYC portal** | `/dkyc` | Customers opening an account themselves — the published 16-step journey |
| **Partner portal** | `/portal` | Remisiers, Agents, Associates, Trainee Entrepreneurs |

Runs entirely offline. No API keys, no vendor accounts, no network access needed.

---

## Run it

```bash
npm run install:all   # first time only
npm run seed          # loads the demo dataset (safe to re-run)
npm run dev           # API on :4100, web on :5200
```

Then open **http://localhost:5200**.

Node 24+ is required — the database uses the built-in `node:sqlite`, so there is no
native module to compile.

---

## Sign in

Every CRM role has a one-click button on the sign-in screen. Password for all of them
is `bonanza`.

| Role | Email |
|---|---|
| Superadmin | `superadmin@bonanza.test` |
| Admin | `admin@bonanza.test` |
| Caller | `caller@bonanza.test` |
| Dealer | `dealer@bonanza.test` |
| Sales RM | `salesrm@bonanza.test` |
| Sales Supervisor | `salessupervisor@bonanza.test` |
| Partner RM | `partnerrm@bonanza.test` |
| Product RM (Mutual Funds) | `productrm@bonanza.test` |
| Product Supervisor | `productsupervisor@bonanza.test` |
| Customer Care | `care@bonanza.test` |
| Marketing Manager | `marketing@bonanza.test` |

**Partner portal:** `girish@partner.test` / `partner` (Associate) or
`lakshmi@partner.test` / `partner` (Remisier).

**DKYC portal:** no login. The OTP is always `123456`.

---

## Five-minute walkthrough

1. **Sign in as Caller.** The queue is ordered by what needs calling first. Open a lead →
   **Start call** → **End call** → pick the *"Complaint — payout not credited"* sample
   transcript → **Generate disposition**. Note the compliance flag it raises. Confirm, and
   see what it writes: activity, score, task, and a High-priority ticket.

2. **Try to exceed your permissions.** Still as Caller, edit the URL to open a lead owned by
   another RM — the API refuses. Open a product card and try to mark it Warm — refused, naming
   the capability required. Permissions are enforced server-side, not hidden client-side.

3. **Switch to Product RM.** Read-only by design. The cockpit shows their product across every
   lead *including the untouched ones* — that list is the cross-sell pipeline.

4. **Open the KYC console.** One journey is stalled, one abandoned. Ask **"Why stuck?"** on either.

5. **Open `/dkyc` in a new tab** and start an application. Use a bank account number ending in an
   **odd digit** to force the penny-drop failure path, and select **F&O** to trigger the
   conditional income-proof step.

6. **Sign in to `/portal`** and submit a referral. Return to the CRM as Sales RM and find it —
   attributed to the partner, product card already at Exploring.

---

## Switching the AI on

All six AI capabilities run against a deterministic offline provider by default, which is why
no key is needed.

```bash
# server/.env
ANTHROPIC_API_KEY=sk-ant-...
```

Restart the server and all six switch to a live model with no other change. The sidebar and
`/api/ai/status` report which provider is active.

The six capabilities: call summary and auto-disposition · 2-line ticket summary · next-best-action ·
KYC stall coaching · role-scoped cockpit copilot · partner health insight.

---

## Layout

```
server/src/
  db.js                 schema, domain constants, helpers
  auth.js               sessions + the permission matrix (the RBAC source of truth)
  integrations.js       11 adapters, all simulated, each documenting its real contract
  engine/
    kyc.js              16-step journeys, timers, stall → abandon, assisted completion
    sla.js              business-hours SLA, pause on Waiting on Client, breach sweep
    rules.js            IF/AND/THEN evaluation, actions, dry-run, lead scoring
  ai/
    prompts.js          prompts + JSON schemas (reviewable without reading code)
    mock.js             offline provider
    claude.js           live provider
    index.js            provider selection + role-scoped context builders
  routes/               crm · tickets · partners · kyc (+ public dkyc) · portal · admin · cockpit · ai

client/src/
  crm/                  cockpit, leads, in-call, tickets, partners, KYC console, admin
  dkyc/                 public 16-step portal
  portal/               partner portal
```

The cockpit is **one** component. The server returns each role's three zones (metrics, work list,
actions), so adding a role or changing a metric is configuration, not a new screen.

---

## Before any pilot

Two deliberate shortcuts make this a zero-setup evaluation build and disqualify it for real
customer data:

- **Passwords are stored in plain text** (`NFR-SEC-01`) — must move to Argon2id/bcrypt.
- **SQLite runs in-process** (`NFR-SCA-01`) — move to PostgreSQL; the schema is portable.

Both are the first items of pilot hardening in the BRD's P0 phase.
