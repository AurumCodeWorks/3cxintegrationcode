# 3CX PBX setup

How to configure the phone system itself: trunk, outbound rules, emergency numbers and inbound routing, in a way that supports occasional international dialling and stays consistent with the Salesforce integration.

This is separate from [README.md](README.md), which covers the Cloudflare Worker and the CRM template. A working PBX is a prerequisite for that, not part of it.

---

## The principle: E.164 everywhere

Every number leaving the PBX should be in full international format (`+441632960003`, `+33123456789`), and every number stored in Salesforce already is. Get this right once in the outbound rules and the rest of the system stops caring where a number came from.

The alternative, passing national format and hoping the carrier copes, works until the first international call or the first number pasted out of Salesforce.

**Do not use a dial-out prefix such as 9.** It is a habit from legacy PBXs, 3CX does not need it, and it puts a stray digit in front of numbers that then flows into call logs and CRM lookups.

---

## 1. Trunk

**Voice & Chat → Trunks → Add Trunk.** Use the provider's template if one exists rather than Generic SIP, since it presets the SIP quirks correctly.

| Setting | Value |
|---|---|
| Main Trunk Number | Your main DDI in E.164, e.g. `+441632960002` |
| Authentication ID / password | From the provider |
| Registrar/Server | e.g. `sip39.voiceflex.com`, port `5060` |
| Default route | A destination that **has registered members** (see the warning below) |

Then the **Options** tab:

| Setting | Value |
|---|---|
| Maximum simultaneous calls | The channel count the provider has actually provisioned |
| Codec priority | G.711 A-law (**PCMA**) first for the UK, G.711 mu-law (PCMU) second |

> **A trunk with zero simultaneous calls registers perfectly and passes every diagnostic, then refuses every call in both directions.** Outbound reports "no phone lines available", inbound returns busy tone, and the SIP Trunk Checker still shows registration successful, because registering does not consume a channel. If both directions fail on a healthy-looking trunk, check this first and then ask the provider how many channels are provisioned.

> **A default route pointing at a group with no registered members returns `486 Busy Here`.** On a new PBX this looks identical to a trunk fault. Point it at a registered extension while testing.

---

## 2. Outbound rules

**Voice & Chat → Outbound Rules.** 3CX evaluates these **top down and takes the first match**, so the order below is not optional. `00353…` also starts with `0`, so a `0` rule placed above a `00` rule swallows every international call.

| # | Prefix | Strip | Prepend | Handles |
|---|---|---|---|---|
| 1 | `00` | 2 | `+` | International access code |
| 2 | `+` | 0 | *(none)* | Already E.164, pass through untouched |
| 3 | `1` | 0 | *(none)* | UK service numbers, pass through untouched |
| 4 | `0` | 1 | `+44` | UK national |

All four route to the trunk. Leave **Outbound caller ID** blank so it falls back to the trunk's main number, and set per-extension caller ID only where someone needs to present a direct number.

Leave **Prefix**, **Calls from extension(s)**, **Length** and **Department** blank wherever the table doesn't specify a value. Blank means "any", including for Department.

### Why each rule exists

**Rule 1** turns `00353871234567` into `+353871234567`. Without it, international dialling either fails or gets mangled by the UK rule.

**Rule 2** matters more than it looks. Staff copy numbers out of Salesforce, and Salesforce stores E.164. Without this rule, `+447911123456` falls through to rule 4 and becomes `+44770090099956`.

**Rule 3** covers `101`, `111`, `118xxx` and similar. These start with `1`, so they match no other rule and would otherwise have no route at all. **NHS 111 is not optional in a care home.**

**Rule 4** is the everyday case: `07911123456` becomes `+447911123456`.

### What a single catch-all rule does instead

A blank-prefix rule with strip 1 and prepend `+44` applied to everything:

| Dialled | Result | |
|---|---|---|
| `07911123456` | `+447911123456` | correct |
| `+447911123456` | `+44770090099956` | broken |
| `00353871234567` | `+441632960005567` | broken |
| `999` | `+4499` | **emergency call destroyed** |

