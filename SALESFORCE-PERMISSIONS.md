# Salesforce permissions for the integration user

Everything the run-as user needs, so the integration can be stood up in a new org without discovering each missing permission through a failed call.

Build this as a **permission set** rather than by editing a profile. It only affects who you assign it to, and it is one artefact to redeploy to production rather than a list of checkboxes to remember.

> **Why this matters more than it looks.** Salesforce reports a field hidden by field-level security as `No such column 'X' on entity 'Y'`, identical to a field that does not exist. That one refusal used to fail the whole query, and with it the whole integration — which is what the [16 September outage](#the-16-september-2026-outage-permissions-do-not-follow-a-run-as-change) was.
>
> Since then the Worker degrades instead: it drops the refused field, retries without it, and says so in the log. So a missing permission no longer stops calls being logged — it quietly costs you whatever that field did. A caller reachable only on a home number stops matching; a care home that cannot be written stops reaching the assignment rule. Nothing looks broken, which is why the check under [Verifying](#verifying) is worth running rather than assuming.

---

## Object permissions

Only the objects for your `SALESFORCE_ORG_MODEL` are strictly required, but granting all four costs nothing and lets you switch models without revisiting this.

| Object | Read | Create | Edit | Delete | Why |
|---|:--:|:--:|:--:|:--:|---|
| **Contact** | ✅ | ✅ | ✅ | ✅ | Lookup, dedup, ring-time creation, call history |
| **Account** | ✅ | ✅ | ✅ | ✅ | Person Accounts in `personaccount` and `lead` modes |
| **Lead** | ✅ | ✅ | ✅ | ✅ | `lead` mode, and the template's own Lead lookup |
| **Task** | ✅ | ✅ | ✅ | ✅ | Call logs, reminder upsert, transferred-leg merge |
| **User** | ✅ | | | | 3CX's own lookup of the answering agent by email, to set the call's owner, and the Worker's check that `SALESFORCE_FALLBACK_OWNER` is an active user |
| **Queue (QueueSobject)** | ✅ | | | | Only when `SALESFORCE_FALLBACK_OWNER` is a queue: the Worker checks the queue takes Tasks |

**View All and Modify All on Lead, where Lead sharing is Private.** A Lead assignment rule runs as the Worker inserts the Lead, so the Lead can belong to a home's user or queue before the Worker reads it back. Without View All the Worker cannot see the record it just created: the enquiry is logged unlinked, and later calls from that number are not matched. Converted callers need the same on Account and Contact. A sharing rule that shares the routed records with the integration user does the same job.

**Delete is genuinely needed.** When two calls from one number arrive simultaneously, both create a record and the Worker deletes its own loser so a single record survives. Without Delete the convergence fails and you get the duplicate it exists to prevent.

Task needs Delete for the same reason: two simultaneous calls can each raise a reminder, and the Worker deletes its own extra one.

---

## Field permissions

Read is enough for everything except the handful the Worker writes to, marked below.

### Contact

| Field | Access |
|---|---|
| Phone_E164__c *(if used as External ID)* | Read + **Edit** |
| FirstName, LastName | Read + **Edit** |
| Phone | Read + **Edit** |
| Description | Read + **Edit** |
| MobilePhone | Read |
| Email, AccountId | Read |
| IsPersonAccount | Read. The Worker uses it to tell a business Contact from a Person Account's hidden one, before raising an enquiry and when resolving which record a call belongs to |

Callers are matched on `Phone` and `MobilePhone`. `HomePhone`, `OtherPhone`, `AssistantPhone`, `Fax`, `Title` and `Department` were taken out of the template's lookups and the Worker's queries, because Cedar Care's org hides them and a single hidden field fails the whole lookup (see the findings at the end of this page). A caller reachable only on a home or other number is no longer matched: grant those fields and put them back if that matters more than the risk.

### Account (Person Accounts)

| Field | Access |
|---|---|
| Phone_E164__c *(if used as External ID)* | Read + **Edit** |
| FirstName, LastName | Read + **Edit** |
| Phone | Read + **Edit** |
| Description | Read + **Edit** |
| RecordTypeId | Read + **Edit** |
| PersonMobilePhone, PersonHomePhone, PersonOtherPhone | Read |
| PersonEmail, PersonContactId, IsPersonAccount, Name, Fax | Read |

> `PersonHomePhone` and `PersonOtherPhone` on Account are backed by `HomePhone` and `OtherPhone` on Contact. Granting the Contact fields normally clears the Account ones too, which is why they tend to fail together.

### Lead

| Field | Access |
|---|---|
| FirstName, LastName | Read + **Edit** |
| Phone, Description | Read + **Edit** |
| Phone_E164__c *(if used as External ID)* | Read + **Edit** |
| Care_Home__c *(the `SALESFORCE_HOME_FIELD`)* | Read + **Edit** |
| LeadSource *(if set through `SALESFORCE_EXTRA_FIELDS`)* | Read + **Edit** |
| MobilePhone, Email, Title, Fax, Company, IsConverted, ConvertedContactId, ConvertedDate | Read |

`Company` must be **writable and not required**, because a Lead with a blank Company is what converts into a Person Account rather than a business Account plus Contact.

A care home or Lead Source the integration user cannot edit is refused once and then left off every insert until the Worker restarts, so the Lead is still created but the assignment rule never sees its home. The script under [Verifying](#verifying) only shows the fields can be **read**: confirm **Edit** on both in the permission set itself.

### Task

| Field | Access |
|---|---|
| Subject, Status, Priority, TaskSubtype | Read + **Edit** |
| ActivityDate, Description, WhoId, WhatId, OwnerId | Read + **Edit** |
| CallDurationInSeconds, CallType | Read + **Edit** |
| IsClosed, CreatedDate, LastModifiedDate, CreatedById | Read |

---

## Record types

In `personaccount` or `lead` mode the user must have the **person account record type assigned**, or an insert carrying that `RecordTypeId` is rejected.

Permission set → Object Settings → Accounts → Record Types → tick the person type.

Separately, for a human to convert a Lead in the UI, their profile needs a **default Account record type**. That is a profile setting rather than a permission set one, and without it conversion fails with "Unable to find default record type". The Worker is unaffected either way since it always sets the type explicitly.

---

## Also worth checking

**Login IP ranges.** If the run-as user's profile restricts login by IP, token requests fail intermittently as Cloudflare's egress address moves. Set the External Client App's **IP Relaxation** to *Relax IP restrictions*.

**Duplicate rules and validation rules** on Contact, Lead and Account. These reject API inserts, and from the phone system's side the failure is invisible. The Worker opts in to saving past rules set to *Allow*; a rule set to *Block* still refuses the insert.

**Required custom fields.** Any field marked required that the Worker does not populate will block every insert. Supply a value through `SALESFORCE_EXTRA_FIELDS` if so.

---

## Use a dedicated integration user

Not a person's account. Every record the Worker creates is owned by the run-as user unless an assignment rule moves it, so a leaver being deactivated stops the integration and orphans the records. A named integration user also makes it obvious in the audit trail which changes came from the phone system.

Salesforce's client credentials documentation describes the run-as user as a dedicated integration user. Cedar Care's UAT app was switched to the Automated Process User on 15 September 2026; Salesforce documents nothing either way about that user in this role. Whoever it is, it needs everything on this page, so after any change of run-as user run the check below and make one test call.

The Worker only updates Tasks its own run-as user created. Open reminders raised under a previous run-as user are left alone, and the next call from that number raises a fresh one.

---

## Verifying

Rather than trusting the checkboxes, ask the org. With the Worker deployed and its key to hand:

```bash
K="<your PROXY_API_KEY>"
B="https://<your-worker>.workers.dev/services/data/v55.0/query/?q="

for spec in \
  "Contact:AssistantPhone" "Contact:HomePhone" "Contact:OtherPhone" \
  "Contact:MobilePhone" "Contact:Fax" "Contact:Description" \
  "Account:PersonHomePhone" "Account:PersonOtherPhone" "Account:PersonMobilePhone" \
  "Account:PersonContactId" "Account:RecordTypeId" "Account:Fax" \
  "Lead:MobilePhone" "Lead:Company" "Lead:IsConverted" "Lead:Care_Home__c" "Lead:LeadSource" \
  "Task:CallDurationInSeconds" "Task:TaskSubtype" "Task:WhoId"
do
  O=${spec%%:*}; F=${spec##*:}
  R=$(curl -s -H "X-Proxy-API-Key: $K" "$B$(printf 'SELECT+%s+FROM+%s+LIMIT+1' "$F" "$O")")
  case "$R" in
    *INVALID_FIELD*) echo "BLOCKED  $O.$F";;
    *totalSize*)     echo "ok       $O.$F";;
    *)               echo "?        $O.$F";;
  esac
done
```

Anything reported BLOCKED is hidden from the run-as user and will break the feature that depends on it.

---

## The 16 September 2026 outage: permissions do not follow a Run As change

Cedar Care changed the External Client App's Run As user to the **Automated Process User** on 15 September. Field-level security belongs to the user, not the app, so every field granted to the previous integration user on 3 September was hidden again from the new one. Two things followed:

1. The 3CX template asked for `AssistantPhone`, `HomePhone` and `OtherPhone` in its Contacts lookup. Salesforce refused the whole search, the Worker handed 3CX the error, and **3CX never journals a call whose lookup failed**. No call logs, no transcripts, no Leads, for every call.
2. Once the template was narrowed, the Worker's own Person Account query still selected `PersonHomePhone` and `PersonOtherPhone`. In `lead` mode that query runs first for every caller, so it failed, the Worker treated Salesforce as unreachable, and calls were logged unlinked with no Lead created.

Both now degrade instead of failing (see [When Salesforce refuses a field](README.md#when-salesforce-refuses-a-field)), but the fix is still to grant the fields. **After any Run As change, re-run the check in [Verifying](#verifying) and make one test call.**

## Findings: Cedar Care UAT, 3 September 2026

Six fields were hidden from `integration.user@example.com` on a freshly configured org:

| Field | Effect while blocked |
|---|---|
| `Contact.AssistantPhone` | 3CX's own contact search fails outright |
| `Contact.HomePhone` | Caller not matched on a home number |
| `Contact.OtherPhone` | Caller not matched on an other number |
| `Account.PersonHomePhone` | **Every Person Account lookup fails**, so nothing is created or matched |
| `Account.PersonOtherPhone` | As above |
| `Account.Fax` | 3CX's Account lookup fails |

Everything on Lead and Task was accessible, as were the remaining Contact and Account fields.

A seventh, `Contact.Description`, was found later. It is where the call history is written (at the time, with the transcript), so the integration would have logged calls without ever recording them on the record.

After granting all seven, the full chain was verified by exercising it rather than reading checkboxes: create a Person Account, PATCH it, read back `PersonContactId`, delete it. All four succeeded, confirming Create, Edit, Delete, the person record type assignment, and that `PersonContactId` resolves so `Task.WhoId` can link a call log.

The first symptom was 3CX reporting `No such column 'AssistantPhone' on entity 'Contact'` during a contact search. The more serious problem was invisible: in `personaccount` mode the Worker's own lookup selects `PersonHomePhone`, so it would have failed on every call while appearing to work.
