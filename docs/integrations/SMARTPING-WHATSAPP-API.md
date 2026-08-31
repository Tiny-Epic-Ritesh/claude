# Smartping WhatsApp — API reference

**Source:** *API REFERENCE DOCS — Mutual Fund*, supplied by Ritesh 31 August
2026. Smartping is a white-labelled AiSensy deployment, and the document
confirms the contract is AiSensy's v2 campaign API on a Smartping-specific path.

---

## 1. The one thing that was wrong

The adapter had been written against the AiSensy contract inferred from the
dashboard bundle, which was right about every field name and **wrong about the
path**:

| | |
|---|---|
| What the adapter sent to | `POST {base}/campaign/t1/api/v2` |
| What the document says | `POST https://backend.api-wa.co/campaign/smartping/api/v2` |

`t1` is AiSensy's own tenant segment; `smartping` is the white-label's. Every
send would have returned a 404 against the real endpoint. Fixed, and made
configurable via `SMARTPING_API_PATH` so a direct AiSensy tenant or a future
path change needs no code change.

---

## 2. Prerequisites, which are operational rather than technical

Three things must be true before any call succeeds. None of them are things the
CRM can do for itself, and all three fail at send time rather than at setup:

1. The WhatsApp Business API account is **verified**.
2. The template messages are **approved** by Meta.
3. An **API Campaign exists and its status is `Live`**.

That third one is the one that will catch us. AiSensy addresses a template by
**campaign name**, not by template id, and the campaign must be Live at the
moment of sending. A campaign that is paused produces a rejected request for a
message body that is perfectly valid.

---

## 3. The request

`POST {base}{path}` — `application/json`.

| Field | Type | | Notes |
|---|---|---|---|
| `apiKey` | string | **required** | From the Smartping dashboard. |
| `campaignName` | string | **required** | Must name a campaign whose status is `Live`. |
| `destination` | string | **required** | Mobile with country dial-code. `+(country code)(number)` is the documented recommendation; an unresolvable number defaults to India (+91). |
| `userName` | string | **required** | Name of the recipient. |
| `source` | string | optional | Lead source, for building re-targeting segments — `'Facebook forms'`, `'Website lead'`. |
| `media` | object | optional | `{ url, filename }`. The URL **must be publicly reachable** or the request is rejected. |
| `templateParams[]` | string[] | optional | Positional values filling the template's variables. |
| `tags[]` | string[] | optional | Tag names to assign to the user. |
| `attributes` | object | optional | Key/value pairs; values must be strings. |

### Three rejection rules worth stating separately

- **`templateParams` length must exactly equal the campaign's variable count.**
  Otherwise the request is rejected outright. This is why the adapter resolves
  *named* parameters through a declared per-campaign order and refuses to send
  when the mapping is missing — see §4.
- **A media URL that is not publicly accessible is rejected.** Anything we
  attach has to be reachable without our session.
- **Tags and attributes must already exist in the project**, created by someone
  with manager access. An unknown one is **silently ignored** — not an error.
  So a tag that never arrives looks exactly like a tag that was never sent.

## 4. Positional parameters are the real hazard

`templateParams` is an ordered array with no names in it. Reordering the
variables in the Meta template silently changes what every CRM field means, and
nothing errors — the message sends, reads plausibly, and says the wrong thing.
For a SEBI-regulated firm messaging clients about their own money, that is the
worst failure mode in this integration.

The adapter therefore does not expose the positional array to callers. It takes
named values and resolves them through an explicit per-campaign variable order
held in the database, and **refuses to send** when a declared variable is
missing rather than shifting every subsequent parameter by one position.

## 5. The response

The document states only that a successful call returns **HTTP 200**. It
documents no response body and no message identifier.

That matters more than it sounds: **there is no delivery id to correlate
against.** Whatever the adapter reads out of the body (`messageId`, `id`) is
speculative and will frequently be null. Delivery state has to come from the
webhook instead, matched on the destination number and time — the same
inference problem the CUBE call log has, for the same reason.

## 6. The 24-hour window

Not in this document, but it governs everything above: Meta permits free-form
replies only within 24 hours of the customer's last inbound message. Outside it,
an approved template is the only lawful send. The adapter checks the window
before choosing which call to make, so a stale conversation fails at our
boundary with a clear reason rather than at Meta's with an opaque code.

## 7. Configuration

| Variable | Default | |
|---|---|---|
| `SMARTPING_API_URL` | `https://backend.api-wa.co` | Backend root |
| `SMARTPING_API_PATH` | `/campaign/smartping/api/v2` | White-label path; `/campaign/t1/api/v2` for a direct AiSensy tenant |
| `SMARTPING_API_KEY` | — | From the dashboard. Presence of this is what makes the adapter live |
| `SMARTPING_CAMPAIGN` | `BONANZA_CRM` | Default campaign when a send does not name one |
| `SMARTPING_WEBHOOK_SECRET` | — | Delivery receipts and inbound messages are refused without it |

## 8. Still open

| # | Question | Ask |
|---|---|---|
| 1 | **What are the real Live campaign names?** The document gives none, and a campaign name is required on every send. Nothing can go live without this list. | Ritesh / Smartping |
| 2 | **What is each campaign's variable order?** Required for §4. A campaign without a declared order is refused by the adapter by design. | Ritesh / Smartping |
| 3 | **Which tags and attributes already exist in the project?** Unknown ones are silently dropped, so sending them is worse than not — it looks like it worked. | Smartping |
| 4 | **Is there a documented webhook contract** for delivery receipts and inbound messages? The adapter's parser was inferred, and §5 means the webhook is the only source of delivery state. | Smartping |
| 5 | **Does the response carry any identifier at all?** If not, delivery correlation is by number and timestamp, and should be labelled inferred. | Verify against the sandbox |