### Restricting international

International is occasional here, which makes it worth limiting. Set **Calls from extension(s)** on rules 1 and 2 to a range, e.g. `200-210`. Everyone else then fails to match and cannot dial abroad.

The failure mode this protects against is a compromised extension dialling premium international numbers overnight, which is expensive and usually discovered on the bill.

---

## 3. Emergency and service numbers

**Voice & Chat → Emergency Numbers.** Configure `999` and `112`, routed out of the trunk, applying to **every** extension regardless of any calling restrictions.

Register the correct address details for each DDI with the provider. That is what determines which control room receives the call, and it is the part people forget when a site moves.

> **Do not test by dialling 999.** Verify the configuration, then ask the provider whether they offer an emergency test number.

Check that `111` and `101` complete as well, via rule 3 above. In a care home these get used in earnest.

---

## 4. Inbound

**Trunk → DID Numbers.** Add each DDI the provider has routed to this trunk.

> **Enter only the last six to nine digits**, e.g. `2032188` rather than `+441632960002`. 3CX matches DIDs on the trailing digits, so a short form matches regardless of whether the carrier presents E.164, national, or bare significant digits. A full-format mismatch is the single most common cause of "inbound doesn't work" on a trunk that is otherwise fine.

Then **Voice & Chat → Inbound Rules**, one per DDI:

| Field | Value |
|---|---|
| DID/DDI | The number added above |
| Office hours destination | Ring group, queue, or digital receptionist |
| Out of hours destination | For a care home, usually the same, since they are staffed overnight |

If a call arrives and lands somewhere unexpected, take a SIP trace and read the `To` header on the `INVITE`. That tells you exactly what the carrier sent, rather than guessing at the format.

---

## 5. Extensions

Keep extension numbers to **six digits or fewer**, which any normal numbering plan already does.

The Worker treats anything at or below `InternalMaxDigits` (default 6) as an internal call and keeps it out of Salesforce entirely. Three-digit extensions like `200-299` are well inside that. This is also why `999`, `111` and `101` never create CRM records.

---

## 6. How this lines up with the Salesforce integration

| PBX behaviour | Effect on the integration |
|---|---|
| Outbound normalised to E.164 | Dialled numbers match what Salesforce stores, so outbound calls journal against the right record |
| Inbound caller ID in any format | Harmless. The Worker normalises via libphonenumber before any lookup |
| No dial-out prefix | No stray digits reaching the CRM lookup |
| Extensions ≤ 6 digits | Internal calls stay out of Salesforce automatically |
| Emergency and service numbers short | Never create CRM records |

The Worker is deliberately forgiving about inbound formats, so the PBX side only really has to get **outbound** right.

---

## 7. Verification

In order, because each step depends on the last:

1. **Trunk registers.** SIP Trunk Checker → Trunk Analysis shows registration successful.
2. **An extension is registered.** Web Client logged in, status green. Several tests fail confusingly without this.
3. **Outbound to a UK mobile.** Confirm it connects and the recipient sees the right caller ID.
4. **Outbound international.** Dial both the `00…` and `+…` forms of the same number and confirm both connect. This is the rule-ordering test, and the one most likely to expose a carrier restriction rather than a config error.
5. **Inbound to each DDI.** Confirm it rings the intended destination.
6. **`111` completes.**
7. **CRM behaviour.** With `npm run tail` running, call in from a number not in Salesforce and confirm a record is created at ring time and the transcription lands afterwards.

---

## 8. What to confirm with the carrier

Registration succeeding proves only that the PBX can reach them and authenticate. It says nothing about whether calls are permitted. Ask explicitly:

- How many **concurrent channels** are provisioned on the trunk
- Is the account enabled for **outbound** as well as inbound
- Is **international dialling** enabled, since it is very often barred by default to limit toll fraud exposure
- Are the **DDIs routed** to this trunk
- Is the PBX's public IP whitelisted for **call delivery**, not just registration
- Which **number format** they present on inbound
