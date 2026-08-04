# 3CX → Salesforce Integration Proxy

A Cloudflare Worker that sits between a 3CX phone system and Salesforce so that **calls from numbers that aren't in the CRM still get logged**, with their AI transcription, against a real Salesforce record — without creating duplicates.

- **Worker:** `3cx-salesforce-proxy` → https://3cx-salesforce-proxy.autumn-truth-82d5.workers.dev
- **3CX template:** [cloudflare_salesforce_integration.xml](cloudflare_salesforce_integration.xml) (v39)
- **Salesforce API:** v55.0, OAuth 2.0 client-credentials flow

---

## The problem this solves

3CX only journals a call if its CRM lookup **matched something**. An unknown caller returns no match, so 3CX silently discards the call log, the transcription and the recording — there's nowhere to put them.

This proxy intercepts the lookup, creates the missing record in Salesforce in real time, and hands it back to 3CX as a genuine match. Journaling then proceeds normally.

---

## How the flow works

### 1. The phone rings — lookup

```
3CX ──lookup──▶ Worker ──▶ Salesforce
                  │
                  ├─ match found?  ──▶ pass it straight back to 3CX
                  │
                  └─ no match:
                       ├─ filtered number?     ──▶ return empty (nothing happens at all)
                       ├─ auto-create off?     ──▶ return empty
                       └─ otherwise: CREATE the record now, return it to 3CX
```

Because the record is **real**, the agent sees a normal CRM match on their phone and the **(CRM) link opens an editable Salesforce record mid-call**.

The number is canonicalised to E.164 (`07700900123` → `+447700900123`) so lookups, stored records and dedup all agree.

### 2. The call ends — journaling

3CX posts the call log (time, direction, extension, duration, **transcription, summary, sentiment, recording link**) as a Task linked to that record. The Worker forwards it immediately, then in the background:

- **Appends** the call and transcript to the record's Description
- **Stamps the first call's** direction/time/extension onto the name, e.g. `+447700900456 (Inbound 15:04, Ext 102)`
- **Notes any name it heard** as an explicitly unverified hint on the record and the reminder — it is **never** written into the name field (see below)
- **Upserts one open reminder task** — "Action Required: …" — asking a human to fill in the details

> **Names are never guessed onto records.** A mis-heard transcription or a stale 3CX phonebook entry produces a record that *looks* verified but isn't, and nobody re-checks a record that already has a name. `Unregistered Contact +447700900456` is self-evidently incomplete and invites correction. Any name detected appears as `Possible caller name mentioned: "…" (unverified — from call transcription)` so a human still gets the head start.

### 2a. The call is transferred

3CX journals **per extension, not per call**, so a call answered on reception and passed to a manager arrives as two separate call logs. When a log arrives for a caller who already has one from the last few minutes, the Worker **appends to that record** instead of creating a second, heading each leg:

```
===== Call continued on extension 105 at 15:04 (UK Time) =====
```

Durations are summed so the total reflects the whole conversation. 3CX exposes **no call identifier** to CRM templates, so legs are correlated by caller plus timing — deliberately biased toward merging, because a wrongly merged pair still shows both legs clearly in one record while a wrongly split one scatters the history.

Since a leg is journaled when it *ends*, the window is measured from the handover, not the conversation: the incoming leg's own duration is added, so a long second leg still merges. Set `CALL_MERGE_WINDOW_MINUTES` to `0` to log every leg separately.

> The merged activity stays **owned by the first extension's user**. The later legs are named in the description, but ownership does not follow the transfer.

### 3. They call again

The lookup now matches the existing record, so nothing is created. The second transcript lands on the same record, and the **existing** reminder is updated rather than a new one raised. One record, one open reminder, growing call history.

### 4. Someone fills in the details

Once a human gives the record a real name, the Worker detects the markers are gone, **auto-completes leftover reminders**, and stops touching the record.

---

## Org models

Set `SALESFORCE_ORG_MODEL` in the Cloudflare dashboard.

| Mode | Unknown caller becomes | Matching order | Task linked to |
|---|---|---|---|
| `contact` *(default)* | a **Contact** | Contact | Contact Id |
| `personaccount` | a **Person Account** | Person Account | `PersonContactId` |
| `lead` | a **Lead** (Company blank, so it converts to a Person Account) | Person Account → open Lead | Lead Id / `PersonContactId` |

In `lead` mode: first call creates a Lead, a human qualifies and converts it, and later calls match the resulting Person Account. Person Accounts always win over Leads, so a converted caller never gets a second Lead.

