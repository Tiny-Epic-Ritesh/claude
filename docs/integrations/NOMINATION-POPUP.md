# Nomination pop-up — integration spec for the trading platform

**For:** the team that builds the Bonanza and Bigul trading platforms (web and
app).
**From:** the CRM team.
**Why:** SEBI's circular of 29 May 2026 (SEBI/HO/OIAE/OIAE_IAD-3/P/CIR/2026/12676),
para 10.2(b). An account with no nomination, including one that opted out, must
be asked to add a nominee when the client first logs in each day. Accounts that
already have a nomination are not asked. The CRM keeps the nomination record, so
on each log-in the platform asks the CRM whether to show the pop-up.

---

## The call

```
GET {base}/api/platform/nomination-prompt?client_code={UCC}&business={BONANZA|BIGUL}
X-Api-Key:    bnz_…
X-Api-Secret: sk_…
```

| Parameter | |
|---|---|
| `client_code` | The client's UCC, as the platform knows it. |
| `business` | `BONANZA` or `BIGUL`: the platform the client logged into. |
| `{base}` | The CRM address shown in CRM Setup → API & logs. Use labs for testing and production once it is live. |

Make the call **from your server, never from the app or the browser.** The
secret would let anyone holding it ask about any account, so it must never be
shipped inside an app or sent to a device.

## The answer

Show the pop-up:

```json
{ "client_code": "B123456", "show": true,
  "title": "Add a nominee",
  "message": "A nominee lets your family receive your holdings quickly, without court papers. Without one, holdings left unclaimed may go to the Investor Education and Protection Fund. You can add one at any time." }
```

Don't show it:

```json
{ "client_code": "B123456", "show": false, "reason": "has a nomination" }
{ "client_code": "B123456", "show": false, "reason": "already shown today" }
```

- Display `title` and `message` exactly as sent. The wording is the CRM's, so
  compliance can change it without an app release.
- The **Add a nominee** button opens your own nomination page. The client must
  be able to close the pop-up without adding one.
- `show: true` is returned **once per account per day (India time)**. The CRM
  records the pop-up as shown when it answers, so call only when you will
  display the answer. Later log-ins that day get `already shown today`.

| Status | Meaning | What to do |
|---|---|---|
| 200 | Answered | As above. |
| 400 | `client_code` or `business` missing | Fix the request. |
| 401 | Key or secret wrong, revoked, or the key's account deactivated | Log in as usual and alert your team. |
| 403 | Key not scoped for `client.nomination.prompt` | Ask the CRM admin to fix the key. |
| 404 | No open account with that UCC in that business | Log in as usual. |

**If the CRM fails, let the client log in.** Wait at most 1 second. On a timeout,
an error or any status other than 200, skip the pop-up. The pop-up must never
stop a client from logging in or trading.

## Data

The request sends only the UCC and the business. The response contains no
personal data: no name, no nominee, no contact details. Nothing about the
client goes from the CRM to the platform except whether to show the pop-up.

## Getting a key

1. A CRM Admin creates a user with the role **API integration** in Setup → Users
   (for example "Trading platform — Bonanza") in the right business. This
   account cannot sign in to the CRM, and nobody can sign in as it.
2. A Superadmin issues a key in Setup → API & logs. It acts as that user and is
   scoped to **client.nomination.prompt**, the only thing it can do.
3. The secret is shown once. It is handed over **through the password manager**,
   never by email or chat. Use one key per business and per environment (labs,
   production).
4. If a key is lost, **Rotate** it: the old secret stops working at once. When
   the integration ends, **Revoke** it.

## Where this stands (15 Oct 2026)

- **Your own pop-up.** We are working on the basis that your platform already
  shows a nomination pop-up. Until both teams agree otherwise, keep yours and
  do not call this endpoint as well, so a client sees one pop-up, not two. If
  you would rather the CRM decide when it shows, replace your own check with
  this call; the wording then comes from the CRM.
- **Nominations made outside the CRM.** When a client adds or changes a
  nominee on your platform or at the DP back office, CRM staff record it by
  hand on the client's page (Nomination → Record a change) for now. An
  automatic feed will be agreed with the team concerned and set up later.
  Until a nomination is recorded in the CRM, the CRM treats the account as
  having none.
- **Still to name:** who on the trading platform side owns this integration
  and the nomination page behind the button, and a contact on each side for
  keys and incidents.
