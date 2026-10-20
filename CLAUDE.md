# CLAUDE.md

Guidance for Claude Code working in this repository. Read this before changing anything.

## What this is

A single Cloudflare Worker that sits between a **3CX V20 phone system** and **Salesforce REST v55.0**. 3CX's CRM template talks only to the Worker; the Worker holds the Salesforce credentials, decides what deserves a record, and cleans up what 3CX cannot do itself.

It is live for **Cedar Care Homes** (20 care homes, one PBX, one Salesforce org):

| Thing | Value |
|---|---|
| Worker | `3cx-salesforce-proxy-cedarcare` at `https://3cx-salesforce-proxy-cedarcare.autumn-truth-82d5.workers.dev` |
| Salesforce | **Production** (`cedarcarehomes.my.salesforce.com`) since 20 October 2026, org model `lead`. The UAT sandbox (`cedarcarehomes--uat.sandbox.my.salesforce.com`) still exists but nothing writes to it |
| PBX | `https://cedarcare.my3cx.uk`, template version in `cloudflare_salesforce_integration.xml` |
| Owner | Dan Golding, the integration engineer. He does **not** use 3CX or Salesforce day to day |

Everything user-facing is documented in [README.md](README.md). This file is about how to work on it.

## Hard rules

1. **Never enter, echo, paste or commit a credential.** Not into Cloudflare, not into 3CX, not into a file, not into a command. Dan runs `npx wrangler secret put …` himself. If a key appears in the conversation, do not repeat it back.
2. **Never change which Salesforce org the Worker talks to** unless Dan says so in that message. It writes to Cedar Care's live CRM, so every call through a tracked queue is a real enquiry. Moving orgs is the swap described above `SALESFORCE_LOGIN_URL` in `wrangler.toml`: the URL and the credentials must move together, and Dan sets the credentials himself.
3. **This repository is private and must stay private.** It holds Cedar Care's org URLs, queue numbers and PBX details. Their DDI lists are gitignored and never enter it.
4. **Never lose a call.** Every design choice bends to this: a record that cannot be created still gets its call logged unlinked; a field Salesforce refuses is dropped, not the record; an owner it refuses is dropped, not the Task.
5. **Never write a name onto a record from a call.** Transcriptions mishear and 3CX phonebooks go stale. A name heard on a call is an unverified hint on the reminder Task only.
6. **Nothing said on a call goes onto a Lead, Contact or Account.** Transcript, summary, sentiment and name hints live on the call log Task, so Cedar Care's 7 year deletion job removes them. See "Retention" in the README.
7. **Alerts belong inside Salesforce**, as Tasks for whoever took the call. `ALERT_WEBHOOK_URL` is an optional extra for whoever maintains the integration, and is not set.
8. Commit messages end with:
   `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Commands

```bash
npm test                       # 599 offline checks, no network or credentials
npm run deploy                 # runs the tests, then deploys
npm run tail                   # live Worker logs, including every filter decision
npx wrangler deploy --dry-run --outdir dist    # bundle check only
```

The test suite mocks the whole Salesforce API. It must stay offline and credential free.

## Repository map

| Path | What it is |
|---|---|
| `src/index.js` | The entire Worker. One file on purpose |
| `test/worker.test.mjs` | The whole test suite, same style throughout |
| `cloudflare_salesforce_integration.xml` | The 3CX CRM template. Bump `Version` whenever parameters change, and tell Dan to re-upload and re-paste the API key |
| `wrangler.toml` | Worker name and the values that decide which org it writes to |
| `README.md` | How the system behaves, setup, configuration, troubleshooting |
| `SALESFORCE-PERMISSIONS.md` | Every object, field and sharing permission the integration user needs |
| `3CX-PBX-SETUP.md` | Building the PBX itself: trunk, routing, recording, transcription, retention |
| `ddi-*.csv/.txt`, `*-excluded-prefixes.txt` | Cedar Care's numbers. Customer data, gitignored, local only. Never commit them |

## How the domain actually works

These are hard-won and not obvious. Do not re-derive them, and do not design around guesses.

- **3CX only journals a call if the CRM lookup matched something.** No match means the call log, transcript and recording are silently discarded. This is the whole reason the Worker exists.
- **A lookup sees almost nothing:** the number, the direction, and nothing about the route. The queue only arrives later, with the call journal, as `[QueueExtension]`. So the "should this become a record" decision happens at journaling, not at ring time.
- **An unknown caller is answered with a stand-in match**, `PENDING_CALLER_<digits>`, purely so 3CX will journal the call. `applyTrackedQueueGate` then resolves it into a real record or drops the call.
- **3CX journals once per extension leg**, not once per call, and gives CRM templates no call identifier. Legs are correlated by caller plus timing inside `CALL_MERGE_WINDOW_MINUTES`, deliberately biased toward merging.
- **A queue or receptionist leg is not someone answering.** `[Agent]` is the queue itself when nobody picked up, so the gate must not read that leg as an answered call. The enquiry is still captured — Capture Missed Enquiries is on by default and creates the record with a ring-back reminder — but as a missed one, which is why `agentIsRouting` and `missed` are separate facts in `trackedQueueGate`.
- **Cedar Care's rule:** only calls through a tracked queue (New Care Enquiries per home, plus Head Office Placement Team) create a record. Callers already on file are logged whatever the route, unless the template's Always Log toggle is off. Excluded Extensions always wins.
- **A home's enquiry line means that home; head office placements mean none yet.** Someone ringing placements (queue 8131) can be quoted for any home, so those Leads carry no `Care_Home__c` by design. The department is mapped to an empty value in `SALESFORCE_HOME_VALUES`, which leaves the field unset while the Lead is still named after the route.
- **Salesforce applies Lead assignment rules on API insert by default**, so a new Lead can belong to someone else before the Worker reads it back, and `Sforce-Auto-Assign: FALSE` is sent on every PATCH so appending a call never reassigns a Lead.
- **A duplicate rule set to "Allow" refuses an API insert** unless `Sforce-Duplicate-Rule-Header: allowSave=true` is sent. Enquiry records at one home look alike by name, so without this they block each other.
- **The client credentials flow is only served by the org's My Domain URL.** `login.salesforce.com`, `test.salesforce.com` and the Lightning address are refused with a clear error.
- **Home names come from 3CX departments** through the Configuration API (`THREECX_*`), cached hourly. Every home is a department named after it. The Worker reads the **department**, never the queue name: a queue called "Larkhall Springs - New Care Enquiries Queue" under a department called "Larkhall" stamps "Larkhall". So department names must match the `Care_Home__c` picklist exactly; three were renamed on 21 September 2026 to make them match. `SALESFORCE_HOME_VALUES` translates any that cannot be renamed.

## Invariants worth a test

If a change could break one of these, add or update a check in `test/worker.test.mjs`:

- A call is never dropped because Salesforce failed. It is logged unlinked and an alert Task is raised.
- **A lookup never answers with an error**, whatever failed — a refused field, a dropped connection, even no access token at all. An error answer is a call 3CX will not journal, so it costs the enquiry outright. "Nobody matched", or a stand-in, and the journal sorts it out minutes later.
- Nothing said on a call reaches a Lead, Contact or Account Description, including through the merge and legacy paths.
- No record is ever created for an unknown caller outside a tracked queue.
- The proxy forwards only the SOQL queries, SOSL searches and call logs the 3CX template makes. Everything else is 403.
- Numbers are canonicalised to E.164 everywhere: lookup, storage, dedup, exclusion lists.
- Records are deduplicated structurally through `Phone_E164__c`, with create-then-converge as the fallback.
- Refusals degrade: an optional field is dropped, an owner is dropped, the External ID is set aside. The record and the call survive.

## Working practice here

- **Change the code, then break it on purpose.** After adding a test, mutate the source so the behaviour is wrong and confirm that test fails. Several tests in this suite only exist because a mutation slipped through and the test was tightened.
- **Read `src/index.js` around what you touch.** The comments carry the reasoning, usually including what went wrong last time.
- **Prefer an existing helper.** Phone handling, extension matching, call parsing, section splitting and history building all have one home each.
- **Write comments about why, in the same voice as the file.** Not what the line does.
- **British English in docs and code comments.**
- **Email drafts for Dan:** no dashes of any kind, plain British English, in his voice. He forwards them to the customer.
- **Small workflows, Sonnet first** for judging and fact checks; the main model for the reasoning. Dan watches his session budget.
- **Do not add speculative features.** Everything here was asked for, including the parts that look over-engineered.

## Environment gotchas

- Bash heredocs in this environment mangle backslashes: a regex written into a script through one loses its escapes. Write script files with the Write tool instead.
- The shell is Git Bash, but the box is Windows. PowerShell commands need PowerShell syntax; do not hand Dan bash one-liners for it.
- In `wrangler.toml`, `keep_vars = true` **must** sit above `[vars]`. Below it, TOML reads it as a variable and every deploy wipes the dashboard values.
- Dashboard variables and secrets are not in this repo. `wrangler.toml` lists their names in comments.
- `wrangler` is a pinned devDependency; `package.json` is `"type": "module"`.
- Every deploy, every `wrangler secret put` and every save in the dashboard creates a new deployment, and a running `wrangler tail` does not survive one. Restart it afterwards.

## What took it down on 16 September 2026

Worth knowing before changing anything in the lookup path, because it was silent and total.

Cedar Care switched the Run As user to the Automated Process User. Field permissions belong to the user, so everything granted on 3 September was hidden again. The template's Contacts lookup asked for `AssistantPhone`, Salesforce refused the search, the Worker passed the 400 back, **and 3CX does not journal a call whose lookup failed**. No call logs, no transcripts, no Leads, for every call, with nothing on any record to show for it. Underneath that, the Worker's own Person Account query still selected `PersonHomePhone`, which failed the same way.

So: **never let a Salesforce error reach 3CX from a lookup**, and **never treat one refused field as "Salesforce is down"**. Both are now handled in `handleLookupProxy` and `sfQuery`, with tests under "Surviving a Salesforce that refuses things".

Also from that week: a deploy was made with `keep_vars` sitting below `[vars]`, so it was read as a variable and every dashboard-managed variable was wiped. Check `npx wrangler versions view <id>` for a stray `env.keep_vars` binding after any deploy someone else made.

## State, as of 20 October 2026

- **Live on production** since 20 October 2026, running as the Automated Process User (`autoproc@cedarcarehomes.com`, System Administrator profile).
- **`Phone_E164__c` does not exist in production yet.** The field check reports `INVALID_FIELD` on Contact, Account and Lead. The Worker has set the External ID aside and matches on phone fields alone, so duplicates are caught by create-then-converge rather than prevented structurally. Waiting on Cedar Care to create it (Text 20, External ID, Unique, on all three), grant it in the permission set and backfill it. **Redeploy afterwards**: a field the Worker has set aside is only tried again after a restart.
- `SALESFORCE_FIELD_CHECK` is on in the dashboard so the first request after each deploy reports what the run-as user can read. Turn it off once `Phone_E164__c` reads cleanly.
- `SALESFORCE_EXTRA_FIELDS` stamps `Enquiry_Type__c` "Care Home Enquiry", `LeadSource` "Other" and `Enquiry_Channel__c` "Phone" on every new Lead, as Cedar Care asked on 21 September. All three read cleanly in production.
- The Head Office department is still called "Head Office (Mortimer House)". It is due to become "Head Office", with `SALESFORCE_HOME_VALUES` set to `{"Head Office": ""}`. Until then a placement Lead tries to write the bracketed name into `Care_Home__c`, and a bracketed department name also strips the recording line from a transferred call's history entry.
- Tracked Queues holds 34 queues: the home enquiry lines and their out of hours twins, 8131 Head Office Placements and 8146. 8016 (Marketing Direct Transfer) was removed.
- Cedar Park is not open yet and has no enquiry queue. When it opens it needs its New Care Enquiries queue added to Tracked Queues, a department named exactly as its picklist value, and that value on `Care_Home__c`.
- Template is at version 57 in this repo. Contact and Lead lookups were narrowed to `Phone` and `MobilePhone` because the UAT org hid `HomePhone`, `OtherPhone`, `AssistantPhone`, `Fax`, `Title` and `Department`, and one hidden field fails the whole lookup.
- Still waiting on Cedar Care: `Phone_E164__c`, their duplicate rule review, and who `SALESFORCE_FALLBACK_OWNER` should be.
- Known gap: a caller whose number was typed in an unusual format (`07393 178 055`) is not matched, so they can get a second Lead. Fixing it means a SOSL phone search before creating a record.