> Person Account records are written via the `Account` object using the org's person record type, discovered at runtime — nothing is hardcoded, so the same Worker works against any org.

---

## Configuration

### Cloudflare (dashboard → Workers & Pages → 3cx-salesforce-proxy → Settings → Variables and Secrets)

All config lives here, not in `wrangler.toml` (`keep_vars = true` stops deploys overwriting it).

| Name | Type | Purpose |
|---|---|---|
| `SALESFORCE_LOGIN_URL` | var | Your Salesforce instance / My Domain URL |
| `SALESFORCE_ORG_MODEL` | var | `contact` \| `personaccount` \| `lead` (default `contact`) |
| `SALESFORCE_EXTRA_FIELDS` | var | JSON of extra fields per object, e.g. `{"Lead":{"LeadSource":"3CX"}}` |
| `HOME_COUNTRY` | var | ISO country for reading national-format numbers (default `GB`) |
| `MIN_SEARCH_LENGTH` | var | Type-ahead searches shorter than this are answered locally (default `3`) |
| `CALL_MERGE_WINDOW_MINUTES` | var | Transferred-leg consolidation window (default `5`, `0` disables) |
| `SALESFORCE_EXTERNAL_ID_FIELD` | var | Unique External ID field holding the E.164 number, e.g. `Phone_E164__c`. Makes dedup structural (see below) |
| `ALERT_WEBHOOK_URL` | var | Optional. Background failures are POSTed here as JSON (Slack, Teams, Zapier) |
| `PROXY_API_KEY` | secret | Shared key 3CX must send as `X-Proxy-API-Key` |
| `SALESFORCE_CLIENT_ID` | secret | Connected App consumer key |
| `SALESFORCE_CLIENT_SECRET` | secret | Connected App consumer secret |

Variable changes apply immediately — **no redeploy needed**.

### 3CX (Admin → Integrations → CRM)

| Setting | Purpose |
|---|---|
| Cloudflare Worker URL | Points 3CX at this proxy |
| Proxy API Key | Must match `PROXY_API_KEY` |
| Auto-Create Unsaved Contacts | `Always On` / `After-Hours Only` / `Disabled` |
| Office Opens / Closes | Only used by `After-Hours Only` |
| Log Answered Inbound / Missed / Answered Outbound / Unanswered Outbound | Per-direction on/off |
| Internal Extension Max Digits | Numbers this short are internal — never reach Salesforce (default 6) |
| Excluded Number Prefixes | CSV, e.g. `0117, 0161` — sister sites, internal DDIs |
| Store Call Transcripts | `Include full transcript` / `Metadata only` / `External inbound only` |

---

### Making dedup structural

By default, duplicate prevention is *query-then-create with race convergence*: the Worker checks, creates, then re-queries and deletes its own record if a simultaneous call beat it to one. It has held up, but it is a mitigation, not a guarantee.

Create a **unique External ID** field on Contact / Lead / Account (e.g. `Phone_E164__c`, text, External ID, Unique) and set `SALESFORCE_EXTERNAL_ID_FIELD` to its API name. Creation then becomes a Salesforce **upsert keyed on that field**, and duplicates become impossible at database level — two simultaneous calls from one number cannot both insert, because Salesforce itself refuses the second.

If the field name is wrong or missing, the Worker logs the rejection and falls back to create-then-converge, so a typo degrades the guarantee rather than stopping records being created.

### When background work fails

Appending the transcript and upserting the reminder happen *after* the call log is safely saved. If that background step fails, the call is still logged but the transcript may be missing from the record, and previously nothing said so.

Failures now raise a **`3CX Integration Error:` task** on the affected record, high priority, one per record rather than one per call. It uses a different subject from the caller reminders deliberately, so the reminder upsert cannot overwrite it and the auto-close cannot silently clear it.

Set `ALERT_WEBHOOK_URL` as well if you want a signal that survives Salesforce itself being down, since a Salesforce outage is exactly when a Salesforce task cannot be created.

---

## What it can do

