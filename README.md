# 3CX → Salesforce Integration Proxy

A Cloudflare Worker that sits between a 3CX phone system and Salesforce so that **calls from numbers that aren't in the CRM still get logged**, with their AI transcription, against a real Salesforce record — without creating duplicates.

- **Worker:** `3cx-salesforce-proxy-cedarcare` -> https://3cx-salesforce-proxy-cedarcare.autumn-truth-82d5.workers.dev
- **3CX template:** [cloudflare_salesforce_integration.xml](cloudflare_salesforce_integration.xml) (v50)
- **Salesforce API:** v55.0, OAuth 2.0 client-credentials flow

---

## The problem this solves

3CX only journals a call if its CRM lookup **matched something**. An unknown caller returns no match, so 3CX silently discards the call log, the transcription and the recording — there's nowhere to put them.

This proxy intercepts the lookup, creates the missing record in Salesforce in real time, and hands it back to 3CX as a genuine match. Journaling then proceeds normally.

---

## How the flow works

### Tracked queues (template v46)

Only calls **answered through a tracked queue** create a record for an unknown caller: New Care Enquiries for the homes, and the Placement Team at head office. List their queue extensions in the template's **Tracked Queues** setting. **Excluded Extensions** still applies on top and always wins: nothing on an excluded extension or queue reaches Salesforce.

3CX cannot tell a lookup which queue a call is on. The queue arrives only with the call journal, as `[QueueExtension]`. So with Tracked Queues in use:

| Call | What happens |
|---|---|
| Unknown caller, answered through a tracked queue | The lookup returns a **New Caller** stand-in. When the call is journaled, the Worker creates the record, named after the home, and links the call to it |
| Unknown caller, any other route, or nobody answered | The stand-in is dropped at journaling. No record, no call log |
| Unknown number, outbound | Nothing is returned, so nothing is logged |
| Someone who already has a record, any route | Logged against that record while **Always Log Calls For Existing Records** is on (the default) |
| The same, with Always Log off | Logged only through a tracked queue, plus later legs of a tracked call (a transfer) |
| Salesforce down during a tracked call | The call log is kept, unlinked, rather than lost |

The trade-off is that a brand new caller shows as **New Caller** during the first call, and the (CRM) link opens the Leads list rather than a record, because the record is only created when the call ends. From the second call on they match normally.

A new enquiry is named home first, so a list sorted by name groups by home. The home is the 3CX department the tracked queue belongs to:

| First name | Last name |
|---|---|
| Arbour Walk | Enquiry +447700900321 (15 Sep 10:17) |

A person replaces both once they know who called. Until then the record counts as unregistered and keeps its reminder. Without the 3CX API configured, the first name is `Phone`.

A caller who is already a Contact under a business Account (a social worker, a hospital discharge team) is logged against that Contact rather than raised as an enquiry.

Office hours are gone. Out-of-hours calls are redirected by the PBX to an answering service, so the Worker never sees them.

The sections below describe what happens once a call qualifies. A template older than v46 sends none of these headers and keeps the previous behaviour, creating the record at ring time.

### 1. The phone rings — lookup

```
3CX ──lookup──▶ Worker ──▶ Salesforce
                  │
                  ├─ match found?  ──▶ pass it straight back to 3CX
                  │
                  └─ no match:
                       ├─ filtered number?          ──▶ return empty (nothing happens at all)
                       ├─ outbound, or no tracked queues set ──▶ return empty
                       └─ otherwise: return a New Caller stand-in, decide when the call ends
```

An existing record is a real match, so the **(CRM) link opens it mid-call**. A new caller's record is created when the call ends, only if it came through a tracked queue (see above). A template older than v46 instead creates the record here, at ring time.

The number is canonicalised to E.164 (`07700900123` → `+447700900123`) so lookups, stored records and dedup all agree.

### 2. The call ends — journaling

3CX posts the call log (time, direction, extension, duration, **transcription, summary, sentiment, recording link**) as a Task linked to that record. The Worker forwards it immediately, then in the background:

- **Adds the call to the record's call history**, newest first, in the Description: when, which way, how long, who took it, and the recording link. What was said stays on the call log (see [Retention](#retention))
- **Notes any name it heard** as an explicitly unverified hint on the reminder. It is **never** written into the name field (see below)
- **Upserts one open reminder task**, "Action Required: …", asking a human to fill in the details and listing the calls, newest first

