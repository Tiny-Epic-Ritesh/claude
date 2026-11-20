# A6 · The pilot gates, with evidence

The BRD makes ten things **pilot gates**: conditions the CRM must meet before the pilot starts. The Round 4 auditor could not check them from a browser and asked for "implementation evidence and automated tests for each" (Round 4 report §1, and §6 step 9).

For each gate, this document says:

- what is asked
- how the CRM does it, and where in the code
- what the automated test proves
- what was found and fixed on the way
- what still has to be shown on the pilot's own infrastructure

The test is `server/test/pilotgates.test.mjs`. It is part of `npm run test:unit`. To run it alone, against a running server:

```bash
cd server && node test/pilotgates.test.mjs
```

**Order, ruled 20 Nov 2026.** The seven gates that are code come first (G1–G7, done). Then the load test and sizing, then the move to PostgreSQL (B7). Then the database, response-time and availability gates (G8–G10), measured on PostgreSQL.

**Targets, ruled 20 Nov 2026** (the BRD's own figures were not to hand):

- p95 ≤ 1 second for any screen's request, with all 83 users at once on production-size data (495,118 leads)
- 99.5% monthly availability in business hours

**Where the pilot's PostgreSQL runs is not decided.** The evidence that depends on it (the region of the database, backups, master key and logs) is marked **On deployment** below.

## Where each gate stands

| Gate | Status | Test (checks) | Fixed on the way | Still to show on the pilot's infrastructure |
|---|---|---|---|---|
| **G1** Credential hashing | **Met** | pilotgates G1 (9); `passwords` (20); `keyscopes` | OPS-80, OPS-81 | The master key held in a KMS in an India region |
| **G2** Session expiry and revocation | **Met** | pilotgates G2 (10); `partneraccess`; `ghost` | OPS-82 | HTTPS only, at the load balancer |
| **G3** Server-side authorisation | **Met** | pilotgates G3 (4); `rolematrix`; `bookscope`; `bookscopewrites` | OPS-83 | None |
| **G4** Partner isolation | **Met** | pilotgates G4 (3); `rolematrix` (3 partner checks) | None | None |
| **G5** KYC documents and retention | **Met for what the CRM holds.** Documents live in the eKYC portal (ruled) | pilotgates G5 (2); `purge` | None | The eKYC portal's own evidence. The pilot set to `handoff` mode. Compliance to confirm the retention periods |
| **G6** Consent and DND | **Met.** The national DND register is screened by the carriers (ruled) | pilotgates G6 (4); `consent` tests | None | DLT registration of headers and templates. The dialler's DND screening confirmed by CUBE |
| **G7** India residency | **Met in code.** The data at rest waits on hosting | pilotgates G7 (2); `deidentify` | OPS-84 | The region of the database, backups, KMS and logs. Each vendor's data location confirmed |
| **G8** The pilot database | Next | Not yet | Not yet | The load test and sizing first |
| **G9** Response time | Next | Not yet | Not yet | Measured on PostgreSQL |
| **G10** Availability | Next | Not yet | Not yet | Depends on the hosting |

---

## G1 · Credential hashing

**Asked.** No password or other credential is stored in a form that can be used if the database is read.

**How.**

- **Staff and partner portal passwords** are hashed with scrypt at the OWASP floor: N = 2^17, r = 8, p = 1, a 64-byte key and a random salt (`server/src/security.js`).
  - Verification compares in constant time.
  - A hash made at a weaker cost is upgraded the next time its owner signs in.
  - A stored value that isn't an scrypt hash never authenticates.
  - On every start, any old plaintext is hashed in place.
- **Production refuses to start in two cases:** with the test suite's lowered password cost (`CRM_SCRYPT_N`), or without its own master key (`CRM_MASTER_KEY`).
- **API secrets** are kept as a SHA-256 (`engine/apikeys.js`).
- **Bearer tokens (OPS-80, fixed 20 Nov).** Sign-in sessions, password reset links and KYC resume links were stored exactly as issued. Anyone who could read the database, or a backup of it, could use a live one.
  - Sessions and reset links are now kept as the SHA-256 of their token (`security.js tokenKey`), and looked up by it.
  - A KYC resume link is found by that hash (`kyc_journeys.resume_key`) and kept encrypted besides, because staff open it again for an applicant (OPS-67).
  - Old rows are converted in place on the next start, so nobody is signed out and no link breaks.
- **Webhook signing secrets (OPS-81, fixed 20 Nov)** were stored in plain text. They are now encrypted with the master key, as vendor credentials already were, and decrypted only to sign a delivery.
- **Field encryption.** PAN, the KYC application and vendor credentials are encrypted with AES-256-GCM under the master key.

**What the test proves.**

- Every stored password is an scrypt hash.
- A new password, hashed where the cost isn't lowered, is at the OWASP floor.
- Production refuses to start with a lowered cost or the development master key.
- An API secret, a session, a reset link and a KYC resume link are kept hashed. The token works and the stored value doesn't.
- Staff can still open an applicant's link.
- A webhook secret is stored encrypted, and deliveries are still signed with the real one.
- Old rows are converted in place with nobody signed out, and a second pass changes nothing.

**On deployment.** `CRM_MASTER_KEY` should come from a KMS key created in an India region, so the key never leaves the country with the data.

## G2 · Session expiry and revocation

**Asked.** Sessions expire, and can be ended.

**How.**

- **Expiry.** A session lasts 12 hours at most and ends after 120 idle minutes (`SESSION_TTL_HOURS`, `SESSION_IDLE_MINUTES`). Both are checked on every request, and an expired session is removed.
- **What ends a session early:**
  - signing out
  - an Admin setting a new password (every session of that person)
  - a password reset by link (every session; the link works once)
  - deactivation (refused at once, and the sessions are removed)
  - a partner's new portal password (their other sessions)
  - a partner's portal access withdrawn, or a partner suspended or terminated (every session)
- **A change of role** applies on the very next request.
- **OPS-82 (fixed 20 Nov).** A partner's session was not re-checked against the partner's state. Every route that suspends a partner ends their sessions, so there was no hole; but a future route that forgot would have left one open. A partner who is no longer Active or Onboarding is now refused on their next request, as sign-in refuses them.

**What the test proves.** Each of the above, through the API.

**On deployment.** The CRM is served over HTTPS only. The proxy terminates TLS, and API keys are already refused over plain HTTP.

## G3 · Server-side authorisation

**Asked.** Every request is authorised on the server. The screen is a convenience, never the control.

**How.** Each request is checked in this order:

1. A session or an API key.
2. The role's capability (`requirePermission`), with a refusal that names the missing permission.
3. The record's business (`loadInBook`).
4. The reader's own scope on the record (`reqScope`, `reqTicketScope`).

An API key acts only within its scopes. Field security and masking follow the role.

**What the test proves.**

- **A sweep of every route in the server, 535 of them, with no session.** Each refuses with 401 except the 15 that are public by design. Each of those is listed in the test with its reason:
  - the public KYC journey, whose resume link is the credential
  - the reset link
  - sign-out
  - health
  - the app's own files
  - public market indices
  - Meta's signed webhook

  A new route that answers without a session fails the sweep until someone lists it, with a reason.
- A role is refused what its capabilities don't allow, and the refusal names the permission.
- A record of the other business is refused by the boundary itself, even to an Admin.

The existing conformance tests carry the rest:

- `rolematrix`: every role's guard, in both businesses
- `bookscope`: every read route refuses the other business
- `bookscopewrites`: every write route refuses the other business, by the boundary rather than a missing permission

**OPS-83 (fixed 20 Nov).** While Meta isn't connected, an unsigned delivery to `/api/webhooks/meta` was accepted, and the simulator made a lead from whatever id it named. Anyone could have filled the CRM with leads and messages. It is refused in production now, as the QuickCall, WhatsApp and eKYC webhooks already refuse until their secrets are set. The development simulator is unchanged.

## G4 · Partner isolation

**Asked.** A partner sees only their own records, and nothing of the CRM.

**How.** The portal has its own sign-in and its own routes (`routes/portal.js`). Every portal query is matched to the signed-in partner's id. A partner's session admits no CRM route, and a staff session admits no portal route.

**What the test proves.**

- A partner's session reaches no CRM route.
- A staff session reaches no portal route.
- A partner sees their own referral and case, and never another partner's. Each is opened directly, and absent from their dashboard.

`rolematrix` checks the same across both businesses and every portal route.

## G5 · KYC documents and retention

**Asked.** KYC documents are encrypted and kept for the right time.

**Ruled 20 Nov 2026:**

- **Where documents live.** The pilot's KYC documents live in Bonanza's eKYC portal (`kyc.bonanzaonline.com`), the regulatory system of record. The CRM runs KYC in `handoff` mode: it sends the applicant to the portal, follows the status, and holds no document file.
- **Retention.** As now, written up here for Compliance to confirm or change.

**How.**

- The CRM's own journey takes no files. Its upload fields are a placeholder that records a name; nothing leaves the applicant's device.
- What the CRM does hold of an application is encrypted at rest as one blob: address, PAN, bank details, nominees and document references (`engine/kyc.js`). The resume link is protected as described under G1.

**Retention as it stands:**

- A client's KYC application is never erased.
- An applicant who never became a client loses theirs only with their lead. The retention purge erases a lead that:
  - was deleted, and
  - has been untouched for 3 years, and
  - never had an account, and
  - has no case naming it.

  Its KYC application goes with it, PAN, bank and address included (`engine/retention.js`, `retention.lead_years`).

**What the test proves.**

- An application's answers are encrypted at rest: no PAN, account number or address is readable in the table.
- The KYC page and engine never read, send or write a file.

**On deployment.**

- Set the KYC mode to `handoff` for the pilot.
- Obtain the eKYC portal's own evidence for document encryption and retention.
- **Compliance to confirm the retention periods:** how long a closed client's KYC must be kept (PMLA and SEBI), and whether an applicant who never became a client should be erased sooner (the DPDP Act).

## G6 · Consent and DND

**Asked.** No client is contacted against their consent, or against DND.

**How** (`engine/consent.js`). Every outbound send is checked at the API, whoever or whatever sends it: a person, a bulk action, an automation or an integration.

- A dead number blocks every use of it.
- A withdrawal on one channel ("do not call me") blocks that channel, service included.
- The blanket marketing opt-out blocks marketing on every channel and lets service and regulatory messages through.
- A call logged as **Do Not Disturb** suppresses the client from every campaign.

**Ruled 20 Nov 2026: the national DND register (TRAI's NCPR) is screened by the carriers.** Promotional SMS go through the DLT platform, which never delivers them to a DND number. The dialler refuses DND numbers. SMS templates are marked transactional or promotional, and only transactional ones reach a DND number.

**What the test proves.**

- A client who opted out of marketing gets none on any channel, and still gets service messages.
- A client who asked not to be called isn't called, not even for service.
- The API refuses a marketing WhatsApp to them, even from an Admin, and nothing is logged as sent.
- A call logged as Do Not Disturb suppresses the client from campaigns.

**On deployment.**

- The DLT registration of Bonanza's and Bigul's headers and templates.
- CUBE's confirmation that the dialler screens DND numbers.

## G7 · India residency

**Asked.** Client data stays in India.

**How, for the AI layer** (`server/src/ai/residency.js`, the module a compliance reviewer should read first). Every AI capability is classed by the data it must see:

- **Raw client data** (a call transcript, a KYC application) is processed only in India.
- **De-identified data** may go to a model abroad. It is de-identified first and checked before it leaves: if a known identifier survived, the call is refused. Each such call is audited.

**OPS-84 (fixed 20 Nov), and ruled: enforce the policy.** The policy named a route for every call, and nothing obeyed it. Each capability called whichever provider was loaded. So with a frontier key set:

- a call transcript (AI disposition) or a KYC application (KYC coaching) went abroad unredacted;
- the Residency screen said it stayed in India;
- the `in_india_only` and `offline` modes reached the frontier too.

Now only a call routed abroad reaches the frontier provider. One routed to India is answered by the built-in offline drafter until an in-India model is set up, so nothing raw leaves the country meanwhile. The Residency report shows what actually answers each capability.

**What the test proves.**

- **With a frontier key configured, pointed at a recorder on the test machine:** no client name, mobile or transcript reaches it, and the de-identified next-action call still does.
- In the strict modes nothing reaches the frontier, whatever is configured.

**Where client data can go.** Every outbound connection the server is built to make:

| Service | Host | What it receives | Control |
|---|---|---|---|
| Bonanza eKYC portal | `kyc.bonanzaonline.com`, `kyc.bigul.co` | The applicant, sent to their own KYC | Bonanza's own system of record |
| CUBE QuickCall dialler | `raphsody.in` | Numbers to dial; call events back | Signed callbacks |
| Smartping (AiSensy) WhatsApp | `backend.api-wa.co` | Mobile and message | Consent checked before every send |
| SMTP relay | As configured | Email address and message | Consent checked before every send |
| Meta lead ads | `graph.facebook.com` | Inbound leads; Custom Audiences only if switched on (`CRM_META_AUDIENCES_ENABLED`) | Signed webhook (OPS-83) |
| Microsoft 365 (Outlook, Teams) | `graph.microsoft.com` | The user's own calendar | The user's own sign-in |
| Frontier AI (Anthropic) | `api.anthropic.com` | De-identified text only (OPS-84) | Checked before it leaves, and audited |
| Webhook endpoints | Registered by an Admin | The fields allowed for that endpoint | Registered and listed in Setup; secret encrypted (OPS-81) |

**On deployment.**

- The region of the database, its backups, the master key's KMS, and the logs.
- Each vendor's data location, confirmed by the vendor.
- If raw-data AI is wanted in the pilot: an in-India model (`CRM_AI_INDIA_URL`).

## G8 to G10 · The database, response time and availability

These come next. In order:

1. **A 2–3 day load test and sizing,** on PostgreSQL 16 in this environment, with production-size data. The sizing will be given in vCPU, memory, storage and IOPS, so it maps onto any provider.
2. **A one-page comparison for leadership,** written after the load test, with the measured numbers (ruled 20 Nov).
3. **The move to PostgreSQL** (B7, ruled 18 Nov), before the reports builder (A8) and pipeline filters (A7) are written.
4. **The gate tests:** p95 ≤ 1 second with 83 users at once, and availability, on PostgreSQL.
