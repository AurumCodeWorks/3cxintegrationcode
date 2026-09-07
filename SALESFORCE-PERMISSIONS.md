# Salesforce permissions for the integration user

Everything the run-as user needs, so the integration can be stood up in a new org without discovering each missing permission through a failed call.

Build this as a **permission set** rather than by editing a profile. It only affects who you assign it to, and it is one artefact to redeploy to production rather than a list of checkboxes to remember.

> **Why this matters more than it looks.** Salesforce reports a field hidden by field-level security as `No such column 'X' on entity 'Y'`, identical to a field that does not exist. The Worker treats a failed query as "Salesforce is unreachable" and creates nothing, so a single hidden field silently disables the whole integration. Calls stop logging and nothing obvious explains why.

---

## Object permissions

Only the objects for your `SALESFORCE_ORG_MODEL` are strictly required, but granting all four costs nothing and lets you switch models without revisiting this.

| Object | Read | Create | Edit | Delete | Why |
|---|:--:|:--:|:--:|:--:|---|
| **Contact** | ✅ | ✅ | ✅ | ✅ | Lookup, dedup, ring-time creation, transcript append |
| **Account** | ✅ | ✅ | ✅ | ✅ | Person Accounts in `personaccount` and `lead` modes |
| **Lead** | ✅ | ✅ | ✅ | ✅ | `lead` mode, and the template's own Lead lookup |
| **Task** | ✅ | ✅ | ✅ | | Call logs, reminder upsert, transferred-leg merge |

**Delete is genuinely needed.** When two calls from one number arrive simultaneously, both create a record and the Worker deletes its own loser so a single record survives. Without Delete the convergence fails and you get the duplicate it exists to prevent.

Task needs no Delete. Reminders are completed, never removed.

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
| MobilePhone, HomePhone, OtherPhone, AssistantPhone | Read |
| Fax, Title, Department, Email, AccountId | Read |

The four phone fields beyond `Phone` are all matched against when identifying a caller. Hiding any one narrows who the system can recognise.

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
| MobilePhone, Email, Title, Fax, Company, IsConverted | Read |

`Company` must be **writable and not required**, because a Lead with a blank Company is what converts into a Person Account rather than a business Account plus Contact.

### Task

| Field | Access |
|---|---|
| Subject, Status, Priority, TaskSubtype | Read + **Edit** |
| ActivityDate, Description, WhoId, WhatId, OwnerId | Read + **Edit** |
| CallDurationInSeconds, CallType | Read + **Edit** |
| IsClosed, CreatedDate | Read |

---

## Record types

In `personaccount` or `lead` mode the user must have the **person account record type assigned**, or an insert carrying that `RecordTypeId` is rejected.

Permission set → Object Settings → Accounts → Record Types → tick the person type.

Separately, for a human to convert a Lead in the UI, their profile needs a **default Account record type**. That is a profile setting rather than a permission set one, and without it conversion fails with "Unable to find default record type". The Worker is unaffected either way since it always sets the type explicitly.

---

## Also worth checking

**Login IP ranges.** If the run-as user's profile restricts login by IP, token requests fail intermittently as Cloudflare's egress address moves. Set the External Client App's **IP Relaxation** to *Relax IP restrictions*.

**Duplicate rules and validation rules** on Contact, Lead and Account. These reject API inserts, and from the phone system's side the failure is invisible.

**Required custom fields.** Any field marked required that the Worker does not populate will block every insert. Supply a value through `SALESFORCE_EXTRA_FIELDS` if so.

---

## Use a dedicated integration user

Not a person's account. Every record the Worker creates is owned by the run-as user, so a leaver being deactivated stops the integration and orphans the records. A named integration user also makes it obvious in the audit trail which changes came from the phone system.

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
  "Lead:MobilePhone" "Lead:Company" "Lead:IsConverted" \
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

A seventh, `Contact.Description`, was found later. It is where the call transcript is appended, so the integration would have logged calls without ever recording what was said.

After granting all seven, the full chain was verified by exercising it rather than reading checkboxes: create a Person Account, PATCH it, read back `PersonContactId`, delete it. All four succeeded, confirming Create, Edit, Delete, the person record type assignment, and that `PersonContactId` resolves so `Task.WhoId` can link a call log.

The first symptom was 3CX reporting `No such column 'AssistantPhone' on entity 'Contact'` during a contact search. The more serious problem was invisible: in `personaccount` mode the Worker's own lookup selects `PersonHomePhone`, so it would have failed on every call while appearing to work.