The Description of a new enquiry reads:

```
New enquiry through Oakhill (queue 8075)
15 Sep 2026 at 12:27

--- 3CX call history, newest first ---

15 Sep 2026 13:08 · Inbound · 0:25
Answered by ext 0374, Oakhill
Recording: https://cedarcare.my3cx.uk/recording/…

15 Sep 2026 12:27 · Inbound · 3:06
Oakhill menu 2017 (0:56), then ext 0375 (2:10)
Recording: https://cedarcare.my3cx.uk/recording/…

--- end of call history ---
```

Only the section between the two marker lines is ever rewritten, so notes a person types above or below it are left alone. When the Description reaches Salesforce's limit, the oldest calls are dropped first, never the notes. A record written before this format keeps its old text underneath the new history. An entry written when the history still carried transcripts loses them, and any name hint, on the next call from that number, whether or not the record has been named since (see [Retention](#retention) for what that does not reach).

> **Names are never guessed onto records.** A mis-heard transcription or a stale 3CX phonebook entry produces a record that *looks* verified but isn't, and nobody re-checks a record that already has a name. `Unregistered Contact +447700900456` is self-evidently incomplete and invites correction. Any name detected appears on the reminder as `Possible caller name mentioned: "…" (unverified, from call transcription)` so a human still gets the head start.

### 2a. The call is transferred

3CX journals **per extension, not per call**, so a call that passes a receptionist menu and is answered, or is answered on reception and passed to a manager, arrives as several call logs. When a log arrives for a caller who already has one from the last few minutes, the Worker **adds it to that call log** instead of creating a second:

```
Then ext 105, Arbour Walk at 15:04, 1:12
```

The record's call history does the same: the legs become one entry, `Oakhill menu 2017 (0:56), then ext 0375 (2:10)`, and the reminder lists the call once. Durations are summed so the total reflects the whole conversation. 3CX exposes **no call identifier** to CRM templates, so legs are correlated by caller plus timing — deliberately biased toward merging, because a wrongly merged pair still shows both legs clearly in one record while a wrongly split one scatters the history.

Since a leg is journaled when it *ends*, the window is measured from the handover, not the conversation: the incoming leg's own duration is added, so a long second leg still merges. Set `CALL_MERGE_WINDOW_MINUTES` to `0` to log every leg separately.

> The merged activity stays **owned by the first extension's user**. The later legs are named in the description, but ownership does not follow the transfer.

### 3. They call again

The lookup now matches the existing record, so nothing is created. The second call log lands on the same record, and the **existing** reminder is updated rather than a new one raised. One record, one open reminder, growing call history.

### 4. Someone fills in the details

Once a human gives the record a real name, the next call from that number finds the markers gone, **auto-completes leftover reminders**, and stops touching the record. Reminders close on that next call, not the moment the record is edited.

---

## Org models

Set `SALESFORCE_ORG_MODEL` in [wrangler.toml](wrangler.toml). It defines which records the Worker writes when the 3CX template does not say.

**From template v51 the template decides**, through *New Enquiries Create Leads* and *New Enquiries Create Person Accounts*, so one PBX can differ from another against the same Worker and a change needs no deploy. Person Accounts win when both are on; with both off nothing is created and callers already on file are still logged. A template that does not send them leaves `SALESFORCE_ORG_MODEL` in charge.

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

**1a. Create the Connected App** (Setup → App Manager → New Connected App → Create an API Integration). Orgs on Salesforce's Spring '26 release or later no longer allow new Connected Apps: create an **External Client App** instead, with the same OAuth settings.

- Enable OAuth Settings
- Callback URL: anything valid, e.g. `https://login.salesforce.com/services/oauth2/callback` (the client credentials flow never uses it)
- OAuth Scopes: **Manage user data via APIs (api)**
- Tick **Enable Client Credentials Flow**
- Save, then **Manage Consumer Details** to copy the Consumer Key and Consumer Secret

**1b. Set the run-as user** (App Manager → your app → Manage → Edit Policies → Client Credentials Flow)

Pick the user the integration acts as. Every record it creates will be owned by them unless an assignment rule or 3CX says otherwise, so use a dedicated integration user rather than a person who might leave. [SALESFORCE-PERMISSIONS.md](SALESFORCE-PERMISSIONS.md) lists every object and field it needs.

