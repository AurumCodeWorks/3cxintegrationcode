# 3CX → Salesforce Integration Proxy

A Cloudflare Worker that sits between a 3CX phone system and Salesforce so that **calls from numbers that aren't in the CRM still get logged**, with their AI transcription, against a real Salesforce record — without creating duplicates.

- **Worker:** `3cx-salesforce-proxy` → https://3cx-salesforce-proxy.autumn-truth-82d5.workers.dev
- **3CX template:** [cloudflare_salesforce_integration.xml](cloudflare_salesforce_integration.xml) (v44)
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

## Setting up a new environment

Three systems to configure, in this order. Salesforce first because Cloudflare needs its credentials, and 3CX last because it needs the Worker URL.

> **One CRM integration per PBX.** 3CX allows a single CRM template to be active at a time. To point a PBX at a different Salesforce org, change the Worker URL and key in the template rather than trying to run two.

### Step 1 — Salesforce

**1a. Create the Connected App** (Setup → App Manager → New Connected App → Create an API Integration)

- Enable OAuth Settings
- Callback URL: anything valid, e.g. `https://login.salesforce.com/services/oauth2/callback` (the client credentials flow never uses it)
- OAuth Scopes: **Manage user data via APIs (api)**
- Tick **Enable Client Credentials Flow**
- Save, then **Manage Consumer Details** to copy the Consumer Key and Consumer Secret

**1b. Set the run-as user** (App Manager → your app → Manage → Edit Policies → Client Credentials Flow)

Pick the user the integration acts as. Every record it creates will be owned by them, so use a dedicated integration user rather than a person who might leave. That user needs Create/Read/Edit on **Contact, Lead, Account and Task**, and Read on **RecordType**.

> Without a run-as user set, the token request fails with `invalid_grant`. This is the single most common setup failure.

**1c. Note your My Domain URL** — e.g. `https://yourorg.my.salesforce.com`. This becomes `SALESFORCE_LOGIN_URL`.

**1d. If the org uses Person Accounts**, confirm they are enabled and that the converting user's profile has a **default Account record type** (Profile → Record Type Settings → Account). Without it, Lead conversion in the UI fails with "Unable to find default record type". The Worker itself is unaffected because it always sets the record type explicitly.

