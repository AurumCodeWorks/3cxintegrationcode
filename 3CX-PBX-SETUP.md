# 3CX PBX build guide

Everything needed to take a new 3CX instance from empty to production for a care home group, including occasional international dialling, and configured so the Salesforce integration works without further changes.

Work through it in order. Each phase depends on the one before, and several diagnostics fail confusingly if you skip ahead.

[README.md](README.md) covers the Cloudflare Worker and the CRM template. A working PBX is a prerequisite for that, not part of it.

---

## Contents

1. [Before you touch the console](#phase-0--before-you-touch-the-console)
2. [Network and firewall](#phase-1--network-and-firewall)
3. [Trunk](#phase-2--trunk)
4. [Security and toll fraud](#phase-3--security-and-toll-fraud)
5. [Outbound rules](#phase-4--outbound-rules)
6. [Emergency and service numbers](#phase-5--emergency-and-service-numbers)
7. [Extensions and users](#phase-6--extensions-and-users)
8. [Ring groups and queues](#phase-7--ring-groups-and-queues)
9. [Inbound routing](#phase-8--inbound-routing)
10. [Digital receptionist and barge-in](#phase-9--digital-receptionist-and-barge-in)
11. [Business hours and holidays](#phase-10--business-hours-and-holidays)
12. [Voicemail, music on hold, prompts](#phase-11--voicemail-music-on-hold-prompts)
13. [Call recording and retention](#phase-12--call-recording-and-retention)
14. [Spam filter](#phase-13--spam-filter)
15. [The Salesforce integration](#phase-14--the-salesforce-integration)
16. [Backups and monitoring](#phase-15--backups-and-monitoring)
17. [Go-live checklist](#go-live-checklist)
18. [Failures that look like faults but are settings](#appendix--failures-that-look-like-faults-but-are-settings)

---

## The principle: E.164 everywhere

Every number leaving the PBX should be in full international format (`+441632960003`, `+33123456789`), and every number stored in Salesforce already is. Get this right once in the outbound rules and nothing downstream has to care where a number came from.

The alternative, passing national format and hoping the carrier copes, works until the first international call or the first number pasted out of Salesforce.

**Do not use a dial-out prefix such as 9.** It is a habit from legacy PBXs, 3CX does not need it, and it puts a stray digit in front of numbers that then flows into call logs and CRM lookups.

---

## Phase 0 — Before you touch the console

### Decide these first

| Decision | Notes |
|---|---|
| **Hosting** | 3CX-hosted is simpler: no firewall work, FQDN and certificate handled. Self-hosted gives control but you own the network config in phase 1. |
| **FQDN** | Fixed for the life of the system. Certificates, provisioning URLs and client configs all embed it. Changing it later means reprovisioning every phone. |
| **Numbering plan** | Keep extensions to **3 digits** and group them meaningfully, e.g. `1xx` reception and admin, `2xx` nursing, `3xx` management. Ranges make outbound restrictions and reporting trivial later. |
| **Licence tier** | Determines simultaneous calls and which features exist. Check it covers your expected concurrent call count with headroom. |

### Get from the carrier before you start

Chasing these mid-build is what turns a two-hour job into two days:

- SIP registrar hostname and port
- Authentication ID and password, or confirmation that they use IP authentication
- The **full list of DDIs** and which are routed to this trunk
- **How many concurrent channels** are provisioned
- Whether the account is enabled for **outbound**
- Whether **international dialling** is enabled, since it is usually barred by default
- Which **number format** they present on inbound calls
- The public IP they need whitelisted, if IP-authenticated

> Registration succeeding proves only that the PBX can reach them and authenticate. It says nothing about whether calls are permitted in either direction. Treat the channel count and the international flag as separate questions.

---

## Phase 1 — Network and firewall

Skip this entirely if you are 3CX-hosted.

Self-hosted needs these open inbound to the PBX:

| Port | Protocol | Purpose |
|---|---|---|
| 5060 | UDP and TCP | SIP signalling |
| 5061 | TCP | SIP over TLS |
| 5090 | UDP and TCP | 3CX tunnel and SBC |
| 9000-10999 | UDP | RTP audio |
| 443 / 5001 | TCP | Management console and Web Client |
| 80 / 5000 | TCP | Certificate issuance and renewal |

Then run the built-in **Firewall Checker** and do not proceed until it passes cleanly. Almost every "one-way audio" complaint traces back to the RTP range not being open or a SIP ALG mangling packets.

> **Disable SIP ALG on the router.** It is on by default on most business routers, it rewrites SIP packets badly, and the symptoms it produces (calls connecting with no audio, calls dropping at 30 seconds) look exactly like carrier faults.

If phones are on a different network from the PBX, deploy the **3CX SBC** at that site rather than opening ports per phone.

---

## Phase 2 — Trunk

**Voice & Chat → Trunks → Add Trunk.** Use the carrier's template if 3CX ships one rather than Generic SIP, since it presets their SIP quirks.

### General tab

| Setting | Value |
|---|---|
| Main Trunk Number | Main DDI in E.164, e.g. `+441632960002` |
| Authentication ID / password | From the carrier |
| Registrar/Server, Port | e.g. `sip39.voiceflex.com`, `5060` |
| Default route | A destination that **has registered members** |

### Options tab

This is the tab people skip, and it contains the setting that silently breaks everything.

| Setting | Value |
|---|---|
| **Number of sim calls per trunk** | The channel count the carrier has actually provisioned. Never leave at `0`. |
| **Allow inbound calls / Allow outbound calls** | Both ticked |
| **Default Outbound Caller ID** | The main DDI in E.164, e.g. `+441632960002`. See the warning below. |
| Codec priority | G.711 A-law (**PCMA**) first for the UK, G.711 mu-law (PCMU) second, G.729 last or disabled |
| Convert inbound caller ID to E164 | On, country set correctly. Inbound caller IDs then reach the CRM already in `+44…` form. |
| Allow carrier-side transfers (SIP REFER) | Off unless the carrier explicitly supports it |

> **An empty Default Outbound Caller ID makes carriers reject your calls.** With nothing set at trunk or extension level, 3CX presents the *extension number* as the calling party. The carrier sees an INVITE from `100`, which is not a number on your account and not valid CLI, and refuses it. UK carriers are strict here because presenting unverified CLI is a regulatory problem for them. The symptom is outbound failing on a trunk that registers perfectly.

> **`Number of sim calls per trunk` is 3CX's own ceiling, not the carrier's provisioning.** 3CX will happily permit ten concurrent calls to a trunk the carrier has given zero channels. Setting it correctly does not prove anything about the account.

> **A trunk with zero simultaneous calls registers perfectly and passes every diagnostic, then refuses every call in both directions.** Outbound reports "no phone lines available", inbound returns busy tone, and the SIP Trunk Checker still reports registration successful, because registering does not consume a channel.

### Verify before moving on

**SIP Trunk Checker → Trunk Analysis.** You want DNS resolving, the server address selected, transport chosen, and registration successful. Do not build rules on top of a trunk that has not registered.

---

## Phase 3 — Security and toll fraud

Do this **before** the outbound rules, because one of these settings will otherwise make correct rules appear broken.

### Allowed country codes

3CX maintains a global list of countries outbound calls may reach, and anything not listed is blocked regardless of your outbound rules. The default is typically the local country only.

**If you do not add the countries the client actually calls, international dialling fails with perfectly correct outbound rules in place.** This is the single most common cause of "my international rule doesn't work".

Add only the countries genuinely needed. A short list is a toll fraud control in itself.

### Other hardening

| Control | Why |
|---|---|
| Strong, unique extension passwords | Auto-generate them. A weak SIP password on one extension is the usual entry point. |
| IP blacklisting / anti-hacking enabled | Blocks repeated failed registration attempts |
| Disable unused extensions | An extension nobody uses is an extension nobody notices being abused |
| Restrict international by extension range | See phase 4 |
| Two-factor on admin accounts | Cheap and worth it |

Toll fraud usually surfaces as a five-figure bill for overnight calls to premium international destinations. The controls above cost minutes.

---

## Phase 4 — Outbound rules

**Voice & Chat → Outbound Rules.** 3CX evaluates these **top down and takes the first match**, so ordering is not optional. `00353…` also starts with `0`, so a `0` rule above a `00` rule swallows every international call.

| # | Prefix | Calls from ext. | Strip | Prepend | Handles |
|---|---|---|---|---|---|
| 1 | `00` | *(restricted range)* | 2 | `+` | International access code |
| 2 | `+` | *(restricted range)* | 0 | *(none)* | Already E.164, pass through |
| 3 | `1` | *(blank)* | 0 | *(none)* | UK service numbers |
| 4 | `0` | *(blank)* | 1 | `+44` | UK national |

All four route to the trunk. Leave **Outbound caller ID** blank so it falls back to the trunk's main number, and set per-extension caller ID only where someone needs to present a direct number.

Blank means "any" for Prefix, Calls from extension(s), Length and Department alike.

### Why each rule exists

**Rule 1** turns `00353871234567` into `+353871234567`. Without it, international either fails or gets mangled by the UK rule.

**Rule 2** matters more than it looks. Staff copy numbers out of Salesforce, and Salesforce stores E.164. Without this rule `+447911123456` falls through to rule 4 and becomes `+44770090099956`.

**Rule 3** covers `101`, `111`, `118xxx` and similar. These start with `1`, match no other rule, and would otherwise have no route at all. **NHS 111 is not optional in a care home.**

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

International is occasional here, which makes restricting it easy and worthwhile. Put an extension range in **Calls from extension(s)** on rules 1 and 2, e.g. `200-210`. Everyone else fails to match and cannot dial abroad.

Combined with the allowed country list in phase 3, that is two independent controls on the expensive failure mode.

---

## Phase 5 — Emergency and service numbers

**Voice & Chat → Emergency Numbers.** Configure `999` and `112`, routed out of the trunk, applying to **every** extension regardless of any calling restriction.

Register the correct **address details for each DDI** with the carrier. That is what determines which control room receives the call and what address they are given. It is the part that gets forgotten when a site moves or a new home is added.

> **Do not test by dialling 999.** Verify the configuration, then ask the carrier whether they provide an emergency test number.

Confirm `111` and `101` complete via rule 3. In a care home these get used in earnest, often at night by staff who will not be troubleshooting a dial plan.

---

## Phase 6 — Extensions and users

Create users before inbound routing, because groups and queues need members and several tests need a registered endpoint.

For each user:

| Setting | Notes |
|---|---|
| Extension number | Within the ranges decided in phase 0 |
| Name and email | Email drives the welcome message and self-provisioning |
| Outbound caller ID | Leave blank to inherit the trunk's, or set a direct DDI |
| Voicemail | Enable, set a PIN policy, decide on email delivery of messages |
| Forwarding rules | Where calls go when unavailable, busy, or out of hours |

Then provision endpoints: desk phones via the provisioning URL, or the Web Client and mobile apps via the welcome email.

> **Register at least one extension before running any trunk test.** The Outbound Call Test needs an endpoint to originate from and reports "No registration found" without one, which reads like a trunk fault and is not.

> **Keep extensions to six digits or fewer.** The Worker treats anything at or below `InternalMaxDigits` (default 6) as internal and keeps it out of Salesforce entirely. Three-digit extensions are well inside that.

---

## Phase 7 — Ring groups and queues

Decide which you need, because they behave differently under load.

**Ring group** rings several extensions at once or in sequence, and the call fails or falls through when nobody answers. Right for a small reception team.

**Queue** holds callers, plays music and position announcements, and reports on wait times and abandons. Right when calls regularly wait, and it gives the client the data to argue for more staff.

For a care home group, a reasonable shape is one queue per home for the main line, plus ring groups for internal functions such as maintenance or kitchen.

Set for each:

- Ring strategy (ring all, longest waiting, round robin)
- Ring timeout, and the destination when it expires
- Whether callers can leave voicemail rather than wait

> A group or queue with **no registered members returns busy** to inbound callers. On a new system this is indistinguishable from a trunk fault. Point the trunk's default route at a registered extension while you are still building.

---

## Phase 8 — Inbound routing

### DIDs

**Trunk → DID Numbers.** Add each DDI the carrier has routed to this trunk.

> **Enter only the last six to nine digits**, e.g. `2032188` rather than `+441632960002`. 3CX matches DIDs on trailing digits, so the short form matches whether the carrier presents E.164, national, or bare significant digits. A format mismatch is the most common cause of "inbound doesn't work" on an otherwise healthy trunk.

### Inbound rules

**Voice & Chat → Inbound Rules**, one per DDI:

| Field | Value |
|---|---|
| DID/DDI | The number added above |
| Office hours destination | Queue, ring group, or digital receptionist |
| Out of hours destination | For a care home usually the same, since they are staffed overnight |

Map every DDI deliberately. An unmapped DDI falls to the trunk's default route, which is fine as a safety net and wrong as a design.

If a call lands somewhere unexpected, take a SIP trace and read the `To` header on the `INVITE`. That tells you exactly what the carrier sent rather than guessing at the format.

---

## Phase 9 — Digital receptionist and barge-in

Cedar Care's stated problem with their current system: **callers press 1 the instant it answers and land in the wrong department.** They want the menu heard before input is accepted.

3CX's digital receptionist accepts DTMF from the moment the prompt starts, so the fix is structural rather than a checkbox:

**Route the DID to an Announcement first, then to the digital receptionist.** An announcement plays to completion and does not accept input, so a caller pressing 1 during it achieves nothing. Whatever they must hear (the greeting, any required notice) goes in the announcement, and only the menu options themselves go in the receptionist prompt.

If you need finer control, the Call Flow Designer gives you a `PlayFile` with no DTMF collection followed by an explicit input step, which is the same idea with more precision.

Practical prompt advice:

- Keep the menu to **four options or fewer**. More and callers guess.
- State the department **before** the digit: "for the nursing team, press 2" rather than "press 2 for the nursing team". People stop listening once they hear a number.
- Always provide a route to a human, and make it the timeout destination too.

> **Park the AI receptionist for now.** It is cutting callers off and answering silently, and the cause is unresolved. Get a conventional receptionist working and signed off, then experiment on a spare DDI. Demonstrating a broken AI feature makes clients doubt the parts that work.

---

## Phase 10 — Business hours and holidays

Set the system-wide office hours, then override per queue or per inbound rule where a department differs.

For a care home, most lines are **24/7**, so resist copying an office template that sends night calls to voicemail. Get the client to state, per number, what should happen at 3am. The answer is usually "ring the on-call phone", which is a forwarding rule rather than a schedule.

Add public holidays for any line that genuinely closes, typically head office and finance rather than the homes.

---

## Phase 11 — Voicemail, music on hold, prompts

| Item | Notes |
|---|---|
| Voicemail | Enable per extension, set a PIN policy, decide whether messages are emailed as attachments. Emailed voicemail from a care home may contain health information, so confirm that is acceptable before switching it on. |
| Music on hold | Upload something licensed. Default 3CX audio on a client-facing line looks unfinished, and commercial music without a licence is a real liability. |
| System prompts | Record professionally or use consistent TTS. Mixing a recorded greeting with a synthesised menu sounds broken. |
| Out of hours message | Should say what happens next, not just that the office is closed. |

---

## Phase 12 — Call recording and retention

Care home call recordings are very likely **special category health data** under UK GDPR. This is a compliance decision for the client, not a technical default, and it should be recorded in writing before go-live.

Configure:

| Setting | Consideration |
|---|---|
| Which extensions record | All, some, or none. Reception and clinical lines carry the most sensitive content. |
| Retention period | Set it deliberately and short. Indefinite retention is the default failure. |
| Storage location and quota | Recordings fill disks quietly and then calls stop recording silently. |
| Announcement to callers | "This call may be recorded" is normally expected, and often required. |

### On the client's transfer clause

They asked whether recording can stop during an internal transfer and resume when the new person connects.

**3CX records per extension leg, not per conversation.** A transferred call therefore already produces separate recordings for each leg rather than one continuous file, which approximates the requested behaviour without configuration. There is also manual pause and resume in the Web Client for the PCI use case, if a member of staff needs to take card details.

Worth confirming with them whether "stops recording" means a genuine compliance requirement or simply the expectation that the hold portion is not captured, because those lead to different answers.

---

## Phase 13 — Spam filter

Check the current **Spam Action**. If it is set to **End Call**, change it.

A misclassified number gets hung up on with no trace and no callback. In a care home that is a relative ringing about their mother being cut off dead, and nobody finds out it happened. Route suspected spam to voicemail or a low priority queue instead, so a false positive costs someone a callback rather than a complaint.

Review the blocked list periodically rather than treating it as set and forget.

---

## Phase 14 — The Salesforce integration

Only once calls work in both directions.

Full detail is in [README.md](README.md). The PBX side is: upload [cloudflare_salesforce_integration.xml](cloudflare_salesforce_integration.xml) under **Integrations → CRM**, enter the Worker URL and the Proxy API Key, and save.

> **Password fields usually blank on upload.** Re-paste the Proxy API Key and save again, or every request returns 401.

### How the PBX config affects the integration

| PBX behaviour | Effect |
|---|---|
| Outbound normalised to E.164 | Dialled numbers match what Salesforce stores, so outbound calls journal against the right record |
| Inbound caller ID in any format | Harmless. The Worker normalises via libphonenumber before any lookup |
| No dial-out prefix | No stray digits reaching the CRM lookup |
| Extensions ≤ 6 digits | Internal calls stay out of Salesforce automatically |
| Emergency and service numbers short | Never create CRM records |

The Worker is deliberately forgiving about inbound formats, so the PBX side only really has to get **outbound** right.

---

## Phase 15 — Backups and monitoring

| Task | Notes |
|---|---|
| Scheduled backups | Enable, set a retention count, and store off the PBX. A backup on the same disk is not a backup. |
| Test a restore | At least once, before go-live. Untested backups fail when it matters. |
| Event log notifications | Send to an address someone reads. Trunk deregistration and licence expiry both arrive here first. |
| Certificate renewal | Automatic when 3CX-hosted. Self-hosted, confirm renewal works before the first expiry rather than after. |
| Record the build | FQDN, trunk credentials location, DDI list, extension ranges. Store with the client's documentation, not only in your head. |

---

## Go-live checklist

In order, because each depends on the last:

1. Firewall checker passes (self-hosted only)
2. Trunk registers, Trunk Analysis all green
3. Trunk Options: non-zero sim calls, both directions allowed, **Default Outbound Caller ID set**, PCMA above PCMU
4. Allowed country codes include every country the client calls
5. At least one extension registered, Web Client green
6. Outbound to a UK mobile connects, correct caller ID presented
7. Outbound international connects, dialled **both** as `00…` and as `+…`
8. `111` completes
9. Emergency configuration verified, addresses registered with the carrier
10. Inbound to **each** DDI rings the intended destination
11. Digital receptionist plays fully before accepting a keypress
12. Out of hours routing behaves as the client expects, tested outside hours
13. Voicemail records and delivers
14. Call recording on and retention set, or deliberately off and documented
15. Spam action is not End Call
16. Backup taken and a restore tested
17. CRM: with `npm run tail` running, an unknown caller creates a record at ring time and the transcription lands afterwards
18. CRM: the same number called twice produces **one** record and **one** open reminder

---

## Appendix — failures that look like faults but are settings

| Symptom | Cause |
|---|---|
| Outbound: "no phone lines available" | Trunk simultaneous calls set to `0`, or no outbound rule matches the dialled number |
| Inbound: caller hears busy | Trunk simultaneous calls set to `0`, or the destination group has no registered members |
| Outbound Call Test: "No registration found" | No **extension** registered. The test needs an endpoint to originate from. |
| Registration succeeds, all calls fail | Carrier has provisioned zero channels, or the account is not enabled for calls |
| Outbound fails, trunk registers fine, channels look right | Default Outbound Caller ID empty, so 3CX presents the extension number and the carrier rejects the CLI |
| Odd audio artefacts on a UK trunk | Codec priority has PCMU (mu-law) above PCMA (A-law) |
| International fails, rules look correct | Country not in the allowed country codes list, or international barred on the carrier account |
| International dialled as `+…` fails but `00…` works | Missing the `+` pass-through rule, so E.164 numbers fall into the UK rule |
| Inbound rings the wrong place or nowhere | DID entered in a different format from the one the carrier presents. Use the last 6-9 digits. |
| Calls connect with no audio | RTP range closed, or SIP ALG enabled on the router |
| Calls drop at ~30 seconds | SIP ALG, or NAT keepalive not traversing |
| CRM lookup returns a truncated number | Template `<Number MaxLength="">` was set to `[MaxLength]`. It must be empty. |
| Every CRM request returns 401 | Proxy API Key blanked on template upload. Re-paste it. |