> Without a run-as user set, the token request fails with `invalid_grant`. This is the single most common setup failure.
>
> **Changing the run-as user later** is a Salesforce change only, but the Worker recognises the reminders and call logs it raised by who created them. Open reminders from the previous user are left alone, and the next call raises a fresh one.

**1c. Note your My Domain URL** — e.g. `https://yourorg.my.salesforce.com`, or `https://yourorg--uat.sandbox.my.salesforce.com` for a sandbox. This becomes `SALESFORCE_LOGIN_URL`. The client credentials flow is not served by `login.salesforce.com` or `test.salesforce.com`, so the Worker refuses both.

**1d. If the org uses Person Accounts**, confirm they are enabled and that the converting user's profile has a **default Account record type** (Profile → Record Type Settings → Account). Without it, Lead conversion in the UI fails with "Unable to find default record type". The Worker itself is unaffected because it always sets the record type explicitly.

**1e. Optional but recommended — the External ID field.** Create a text field (e.g. `Phone_E164__c`, length 20) on Contact, Lead and Account, marked **External ID** and **Unique**. This upgrades duplicate prevention from very good to structurally impossible. See [Making dedup structural](#making-dedup-structural).

**1f. Check what will block API inserts.** Duplicate rules, validation rules and required custom fields on Contact/Lead/Account reject records silently from the phone system's point of view. Worth reviewing before go-live rather than after.

- **Duplicate rules.** Salesforce's REST documentation has an API insert that does not opt in refused by a rule set to *Allow* with an alert, just as *Block* would. The Worker sends `Sforce-Duplicate-Rule-Header: allowSave=true` on the records it creates, so *Allow* rules allow. That matters for enquiries: every one at a home shares its first name and has a last name beginning `Enquiry +44`, which a fuzzy name rule can take for a duplicate of the last. A *Block* rule still blocks: if the record it matched has the caller's number, the Worker uses that record, and otherwise the call is logged unlinked and reported to `ALERT_WEBHOOK_URL`.
- **Numbers typed by hand.** The Worker finds an existing caller by exact match on the common formats of their number (`+447700900123`, `07700 900123`, `07700900123` and a few more) and on `Phone_E164__c`. A record whose number was typed another way, `07393 178 055` say, is not found, and with *Allow* rules the enquiry gets a new Lead beside it. Records created by other systems (web forms, Moneypenny, Lottie) should fill in `Phone_E164__c`.
- **Restricted picklists.** A value the picklist does not hold (a Lead Source not added yet, a care home spelt differently) refuses the insert. The Worker retries without that field and reports it to `ALERT_WEBHOOK_URL`, so the enquiry still gets its record.
- **Sharing.** A Lead assignment rule runs as the record is inserted, so a new Lead can belong to someone else before the Worker reads it back. Where Lead sharing is Private, give the integration user **View All** and **Modify All** on Lead (and Account and Contact, for converted callers), or it cannot read, link or maintain the records it creates.

### Step 2 — Cloudflare

**For a new org, edit [wrangler.toml](wrangler.toml) first.** Change `name` to a new Worker name, and set `SALESFORCE_LOGIN_URL`, `SALESFORCE_ORG_MODEL`, `SALESFORCE_EXTERNAL_ID_FIELD` and `SALESFORCE_HOME_FIELD` for that org (remove `SALESFORCE_HOME_FIELD` if it has no such field). Check the dashboard's `SALESFORCE_FALLBACK_OWNER` and `SALESFORCE_HOME_VALUES` too, since they name users and values in one org. Deploying without changing `name` overwrites the existing Cedar Care Worker.

```bash
npm install
npx wrangler login          # once per machine
npm run deploy              # runs the test suite, then deploys
```

The values in `wrangler.toml` are deployed with the code. Everything else is set in the dashboard (Workers & Pages → your worker → Settings → Variables and Secrets), and `keep_vars = true` stops later deploys wiping those.

Minimum to work at all:

| Name | Type | Value |
|---|---|---|
| `SALESFORCE_LOGIN_URL` | wrangler.toml | Your My Domain URL from step 1c |
| `SALESFORCE_CLIENT_ID` | secret | Consumer Key from step 1a |
| `SALESFORCE_CLIENT_SECRET` | secret | Consumer Secret from step 1a |
| `PROXY_API_KEY` | secret | A long random string you generate. 3CX must send the same value |

Generate and set the proxy key in one go:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put PROXY_API_KEY    # paste the value when prompted
```

> **Record the value somewhere before you paste it.** Cloudflare stores secrets write-only: `wrangler secret list` returns names and types only, and the dashboard cannot reveal them either. If the key is lost, the only route is to set a new one and update the Proxy API Key in **every** 3CX PBX pointing at this Worker, which locks out any you forget until you do.

Then set anything else from the [full config reference](#cloudflare-variables). Dashboard variable changes take effect immediately with no redeploy.

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
>
> **3CX can keep saved values across a re-upload.** After uploading, check each setting shows what you expect, especially any whose meaning changed between versions.

### Reusing this Worker for another 3CX

A second PBX does **not** need its own Worker. Upload the same [cloudflare_salesforce_integration.xml](cloudflare_salesforce_integration.xml) to the new PBX and enter the same Worker URL and Proxy API Key.

Both PBXs then write into the same Salesforce org, because the credentials and `SALESFORCE_ORG_MODEL` live on the Worker rather than in the template. A **different** org needs a second Worker.

> **Think hard before running two.** Two near-identical Worker URLs caused a live misconfiguration here. Pointing a PBX at the wrong one returns 401 when the keys differ, and when they match it silently writes that PBX's calls into the wrong org, which nobody notices until someone goes looking for records that were never created. A second Worker was deleted on 2026-09-08 for exactly this reason.

Per-PBX behaviour still varies independently, because call filtering, auto-create policy and transcript handling are template parameters sent as request headers, not Worker variables. A head office PBX can journal everything while a satellite logs inbound only, off the same Worker.

### Step 4 — Verify

Open a log stream, then make one real call from a number that is not in Salesforce:

```bash
npm run tail
```

What a healthy first call through a tracked queue looks like:

1. The agent's phone shows the caller as **New Caller**
2. At the end of the call the task POST logs `Tracked queues (queue 800, extension 102): created Lead 00Q…`
3. `Maintaining Lead 00Q…: appending call and upserting reminder`

Then check the other routes:

- Call again from the same number and confirm **no second record** is created and **no second reminder** is raised
- Call a home's main line from an unknown number and confirm the log says `unknown caller not answered through a tracked queue, dropped`

If step 2 shows `queue none` on a call that did come through the queue, 3CX is not filling in `[QueueExtension]` for that route, and nothing will be created until it does.

If any of that misbehaves, [Troubleshooting](#troubleshooting) covers the usual causes.

---

## Configuration

### Cloudflare variables

*Dashboard → Workers & Pages → your worker → Settings → Variables and Secrets*, except those marked **wrangler.toml**, which are deployed with the code. `keep_vars = true` stops a deploy wiping the dashboard values.

| Name | Type | Purpose |
|---|---|---|
| `SALESFORCE_LOGIN_URL` | wrangler.toml | The org's My Domain URL. Required; `login.salesforce.com` and `test.salesforce.com` are refused |
| `SALESFORCE_ORG_MODEL` | wrangler.toml | `contact` \| `personaccount` \| `lead` (default `contact`) |
| `SALESFORCE_HOME_FIELD` | wrangler.toml | Field a created record's care home is written to, e.g. `Care_Home__c`, for assignment rules. See [Routing by care home](#routing-by-care-home) |
| `SALESFORCE_HOME_VALUES` | var | Optional JSON map from 3CX department name to that field's value, e.g. `{"Oakhill":"Oakhill House"}`. Homes it does not list are sent as 3CX names them |
| `SALESFORCE_FALLBACK_OWNER` | var | Owner for a call log when 3CX finds no Salesforce user with the agent's email: a User Id or username, or a queue Id or API name for a queue that takes Tasks. See [When 3CX finds no Salesforce user](#when-3cx-finds-no-salesforce-user) |
| `SALESFORCE_EXTRA_FIELDS` | var | JSON of extra fields per object, e.g. `{"Lead":{"LeadSource":"Phone Enquiry"}}`. Add a picklist value in Salesforce before sending it |
| `HOME_COUNTRY` | var | ISO country for reading national-format numbers (default `GB`) |
| `MIN_SEARCH_LENGTH` | var | Type-ahead searches shorter than this are answered locally (default `3`) |
| `CALL_MERGE_WINDOW_MINUTES` | var | Transferred-leg consolidation window (default `5`, `0` disables) |
| `THREECX_URL` | wrangler.toml | The PBX's web address, `https://cedarcare.my3cx.uk`. With the two secrets below, home names are read from 3CX departments |
| `THREECX_CLIENT_ID` | secret | Client ID of the 3CX API client (Admin → Integrations → API, with Configuration API access and the System Admin role) |
| `THREECX_CLIENT_SECRET` | secret | That API client's secret, shown once when it is created |
| `EXTENSION_DEPARTMENTS` | var | Fallback only, when the 3CX API is not configured: JSON map of extension or prefix to home name, e.g. `{"03":"Arbour Walk"}`. Longest prefix wins |
| `SALESFORCE_EXTERNAL_ID_FIELD` | wrangler.toml | Unique External ID field holding the E.164 number, e.g. `Phone_E164__c`. Makes dedup structural (see below) |
| `ALERT_WEBHOOK_URL` | secret | Optional. Background failures are POSTed here as JSON (Slack, Teams, Zapier). A webhook address lets anyone post to that channel, so store it as a secret |
| `PROXY_API_KEY` | secret | Shared key 3CX must send as `X-Proxy-API-Key` |
| `SALESFORCE_CLIENT_ID` | secret | Connected App consumer key |
| `SALESFORCE_CLIENT_SECRET` | secret | Connected App consumer secret |

Dashboard changes apply immediately — **no redeploy needed**. Home names are re-read from 3CX at most hourly.

### 3CX settings

*Admin console → Integrations → CRM*

| Setting | Purpose |
|---|---|
| Cloudflare Worker URL | Points 3CX at this proxy |
| Proxy API Key | Must match `PROXY_API_KEY` |
| Tracked Queues | CSV of queue extensions, e.g. `800, 801` or `80*`. Only calls answered through these create a record for an unknown caller. Blank means nothing is ever created |
| Excluded Extensions | CSV of extensions or queues, `*` for prefix. Nothing about these calls reaches Salesforce, and it overrides Tracked Queues and Always Log |
| Always Log Calls For Existing Records | On (default): calls from people already in Salesforce are logged whatever the route. Off: only through a tracked queue |
| New Enquiries Create Leads | On (default). A new enquiry through a tracked queue becomes a **Lead** |
| New Enquiries Create Person Accounts | Off (default). On, it **overrides** Leads and the enquiry becomes a **Person Account**. With both off, nothing is created at all, though callers already on file are still logged |
| Keep Call History On Leads | On (default). Off, a Lead keeps its call logs but no history in its Description |
| Keep Call History On Person Accounts | On (default). The same for Person Accounts, so an org can keep the history on enquiry Leads and leave converted Person Accounts clean |
| Diagnostic Logging | Off (default). On, the Worker logs what the template sent it and what it decided for each call. Numbers are masked and nothing said on a call is logged, so it is safe to leave on while chasing something |
| Log Answered Inbound / Missed / Answered Outbound / Unanswered Outbound | Per-direction on/off |
| Internal Extension Max Digits | Numbers this short are internal — never reach Salesforce (default 6) |
| Excluded Number Prefixes | CSV of your own numbers, e.g. `+441632960001, +4416329600`. Each entry matches every number starting with it, so use whole numbers or tight blocks (the second example covers ten numbers): an area code such as `0117` would drop every caller in that city. Up to 1,000 characters |
| Confidential Extensions | CSV, e.g. `3020, 4*`. The call is logged; transcript, summary, sentiment and recording link are not |
| Receptionist Extensions | CSV of digital receptionist and ring group extensions, e.g. `1001, 10*`. Their legs become one line, never name the record, and never count as someone answering a tracked queue. Tracked Queues count automatically |
| Store Call Transcripts | `Include full transcript` / `Metadata only` / `External inbound only`. `Metadata only` removes the transcript and recording link but still stores 3CX's AI summary and sentiment; use Confidential Extensions where those must go too |

---

### Making dedup structural

By default, duplicate prevention is *query-then-create with race convergence*: the Worker checks, creates, then re-queries and deletes its own record if a simultaneous call beat it to one. It has held up, but it is a mitigation, not a guarantee.

Create a **unique External ID** field on Contact / Lead / Account (e.g. `Phone_E164__c`, text, External ID, Unique) and set `SALESFORCE_EXTERNAL_ID_FIELD` to its API name. Creation then becomes a Salesforce **upsert keyed on that field**, and duplicates become impossible at database level — two simultaneous calls from one number cannot both insert, because Salesforce itself refuses the second.

If the field is missing, misspelt or hidden from the integration user, the Worker logs it once and falls back to matching on the phone fields with create-then-converge until it restarts. A misconfigured field degrades the guarantee rather than stopping records being created.

### Routing by care home

With `SALESFORCE_HOME_FIELD` set, a record created for an enquiry carries its home in that field from the moment it is inserted, so a Lead assignment rule can route it by home. The home is the 3CX department of the tracked queue the enquiry came through, or of the extension that answered it.

The value must be one the field accepts. On a restricted picklist, a department name that does not match refuses the insert: the Worker retries without the home, reports it to `ALERT_WEBHOOK_URL`, and the Lead falls to the rule's default. On an unrestricted picklist Salesforce saves whatever it is sent, so a mismatch is silent. Either way, check the field's values against the 3CX department names, and set `SALESFORCE_HOME_VALUES` wherever they differ. If the field is a lookup rather than a picklist, the map's values must be record Ids.

A field the org does not have or the integration user cannot edit, and a value the field refused, are reported once and then left off later inserts until the Worker restarts. A deploy clears that at once, and Cloudflare replaces Worker instances regularly anyway, so a picklist fixed in Salesforce is soon picked up. Set `ALERT_WEBHOOK_URL`: without it these refusals appear only in `wrangler tail`.

### When 3CX finds no Salesforce user

The template looks up the answering agent's Salesforce user by the email on their 3CX extension, and makes them the call log's owner. The reminder and any error alert follow it. When nobody matches (no user, an inactive one, or a different email) the call log is still saved and linked, but owned by the integration user, where it shows in nobody's task list.

`SALESFORCE_FALLBACK_OWNER` names who gets those instead. A queue works, provided Task is one of its supported objects (Setup → Queues). The Worker checks it is an active Standard user, or a queue that takes Tasks, at most hourly.

An owner Salesforce refuses never costs the Task. If 3CX's user is refused on a call log (a licence that cannot own Tasks, say), the fallback owner is tried in its place, then the integration user. A refused fallback owner is set aside for an hour and reported, and a refused reminder or error alert owner is dropped the same way.

The best fix is still at source: make each 3CX extension's email match the person's Salesforce user.

### Retention

What was said on a call (transcript, summary, sentiment) and any name heard live on the **call log**, a Task, and nowhere else. The record's call history keeps only when, which way, how long, who took the call and the recording link, and the reminder keeps the unverified name hint.

So an org that deletes call logs after a retention period deletes the words with them. Reminders (`Action Required: …`, which carry the name hint) and error alerts (`3CX Integration Error: …`) are Tasks too, but not call Tasks, so a job that selects calls must be told to include them. Recordings themselves stay in 3CX under its own retention settings.

What this does not reach, all from earlier versions of the Worker:

- a history entry written with a transcript, until the next call from that number trims it
- the `===== … =====` call blocks written before the history format, which sit outside the marker lines and are left alone
- a Lead converted since, which Salesforce no longer lets anyone edit

In Cedar Care's UAT org these are test records. Delete them rather than carry them into production, which starts clean.

### When Salesforce refuses a field

A field the integration user cannot read fails the **whole** query it appears in, and Salesforce words it exactly like a field that does not exist: `No such column 'PersonHomePhone' on entity 'Account'`. Two rules keep one hidden field from taking the integration down, as it did on 16 September 2026:

- **A refused 3CX lookup never reaches 3CX.** It is answered as "nobody matched", so an unknown caller still gets a stand-in and the call is still journaled. 3CX does not journal a call whose lookup returned an error, so passing the error on costs the call log, the transcript and the record.
- **A refused query is retried without the field it named**, and that field is left out of later queries until the Worker restarts. Callers are then matched on the fields that remain, which is narrower but works.

Both are reported in `wrangler tail`, and through `ALERT_WEBHOOK_URL` if one is set. Neither is a substitute for granting the field: check [SALESFORCE-PERMISSIONS.md](SALESFORCE-PERMISSIONS.md) after any change of run-as user, since field permissions belong to the user, not the app.

### When background work fails

Adding the call to the record and upserting the reminder happen *after* the call log is safely saved. If that background step fails, the call is still logged but the record's history or reminder may be missing it, and previously nothing said so.

Failures now raise a **`3CX Integration Error:` task** on the affected record, high priority, one per record rather than one per call. It uses a different subject from the caller reminders deliberately, so the reminder upsert cannot overwrite it and the auto-close cannot silently clear it.

Set `ALERT_WEBHOOK_URL` as well if you want a signal that survives Salesforce itself being down, since a Salesforce outage is exactly when a Salesforce task cannot be created. The webhook is also the only place problems with no record to hang a task on are reported: an enquiry through a tracked queue that could not be given a record, an optional field or value Salesforce refused on a new record, a new record the integration user could not read back, and a refused fallback owner. Webhook reports are sent after the response to 3CX, so a slow webhook never delays a call.

---

## What it can do

- Create a record only for enquiries answered through a tracked queue, named after the home they came in on, with the home in a field assignment rules can route on
- Log transcription, summary, sentiment and recording link on the call log, and a short call history on the record, so deleting call logs deletes what was said
- Give call logs an owner when 3CX finds no Salesforce user for the agent
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
- Forward only the queries and searches the 3CX template makes, so the proxy key cannot delete records or reach any other Salesforce API
- Keep a call log Salesforce refuses for its link, by saving it unlinked and raising an alert
- Write custom fields via config, without a code change

## What it cannot do

- **Make 3CX transcribe a call it was not told to** — transcription is set per extension *and* per department, ring group and queue. An outbound call originates at the extension so the extension setting applies; an inbound call is handled by a group or queue first, and takes that object's setting. Enabling it only on users gives transcribed outbound calls and silent inbound ones, with the recording link present either way.

- **Run two CRM integrations on one 3CX PBX** — a 3CX limit. Testing against a second Salesforce org means either a second PBX or switching the Worker URL for a test window.
- **Reveal `PROXY_API_KEY`** — it's a Cloudflare secret. It can be replaced, never read back. Keep a copy when you rotate it.
- **Guarantee dedup at database level *without* an External ID field** — available and enabled for Cedar Care (`Phone_E164__c`); without it the fallback stays query-then-create with race convergence.
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
npm test                       # 478 checks — no network, no credentials needed
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
| [wrangler.toml](wrangler.toml) | Worker name and the values that define which org it writes to |
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
| `403 Forbidden` from the proxy | The request is not one the 3CX template makes. The proxy only forwards SOQL queries, SOSL searches and call logs. |
| Enquiries named `Phone Enquiry …` instead of a home | The 3CX API is not configured or not reachable, or the queue is not in a department. `wrangler tail` shows `Could not read home names from 3CX`. |
| No record for a genuine enquiry | The call did not come through a tracked queue, or nobody answered. Check the queue extension is in Tracked Queues, and look for `queue none` in `wrangler tail`. |
| Agent sees "New Caller" | Expected on a first call from an unknown number. The record is created when the call ends, if it came through a tracked queue. |
| Nothing created and no task logged | The number matched a filter (internal length or excluded prefix). `wrangler tail` logs every filter decision. |
| Duplicate contacts appearing | Check `SALESFORCE_ORG_MODEL` matches the org — Contact mode against a Person Account org creates the wrong object type. |
| Salesforce rejects record creation | Usually a validation rule, a duplicate rule set to Block, or a required custom field. `wrangler tail` shows the exact Salesforce error. |
| `Salesforce refused Care_Home__c on a new Lead` | The home is not a value the field accepts, or the field is missing or not editable. Compare the field's values with the 3CX department names and set `SALESFORCE_HOME_VALUES`. |
| `Created Lead … but could not read it back` | An assignment rule gave the Lead to an owner the integration user cannot see. Grant it View All and Modify All on Lead. |
| Every request returns 502, `SALESFORCE_LOGIN_URL must be the org's My Domain URL` | The login URL is blank, has a path, or is `login.salesforce.com` / `test.salesforce.com`. |
| Call logs owned by the integration user | 3CX found no active Salesforce user with the agent's extension email. Match the emails, or set `SALESFORCE_FALLBACK_OWNER`. |