**1e. Optional but recommended — the External ID field.** Create a text field (e.g. `Phone_E164__c`, length 20) on Contact, Lead and Account, marked **External ID** and **Unique**. This upgrades duplicate prevention from very good to structurally impossible. See [Making dedup structural](#making-dedup-structural).

**1f. Check what will block API inserts.** Duplicate rules, validation rules and required custom fields on Contact/Lead/Account reject records silently from the phone system's point of view. Worth reviewing before go-live rather than after.

### Step 2 — Cloudflare

```bash
npm install
npx wrangler login          # once per machine
npm run deploy              # runs the test suite, then deploys
```

Then set the configuration in the dashboard (Workers & Pages → your worker → Settings → Variables and Secrets). `keep_vars = true` in [wrangler.toml](wrangler.toml) stops later deploys wiping these, so they are edited in the dashboard and never in code.

Minimum to work at all:

| Name | Type | Value |
|---|---|---|
| `SALESFORCE_LOGIN_URL` | var | Your My Domain URL from step 1c |
| `SALESFORCE_CLIENT_ID` | secret | Consumer Key from step 1a |
| `SALESFORCE_CLIENT_SECRET` | secret | Consumer Secret from step 1a |
| `PROXY_API_KEY` | secret | A long random string you generate. 3CX must send the same value |

Generate and set the proxy key in one go:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put PROXY_API_KEY    # paste the value when prompted
```

> **Record the value somewhere before you paste it.** Cloudflare stores secrets write-only: `wrangler secret list` returns names and types only, and the dashboard cannot reveal them either. If the key is lost, the only route is to set a new one and update the Proxy API Key in **every** 3CX PBX pointing at this Worker, which locks out any you forget until you do.

Then set `SALESFORCE_ORG_MODEL` to match the org, and anything else from the [full config reference](#cloudflare-variables). Variable changes take effect immediately with no redeploy.

Note the deployed Worker URL, e.g. `https://3cx-salesforce-proxy.<subdomain>.workers.dev`.


### Step 3 — 3CX

Admin console → **Integrations → CRM** → choose Salesforce/other → **Upload** [cloudflare_salesforce_integration.xml](cloudflare_salesforce_integration.xml).

Then fill in, at minimum:

| Field | Value |
|---|---|
| Cloudflare Worker URL | From step 2, no trailing slash |
| Proxy API Key | Must match `PROXY_API_KEY` exactly |

Everything else has a working default. Review [the 3CX settings table](#3cx-settings) for filtering, auto-create policy and transcript handling.

> **Password fields usually come back blank after an upload.** Re-paste the Proxy API Key and save again, otherwise every request returns 401. Re-upload the XML whenever the template version changes, and re-paste the key each time.

### Reusing this Worker for another 3CX

A second PBX does **not** need its own Worker. Skip steps 1 and 2 entirely: upload the same [cloudflare_salesforce_integration.xml](cloudflare_salesforce_integration.xml) to the new PBX and enter the same Worker URL and the same Proxy API Key. That is the whole job.

Two things to be clear about before you do:

- **Both PBXs write into the same Salesforce org.** The org credentials and `SALESFORCE_ORG_MODEL` live on the Worker, not in the template, so every PBX pointing at a Worker shares its Salesforce destination. If the second environment needs a *different* org, deploy a second Worker (`name` in [wrangler.toml](wrangler.toml)) with its own variables, and point the new PBX at that instead.
- **The API key is shared.** Rotating it locks out every PBX until each one is updated. Since Cloudflare cannot show you an existing key, setting up a second PBX without your saved copy means rotating once and re-pasting into both.

Per-PBX behaviour still varies independently, because call filtering, auto-create policy and transcript handling are template parameters sent as request headers, not Worker variables. A head office PBX can journal everything while a satellite site logs inbound only.

### Step 4 — Verify

Open a log stream, then make one real call from a number that is not in Salesforce:

```bash
npm run tail
```

What a healthy first call looks like:

1. A lookup arrives and logs `Created Contact 003… at ring time` (or `Upserted …` if you added the External ID field)
2. The agent's phone shows the caller as a CRM match, and the (CRM) link opens an editable record
3. At the end of the call, a task POST journals the transcription against that record
4. `Maintaining Contact 003…: appending call and upserting reminder`

Then call again from the same number and confirm **no second record** is created and **no second reminder** is raised.

If any of that misbehaves, [Troubleshooting](#troubleshooting) covers the usual causes.

---

## Configuration

### Cloudflare variables

*Dashboard → Workers & Pages → your worker → Settings → Variables and Secrets*

All config lives here, not in `wrangler.toml` (`keep_vars = true` stops deploys overwriting it).

| Name | Type | Purpose |
|---|---|---|
| `SALESFORCE_LOGIN_URL` | var | Your Salesforce instance / My Domain URL |
| `SALESFORCE_ORG_MODEL` | var | `contact` \| `personaccount` \| `lead` (default `contact`) |
| `SALESFORCE_EXTRA_FIELDS` | var | JSON of extra fields per object, e.g. `{"Lead":{"LeadSource":"3CX"}}` |
| `HOME_COUNTRY` | var | ISO country for reading national-format numbers (default `GB`) |
| `MIN_SEARCH_LENGTH` | var | Type-ahead searches shorter than this are answered locally (default `3`) |
| `CALL_MERGE_WINDOW_MINUTES` | var | Transferred-leg consolidation window (default `5`, `0` disables) |
| `EXTENSION_DEPARTMENTS` | var | JSON map of extension or prefix to site name, e.g. `{"03":"Arbour Walk"}`. Longest prefix wins |
| `SYSTEM_EXTENSIONS` | var | Fallback only. Set **Auto Attendant / Queue Extensions** in the 3CX template instead |
| `SALESFORCE_EXTERNAL_ID_FIELD` | var | Unique External ID field holding the E.164 number, e.g. `Phone_E164__c`. Makes dedup structural (see below) |
| `ALERT_WEBHOOK_URL` | var | Optional. Background failures are POSTed here as JSON (Slack, Teams, Zapier) |
| `PROXY_API_KEY` | secret | Shared key 3CX must send as `X-Proxy-API-Key` |
| `SALESFORCE_CLIENT_ID` | secret | Connected App consumer key |
| `SALESFORCE_CLIENT_SECRET` | secret | Connected App consumer secret |

Variable changes apply immediately — **no redeploy needed**.

### 3CX settings

*Admin console → Integrations → CRM*

| Setting | Purpose |
|---|---|
| Cloudflare Worker URL | Points 3CX at this proxy |
| Proxy API Key | Must match `PROXY_API_KEY` |
| Auto-Create Unsaved Contacts | `Always On` / `After-Hours Only` / `Disabled` |
| Office Opens / Closes | Only used by `After-Hours Only` |
| Log Answered Inbound / Missed / Answered Outbound / Unanswered Outbound | Per-direction on/off |
| Internal Extension Max Digits | Numbers this short are internal — never reach Salesforce (default 6) |
| Excluded Number Prefixes | CSV, e.g. `0117, 0161` — sister sites, internal DDIs |
| Confidential Extensions | CSV, e.g. `3020, 4*`. The call is logged; transcript, summary, sentiment and recording link are not |
| Excluded Extensions | CSV. Nothing about these calls reaches Salesforce at all |
| System Extensions | CSV of receptionists, queues and ring groups, e.g. `1001, 1002, GRP*`. A trailing `*` matches a prefix. Their legs become one line and never name the record |
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
- Log a call while withholding everything said on it, per extension, for clinical or safeguarding lines
- Exclude named extensions entirely, where even the call record is unwanted
- Log a call while withholding the transcript (and withheld transcripts are never mined for names either)
- Survive Salesforce outages without creating duplicates or losing the call log
- Raise a visible alert when background enrichment fails, instead of failing silently
- Refresh an expired OAuth token automatically and retry
- Write custom fields via config, without a code change

## What it cannot do

- **Make 3CX transcribe a call it was not told to** — transcription is set per extension *and* per department, ring group and queue. An outbound call originates at the extension so the extension setting applies; an inbound call is handled by a group or queue first, and takes that object's setting. Enabling it only on users gives transcribed outbound calls and silent inbound ones, with the recording link present either way.

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
npm test                           # 254 checks — no network, no credentials needed
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
| [3CX-PBX-SETUP.md](3CX-PBX-SETUP.md) | Configuring the phone system itself: trunk, outbound rules, emergency numbers, inbound routing |
| [SALESFORCE-PERMISSIONS.md](SALESFORCE-PERMISSIONS.md) | Every object, field and record-type permission the integration user needs |
| [ddi-list.csv](ddi-list.csv) | The 52 Cedar Care DDIs with area, and blank columns for site and destination |
| [ddi-plain.csv](ddi-plain.csv) / [.txt](ddi-plain.txt) | The same 52 DDIs as a bare one-per-line list, for the 3CX DID Numbers tab |
| [cedar-care-excluded-prefixes.txt](cedar-care-excluded-prefixes.txt) | Cedar Care's own numbers, ready to paste into Excluded Number Prefixes |

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