- Create a real, editable CRM record the moment an unknown number rings
- Log transcription, summary, sentiment and recording link against that record
- Handle all four call outcomes — answered inbound, missed, answered outbound, unanswered outbound
- Prevent duplicates: exact-match phone lookup, plus race convergence if two calls land simultaneously
- Keep exactly one open reminder per unregistered caller, and auto-close it once details are filled in
- Detect a caller's name in the transcription and surface it as an unverified hint (never as the record's name)
- Normalise numbers from **any country** to E.164 across lookup, storage and dedup, using Google's libphonenumber numbering-plan database rather than hand-rolled rules
- Consolidate a transferred call's legs into one activity instead of one per extension
- Cut Salesforce API consumption from 3CX's search-as-you-type (minimum term length, plus a negative cache so once a term returns nothing, every longer term is answered locally)
- Keep internal/sister-site calls and their transcripts **entirely** out of Salesforce
- Log a call while withholding the transcript (and withheld transcripts are never mined for names either)
- Survive Salesforce outages without creating duplicates or losing the call log
- Raise a visible alert when background enrichment fails, instead of failing silently
- Refresh an expired OAuth token automatically and retry
- Write custom fields via config, without a code change

## What it cannot do

- **Run two CRM integrations on one 3CX PBX** — a 3CX limit. Testing against a second Salesforce org means either a second PBX or switching the Worker URL for a test window.
- **Reveal `PROXY_API_KEY`** — it's a Cloudflare secret. It can be replaced, never read back. Keep a copy when you rotate it.
- **Guarantee dedup at database level *without* an External ID field** — the guarantee is available (see above) but requires the org to add a unique External ID field. Until then it stays query-then-create with race convergence.
- **Match or create business Accounts** — company records are only found by 3CX's own passthrough lookup. Only Contacts, Person Accounts and Leads are auto-created.
- **Auto-convert Leads** — deliberate. Conversion stays a human decision.
- **Correlate transferred legs with certainty** — 3CX gives CRM templates no call id, so consolidation matches on caller plus timing. A genuine second call within the window is appended to the previous one. Shorten `CALL_MERGE_WINDOW_MINUTES` if that happens often.
- **Move activity ownership across a transfer** — the merged activity stays owned by the extension that answered first.
- **Extract names in other languages** — the name parser matches English phrasings ("my name is…", "this is…", "I'm…").
- **Clean up pre-existing duplicates** — it prevents new ones; it won't merge what's already there.
- **Filter calls whose number it can't parse** — an unrecognised description format is journaled rather than dropped, so nothing is silently lost.
- **Survive a mid-call edit in a sub-second window** — if someone saves the record in Salesforce at the exact instant post-call maintenance writes, one write can overwrite the other (name/description fields only).

---

## Development

```bash
npm test                           # 198 checks — no network, no credentials needed
npx wrangler deploy --dry-run --outdir dist   # validate the bundle
npx wrangler deploy                # ship it
npx wrangler tail                  # live logs, including filter decisions
```

The test harness mocks the Salesforce REST API and drives the Worker's `fetch` handler through every lookup, journaling, dedup, filtering and org-model path. Run it before every deploy.

### Files

| Path | What it is |
|---|---|
| [src/index.js](src/index.js) | The entire Worker |
| [test/worker.test.mjs](test/worker.test.mjs) | Offline test suite |
| [cloudflare_salesforce_integration.xml](cloudflare_salesforce_integration.xml) | 3CX CRM template — upload in 3CX Admin |
| [wrangler.toml](wrangler.toml) | Deploy config only; all values live in the dashboard |

> Re-upload the XML in 3CX whenever its parameters change (the version attribute is bumped each time). Password fields often blank on upload — re-paste the API key afterwards.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `MALFORMED_SEARCH … Bind variables only allowed in Apex` | A `+` reached a SOSL `FIND`. Phone searches must use digits only — `+` is reserved in SOSL. |
| Number arrives truncated (e.g. `3178055`) | The template's `<Number MaxLength="">` was set to `[MaxLength]`, which truncates to the PBX contact-match length. Must be empty. |
| `401 Unauthorized` from the proxy | 3CX's Proxy API Key doesn't match `PROXY_API_KEY`. |
| Records created for test/spam calls | Expected — a record is created whenever an unknown number rings. Use the exclusion list, or set Auto-Create to `After-Hours Only` / `Disabled`. |
| Nothing created and no task logged | The number matched a filter (internal length or excluded prefix). `wrangler tail` logs every filter decision. |
| Duplicate contacts appearing | Check `SALESFORCE_ORG_MODEL` matches the org — Contact mode against a Person Account org creates the wrong object type. |
| Salesforce rejects record creation | Usually a validation rule, duplicate rule, or a required custom field. `wrangler tail` shows the exact Salesforce error. |
