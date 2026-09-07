/**
 * Offline test harness for the 3CX → Salesforce Cloudflare Worker.
 * Mocks the Salesforce REST API and drives the worker's fetch handler
 * through every lookup / journaling / dedup scenario of the ring-time
 * contact-creation design.
 */
const worker = (await import(new URL("../src/index.js", import.meta.url))).default;

// ── Mock plumbing ───────────────────────────────────────────────────────
let calls = [];   // every outbound fetch the worker makes
let routes = [];  // active mock routes

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const record = {
    url: String(url),
    method: (init.method || "GET").toUpperCase(),
    body: init.body ? String(init.body) : null
  };
  calls.push(record);
  for (const route of routes) {
    if (route.match(record)) {
      route.hits = (route.hits || 0) + 1;
      const result = typeof route.reply === "function" ? route.reply(record, route.hits) : route.reply;
      const status = result.status || 200;
      if (status === 204) return new Response(null, { status });
      return new Response(JSON.stringify(result.json !== undefined ? result.json : result), {
        status,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
  throw new Error(`No mock route for ${record.method} ${record.url}`);
};

const SF = "https://sf.example.com";
const tokenRoute = {
  match: r => r.url.includes("/services/oauth2/token"),
  reply: { access_token: "tok", instance_url: SF }
};
const patch204 = { match: r => r.method === "PATCH", reply: { status: 204 } };
const delete204 = { match: r => r.method === "DELETE", reply: { status: 204 } };

// Route matchers for the worker's internal queries (URLSearchParams encodes
// spaces as +):
// The identity clause is parenthesised and may lead with the External ID
// field, so match on the WHERE and exclude the by-id lookup rather than
// pinning to whichever column happens to come first.
const byPhone = r => r.method === "GET" && r.url.includes("FROM+Contact+WHERE") && !r.url.includes("WHERE+Id");
const byId = r => r.method === "GET" && r.url.includes("FROM+Contact+WHERE+Id");
// The reminder lookup and the transferred-leg merge lookup both read Task,
// so these matchers must stay mutually exclusive.
const byTask = r => r.method === "GET" && r.url.includes("FROM+Task") && r.url.includes("Action+Required");
const recentCallQuery = r => r.method === "GET" && r.url.includes("TaskSubtype+%3D+%27Call%27");
const noRecentCall = { match: recentCallQuery, reply: { records: [] } };
const sfSearch = r => r.method === "GET" && r.url.startsWith(`${SF}/services/data/v55.0/search/`);
const taskPost = r => r.method === "POST" && /\/sobjects\/task$/i.test(r.url) && r.url.startsWith(SF);
const contactPost = r => r.method === "POST" && r.url.endsWith("/sobjects/Contact");

const env = {
  PROXY_API_KEY: "secret",
  SALESFORCE_CLIENT_ID: "cid",
  SALESFORCE_CLIENT_SECRET: "cs",
  SALESFORCE_LOGIN_URL: "https://login.example.com"
};

function makeCtx() {
  const tasks = [];
  return { waitUntil: p => tasks.push(p), tasks };
}

function lookupRequest(q, headers = {}) {
  return new Request(`https://worker.example/services/data/v55.0/search/?q=${encodeURIComponent(q)}`, {
    method: "GET",
    headers: { "X-Proxy-API-Key": "secret", ...headers }
  });
}

function taskRequest(body, headers = {}) {
  return new Request("https://worker.example/services/data/v55.0/sobjects/task", {
    method: "POST",
    headers: { "X-Proxy-API-Key": "secret", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

const inboundDescription =
  "17/07/2026 15:00: Answered incoming call from 447911123456 Unregistered Contact +447911123456 to 102 (00:00:35)\n\n" +
  "Transcription: Hello my name is Sarah Jones, I need help with my order\n\n" +
  "Summary: Caller asked about an order.\n\n" +
  "Sentiment: Neutral\n\n" +
  "Recording: https://example.com/rec.wav";

function callTaskBody(whoId, description = inboundDescription) {
  return {
    Subject: "3CX PhoneSystem Call",
    Status: "Completed",
    Priority: "Normal",
    TaskSubtype: "Call",
    WhoId: whoId,
    OwnerId: "005xx0000012345AAA",
    Description: description
  };
}

const ringTimeContact = (id, phone) => ({
  Id: id, FirstName: "Unregistered Contact", LastName: phone, Phone: phone,
  Description: `Auto-created from the 3CX phone system when this number called.`
});

// Helpers to pull specific outbound calls out of the log
const contactPosts = () => calls.filter(contactPost);
const forwardedCallTask = () => calls.filter(taskPost).map(c => JSON.parse(c.body)).find(b => b.Subject === "3CX PhoneSystem Call");
const alertTaskPost = () => calls.filter(taskPost).map(c => JSON.parse(c.body)).find(b => (b.Subject || "").startsWith("Action Required:"));
const contactPatches = () => calls.filter(c => c.method === "PATCH" && c.url.includes("/sobjects/Contact/")).map(c => ({ url: c.url, body: JSON.parse(c.body) }));
const taskPatches = () => calls.filter(c => c.method === "PATCH" && c.url.includes("/sobjects/Task/")).map(c => ({ url: c.url, body: JSON.parse(c.body) }));

// ── Assertion plumbing ──────────────────────────────────────────────────
let passed = 0, failed = 0, currentTest = "";
function check(condition, label) {
  if (condition) { passed++; }
  else { failed++; console.error(`  FAIL [${currentTest}] ${label}`); }
}
async function runTest(name, fn) {
  currentTest = name;
  calls = [];
  try {
    await fn();
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL [${name}] threw: ${e.stack}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log("Running worker tests...\n");

// T1: missing API key → 401
await runTest("rejects requests without API key", async () => {
  routes = [tokenRoute];
  const res = await worker.fetch(
    new Request("https://worker.example/services/data/v55.0/search/?q=x"), env, makeCtx());
  check(res.status === 401, "returns 401");
});

// T2: unknown number lookup → REAL contact created at ring time and returned
await runTest("unknown number lookup creates real contact at ring time", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } }, // proxied lookup + internal SOSL fallback
    { match: byPhone, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "003RING00000001AAA" }] } },
    { match: contactPost, reply: { json: { id: "003RING00000001AAA" }, status: 201 } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    env, makeCtx());
  const data = await res.json();
  check(res.status === 200, "responds 200");
  check(data.searchRecords?.[0]?.Id === "003RING00000001AAA", "real Salesforce id returned to 3CX");
  check(data.searchRecords?.[0]?.FirstName === "Unregistered Contact", "default first name");
  check(data.searchRecords?.[0]?.Phone === "+447911123456", "phone normalized to E.164");
  const created = JSON.parse(contactPosts()[0].body);
  check(created.Phone === "+447911123456", "contact stored with E.164 phone");
  check(created.LastName === "+447911123456", "last name carries the number only (parser-safe)");
  const search = calls.find(sfSearch);
  check(search && search.url.includes("447911123456") && !search.url.includes("%2B"), "SOSL queried with digits-only term");
});

// T2b: number already has a ring-time contact → reused, nothing created
await runTest("repeat lookup reuses existing contact (no duplicate)", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [ringTimeContact("003EXIST0000001AAA", "+447700900123")] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {447700900123} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    env, makeCtx());
  const data = await res.json();
  check(data.searchRecords?.[0]?.Id === "003EXIST0000001AAA", "existing contact returned");
  check(contactPosts().length === 0, "no duplicate contact created");
});

// T2c: a "+44..." lookup must be SOSL-safe (no reserved + in FIND)
await runTest("plus-prefixed lookup rewritten to SOSL-safe digits", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [ringTimeContact("003EXIST0000002AAA", "+447700900123")] } }
  ];
  await worker.fetch(
    lookupRequest("FIND {+447700900123} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    env, makeCtx());
  const search = calls.find(sfSearch);
  check(search && search.url.includes("%7B447700900123%7D"), "leading + stripped from SOSL term");
  check(search && !search.url.includes("%2B"), "no reserved + reaches Salesforce search");
});

// T3: empty email lookup → stays empty (no junk contacts)
await runTest("empty email lookup stays empty (no junk contacts)", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {someone@example.com} IN EMAIL FIELDS RETURNING Contact(Id,FirstName)"),
    env, makeCtx());
  const data = await res.json();
  check(Array.isArray(data.searchRecords) && data.searchRecords.length === 0, "searchRecords stays empty");
  check(contactPosts().length === 0, "nothing created");
});

// T4: policy Disabled → no auto-create
await runTest("auto-create policy Disabled leaves lookup empty", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id)", { "X-Auto-Create-Policy": "Disabled" }),
    env, makeCtx());
  const data = await res.json();
  check(data.searchRecords.length === 0, "no contact fabricated");
  check(contactPosts().length === 0, "nothing created");
});

// T4b: an EXISTING record must still be found when auto-create is disabled.
// Salesforce's own SOSL misses contacts stored in national format, so the
// worker's variant match has to run regardless of the create policy.
await runTest("auto-create Disabled still finds a nationally-formatted contact", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [{ Id: "003NAT0000001AAAA", FirstName: "Jean", LastName: "Dupont", Phone: "07911 123456" }] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)",
      { "X-Auto-Create-Policy": "Disabled" }),
    env, makeCtx());
  const data = await res.json();
  check(data.searchRecords?.[0]?.Id === "003NAT0000001AAAA", "existing contact found despite Disabled policy");
  check(contactPosts().length === 0, "still creates nothing");
});

// T5: journaling against the ring-time contact — name upgraded from
// transcription, description appended, reminder created
await runTest("first journaling enriches contact and creates reminder", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000001AA" }, status: 201 } },
    { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
    noRecentCall,
    { match: byTask, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "00TALERT000000001AA" }] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  const res = await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")), env, ctx);
  await Promise.all(ctx.tasks);

  check(res.status === 201, "call task journaled");
  check(forwardedCallTask()?.WhoId === "003RING00000001AAA", "task forwarded with real contact id untouched");
  check(!contactPatches().some(p => p.body.FirstName), "name never auto-written from a transcription");
  const stampPatch = contactPatches().find(p => p.body.LastName);
  check(/^\+447911123456 \(Inbound \d{2}:\d{2}, Ext 102\)$/.test(stampPatch?.body.LastName || ""),
    `direction/time/ext stamped onto the name (got "${stampPatch?.body.LastName}")`);
  const descPatch = contactPatches().find(p => p.body.Description);
  check(descPatch?.body.Description.includes("my name is Sarah Jones"), "transcription appended to contact");
  check(descPatch?.body.Description.includes('Possible caller name mentioned: "Sarah Jones"'), "name recorded as an unverified hint");
  check(descPatch?.body.Description.includes("unverified"), "hint is explicitly marked unverified");
  check(descPatch?.body.Description.includes("Auto-created from the 3CX"), "ring-time history preserved");
  const alert = alertTaskPost();
  check(alert?.WhoId === "003RING00000001AAA", "reminder linked to contact");
  check(!alert?.Subject.includes("Sarah Jones"), "reminder subject makes no name claim");
  check(alert?.Description.includes('Possible caller name mentioned: "Sarah Jones"'), "reminder carries the hint in its body");
  check(alert?.OwnerId === "005xx0000012345AAA", "reminder assigned to agent");
});

// T6: repeat journaling with open reminder → both records updated, no dups
await runTest("repeat journaling updates contact + reminder (no duplicates)", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000002AA" }, status: 201 } },
    { match: byId, reply: { records: [{
      Id: "003RING00000001AAA", FirstName: "Unregistered Contact", LastName: "+447911123456",
      Phone: "+447911123456", Description: "First call details here."
    }] } },
    noRecentCall,
    { match: byTask, reply: { records: [{ Id: "00TALERT000000001AA", Description: "Original reminder text" }] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")), env, ctx);
  await Promise.all(ctx.tasks);

  check(contactPosts().length === 0, "no second contact created");
  const descPatch = contactPatches().find(p => p.body.Description);
  check(descPatch?.body.Description.includes("First call details here."), "existing history preserved");
  check(descPatch?.body.Description.includes("my name is Sarah Jones"), "second transcription appended");
  check(!alertTaskPost(), "no duplicate reminder created");
  const reminderPatch = taskPatches().find(p => p.body.Description);
  check(reminderPatch?.body.Description.includes("Original reminder text"), "reminder history preserved");
  check(reminderPatch?.body.Description.includes("Repeat call: +447911123456"), "reminder notes the repeat call");
  check(!reminderPatch?.body.Subject, "reminder subject not rewritten with a guessed name");
  check(reminderPatch?.body.Description.includes('Possible caller name mentioned: "Sarah Jones"'), "hint appended to the reminder body");
});

// T7: contact was filled in by a human → reminders auto-completed, no writes
await runTest("registered contact: leftover reminders auto-completed", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000003AA" }, status: 201 } },
    { match: byId, reply: { records: [{ Id: "003REG000000001AAA", FirstName: "John", LastName: "Smith", Phone: "+447911123456", Description: "" }] } },
    noRecentCall,
    { match: byTask, reply: { records: [{ Id: "00TOLD00000000001AA", Description: "old reminder" }] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003REG000000001AAA")), env, ctx);
  await Promise.all(ctx.tasks);

  check(forwardedCallTask()?.WhoId === "003REG000000001AAA", "task journaled to registered contact");
  check(contactPatches().length === 0, "registered contact left untouched");
  const closed = taskPatches()[0];
  check(closed?.body.Status === "Completed", "leftover reminder auto-completed");
  check(!alertTaskPost(), "no reminder created");
});

// T8: two simultaneous ring-time lookups race → loser deleted, winner returned
await runTest("concurrent ring-time create race converges on oldest contact", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: (r, hits) => hits === 1
      ? { records: [] }
      : { records: [ringTimeContact("003AAA000000001AAA", "+447911123456"), { Id: "003BBB000000001AAA" }] } },
    { match: contactPost, reply: { json: { id: "003BBB000000001AAA" }, status: 201 } },
    delete204
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    env, makeCtx());
  const data = await res.json();
  const deletion = calls.find(c => c.method === "DELETE");
  check(deletion?.url.endsWith("/sobjects/Contact/003BBB000000001AAA"), "losing duplicate contact deleted");
  check(data.searchRecords?.[0]?.Id === "003AAA000000001AAA", "winning contact returned to 3CX");
});

// T9a: Salesforce queries down at ring time → lookup stays empty, no blind create
await runTest("ring-time lookup failure returns empty instead of risking duplicates", async () => {
  routes = [
    tokenRoute,
    { match: byPhone, reply: { json: [{ message: "boom" }], status: 500 } },
    { match: sfSearch, reply: (r, hits) => hits === 1 ? { searchRecords: [] } : { json: [{ message: "boom" }], status: 500 } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id,FirstName)"),
    env, makeCtx());
  const data = await res.json();
  check(res.status === 200 && data.searchRecords.length === 0, "empty result returned");
  check(contactPosts().length === 0, "no blind contact creation");
});

// T9b: Salesforce queries down at journaling → task still forwarded fine
await runTest("journaling maintenance failure never blocks the call log", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000004AA" }, status: 201 } },
    { match: byId, reply: { json: [{ message: "boom" }], status: 500 } }
  ];
  const ctx = makeCtx();
  const res = await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")), env, ctx);
  await Promise.all(ctx.tasks);
  check(res.status === 201, "call log still journaled");
  check(contactPatches().length === 0 && !alertTaskPost(), "no partial maintenance writes");
});

// T10: stale token → 401 triggers one refresh + retry
await runTest("stale Salesforce token is refreshed and the call retried", async () => {
  let queryAttempts = 0;
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000005AA" }, status: 201 } },
    { match: byId, reply: () => {
      queryAttempts++;
      return queryAttempts === 1
        ? { json: [{ errorCode: "INVALID_SESSION_ID" }], status: 401 }
        : { records: [{ Id: "003REG000000002AAA", FirstName: "Jane", LastName: "Doe", Phone: "+447911123456", Description: "" }] };
    } },
    noRecentCall,
    { match: byTask, reply: { records: [] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003REG000000002AAA")), env, ctx);
  await Promise.all(ctx.tasks);
  check(queryAttempts === 2, "query retried after 401");
});

// T11: missed call journaling → reminder references the number, no fake name
await runTest("missed call journaling handled correctly", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000006AA" }, status: 201 } },
    { match: byId, reply: { records: [ringTimeContact("003MISS00000001AAA", "+447700900123")] } },
    noRecentCall,
    { match: byTask, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "00TAL200000000001AA" }] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003MISS00000001AAA",
    "17/07/2026 02:11: Missed call from 07700900123 Unregistered Contact +447700900123 to 101")), env, ctx);
  await Promise.all(ctx.tasks);

  check(!contactPatches().some(p => p.body.FirstName), "no fake name invented");
  const stampPatch = contactPatches().find(p => p.body.LastName);
  check(/^\+447700900123 \(Inbound Missed \d{2}:\d{2}, Ext 101\)$/.test(stampPatch?.body.LastName || ""),
    `first call stamps direction/time/ext onto the name (got "${stampPatch?.body.LastName}")`);
  const descPatch = contactPatches().find(p => p.body.Description);
  check(descPatch?.body.Description.includes("Inbound Missed"), "direction captured in history");
  const alert = alertTaskPost();
  check(alert?.Subject.includes("+447700900123"), "reminder references the number");
});

// T12: a 3CX lookup cached before ring-time creation could still send the
// old placeholder id. It is not a valid Salesforce id, so the call log must
// survive unlinked rather than the insert failing outright.
await runTest("legacy placeholder id is stripped, call log survives", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000007AA" }, status: 201 } }
  ];
  const ctx = makeCtx();
  const res = await worker.fetch(taskRequest(callTaskBody("UNSAVED_CONTACT_PLACEHOLDER")), env, ctx);
  await Promise.all(ctx.tasks);
  check(res.status === 201, "task journaled");
  check(forwardedCallTask()?.WhoId === undefined, "invalid placeholder id removed before insert");
  check(forwardedCallTask()?.Description.includes("my name is Sarah Jones"), "transcript still reaches Salesforce");
});

// ── Call filtering ──────────────────────────────────────────────────────

// F1: internal extension-to-extension call creates nothing at ring time
await runTest("filtering: internal extension lookup creates nothing", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {102} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    env, makeCtx());
  const data = await res.json();
  check(data.searchRecords.length === 0, "no contact returned to 3CX");
  check(contactPosts().length === 0, "nothing created in Salesforce");
});

// F2: excluded prefix (sister site DDI) filtered at ring time
await runTest("filtering: excluded prefix lookup creates nothing", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {01632960004} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)",
      { "X-Excluded-Prefixes": "01179,01615" }),
    env, makeCtx());
  const data = await res.json();
  check(data.searchRecords.length === 0, "no contact returned");
  check(contactPosts().length === 0, "nothing created");
});

// F3: non-excluded number still works with filters configured
await runTest("filtering: unrelated number unaffected by exclusions", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "003OK0000000001AAA" }] } },
    { match: contactPost, reply: { json: { id: "003OK0000000001AAA" }, status: 201 } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)",
      { "X-Excluded-Prefixes": "01179,01615", "X-Internal-Max-Digits": "6" }),
    env, makeCtx());
  const data = await res.json();
  check(data.searchRecords?.[0]?.Id === "003OK0000000001AAA", "external number still auto-created");
});

// F4: journaling backstop — excluded number already saved in Salesforce
await runTest("filtering: excluded number's call log dropped at journaling", async () => {
  routes = [tokenRoute];
  const ctx = makeCtx();
  const res = await worker.fetch(taskRequest(
    callTaskBody("003SISTER00001AAA",
      "17/07/2026 15:00: Answered incoming call from 01632960004  to 102 (00:01:20)\n\nTranscription: internal handover about a resident\n\nSummary: Internal\n\nSentiment: Neutral"),
    { "X-Excluded-Prefixes": "01179" }), env, ctx);
  await Promise.all(ctx.tasks);
  const body = await res.json();
  check(res.status === 201 && body.filtered === "number", "task dropped as filtered");
  check(!calls.some(taskPost), "nothing written to Salesforce");
});

// F5: direction switch — outbound journaling disabled
await runTest("filtering: outbound journaling can be switched off", async () => {
  routes = [tokenRoute];
  const ctx = makeCtx();
  const res = await worker.fetch(taskRequest(
    callTaskBody("003ANY0000000001AA",
      "17/07/2026 15:00: Answered outgoing call from 102 to 447911123456  (00:00:30)\n\nTranscription: hello there"),
    { "X-Journal-Outbound": "False" }), env, ctx);
  await Promise.all(ctx.tasks);
  const body = await res.json();
  check(res.status === 201 && body.filtered === "direction", "outbound task dropped");
  check(!calls.some(taskPost), "nothing written to Salesforce");
});

// F6: inbound still journals when only outbound is disabled
await runTest("filtering: inbound unaffected when outbound disabled", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000008AA" }, status: 201 } },
    { match: byId, reply: { records: [{ Id: "003REG000000009AAA", FirstName: "John", LastName: "Smith", Phone: "+447911123456", Description: "" }] } },
    noRecentCall,
    { match: byTask, reply: { records: [] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003REG000000009AAA"), { "X-Journal-Outbound": "False" }), env, ctx);
  await Promise.all(ctx.tasks);
  check(!!forwardedCallTask(), "inbound call still journaled");
});

// F7: transcript policy "Metadata only" strips the words but keeps the call
await runTest("filtering: Metadata only strips transcript, keeps call log", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000009AA" }, status: 201 } },
    { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
    noRecentCall,
    { match: byTask, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "00TAL400000000001AA" }] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA"), { "X-Transcript-Policy": "Metadata only" }), env, ctx);
  await Promise.all(ctx.tasks);

  const logged = forwardedCallTask();
  check(!!logged, "call still journaled");
  check(!logged.Description.includes("Sarah Jones"), "transcript text removed");
  check(logged.Description.includes("[Transcription withheld by CRM policy]"), "redaction marker present");
  check(logged.Description.includes("Answered incoming call"), "call header line preserved");
  check(logged.Description.includes("Summary: Caller asked about an order."), "AI summary preserved");
  const descPatch = contactPatches().find(p => p.body.Description);
  check(descPatch && !descPatch.body.Description.includes("Sarah Jones"), "transcript not leaked onto contact");
  check(!contactPatches().some(p => p.body.FirstName), "withheld transcript not mined for a name");
});

// F8: "External inbound only" keeps inbound transcripts, drops outbound ones
await runTest("filtering: External inbound only keeps inbound transcript", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000010AA" }, status: 201 } },
    { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
    noRecentCall,
    { match: byTask, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "00TAL500000000001AA" }] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA"), { "X-Transcript-Policy": "External inbound only" }), env, ctx);
  await Promise.all(ctx.tasks);
  check(forwardedCallTask()?.Description.includes("my name is Sarah Jones"), "inbound transcript retained");
});

// F9: defaults are backwards compatible (no filtering headers at all)
await runTest("filtering: defaults leave existing behaviour unchanged", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000011AA" }, status: 201 } },
    { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
    noRecentCall,
    { match: byTask, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "00TAL600000000001AA" }] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")), env, ctx);
  await Promise.all(ctx.tasks);
  check(forwardedCallTask()?.Description.includes("my name is Sarah Jones"), "transcript kept by default");
  check(!!alertTaskPost(), "reminder still created by default");
});

// ── Transferred call consolidation ──────────────────────────────────────


// C1: a transferred leg folds into the existing call log
await runTest("transfer: second leg merges into the first call log", async () => {
  routes = [
    tokenRoute,
    { match: recentCallQuery, reply: { records: [{
      Id: "00TLEG0000000001AA", Subject: "3CX PhoneSystem Call",
      Description: "First leg, answered on reception", CallDurationInSeconds: 45 }] } },
    { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
    noRecentCall,
    { match: byTask, reply: { records: [] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  const body = callTaskBody("003RING00000001AAA");
  body.CallDurationInSeconds = 300;
  const res = await worker.fetch(taskRequest(body), env, ctx);
  await Promise.all(ctx.tasks);

  const result = await res.json();
  check(result.merged === true && result.id === "00TLEG0000000001AA", "reports the merged task id");
  check(!forwardedCallTask(), "no second call task created");

  const merged = calls.filter(c => c.method === "PATCH" && c.url.includes("/sobjects/Task/00TLEG0000000001AA"))
    .map(c => JSON.parse(c.body))[0];
  check(merged?.Description.includes("First leg, answered on reception"), "original leg preserved");
  check(merged?.Description.includes("Call continued on extension 102"), "continuation header added");
  check(merged?.Description.includes("my name is Sarah Jones"), "second leg transcript appended");
  check(merged?.CallDurationInSeconds === 345, "durations summed across both legs");
});

// C2: a call outside the window is logged separately, not merged
await runTest("transfer: unrelated later call is not merged", async () => {
  routes = [
    tokenRoute,
    { match: recentCallQuery, reply: { records: [] } },
    { match: taskPost, reply: { json: { id: "00TNEW0000000001AA" }, status: 201 } },
    { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
    noRecentCall,
    { match: byTask, reply: { records: [] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")), env, ctx);
  await Promise.all(ctx.tasks);
  check(!!forwardedCallTask(), "a new call task was created");
});

// C3: consolidation can be turned off entirely
await runTest("transfer: consolidation disabled logs every leg", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TSEP0000000001AA" }, status: 201 } },
    { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
    noRecentCall,
    { match: byTask, reply: { records: [] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")),
    { ...env, CALL_MERGE_WINDOW_MINUTES: "0" }, ctx);
  await Promise.all(ctx.tasks);
  check(!calls.some(recentCallQuery), "no merge lookup performed");
  check(!!forwardedCallTask(), "leg logged as its own task");
});

// C4: 3CX journals a leg when it ends, so a long second leg must not push
// the first leg out of the merge window
await runTest("transfer: long second leg still merges", async () => {
  routes = [
    tokenRoute,
    { match: recentCallQuery, reply: { records: [{
      Id: "00TLEG0000000002AA", Subject: "3CX PhoneSystem Call",
      Description: "Reception took the call", CallDurationInSeconds: 30 }] } },
    { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
    noRecentCall,
    { match: byTask, reply: { records: [] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  const body = callTaskBody("003RING00000001AAA");
  body.CallDurationInSeconds = 900; // 15 minutes on the second extension
  const res = await worker.fetch(taskRequest(body), env, ctx);
  await Promise.all(ctx.tasks);

  check((await res.json()).merged === true, "long leg merged rather than logged separately");

  const query = decodeURIComponent(calls.find(recentCallQuery).url).replace(/\+/g, " ");
  const since = new Date(query.match(/CreatedDate >= (\S+)/)[1]);
  const windowMinutes = (Date.now() - since.getTime()) / 60_000;
  check(windowMinutes > 15, `window covers the second leg's duration (${windowMinutes.toFixed(1)} min)`);
});

// ── International number handling ───────────────────────────────────────

// I1: every inbound number format must canonicalise to the same E.164 value
await runTest("international numbers normalise to E.164", async () => {
  const cases = [
    // [what 3CX sends, expected stored value]
    ["07911123456", "+447911123456"],       // UK national
    ["447911123456", "+447911123456"],      // UK, plus stripped by Prefix="Off"
    ["+447911123456", "+447911123456"],     // already E.164
    ["33123456789", "+33123456789"],        // French E.164, plus stripped
    ["+33123456789", "+33123456789"],       // French, plus intact
    ["0033123456789", "+33123456789"],      // dialled with international access code
    ["12125550123", "+12125550123"],        // US
    ["61412345678", "+61412345678"],        // Australia
    ["919876543210", "+919876543210"],      // India, plus stripped
    ["+91 98765 43210", "+919876543210"],   // India, formatted with spaces
    ["0091 98765 43210", "+919876543210"]   // India, dialled 00 + spaces
  ];

  for (const [sent, expected] of cases) {
    calls = [];
    routes = [
      tokenRoute,
      { match: sfSearch, reply: { searchRecords: [] } },
      { match: byPhone, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "003INTL0000001AAA" }] } },
      { match: contactPost, reply: { json: { id: "003INTL0000001AAA" }, status: 201 } }
    ];
    const res = await worker.fetch(
      lookupRequest(`FIND {${sent}} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)`),
      env, makeCtx());
    const data = await res.json();
    check(data.searchRecords?.[0]?.Phone === expected,
      `${sent} → ${expected} (got "${data.searchRecords?.[0]?.Phone}")`);
    const created = contactPosts()[0] && JSON.parse(contactPosts()[0].body);
    check(created?.Phone === expected, `${sent} stored as ${expected}`);
  }
});

// I1b: matching must find records however Salesforce happens to store them
await runTest("lookup matches every stored phone format", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [{ Id: "003FMT0000001AAAA", Phone: "07700 900123" }] } }
  ];
  await worker.fetch(
    lookupRequest("FIND {07700900123} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    env, makeCtx());

  // URLSearchParams encodes spaces as "+", so restore those before decoding
  // (a literal "+" in a number is encoded as %2B and survives untouched).
  const soql = decodeURIComponent(calls.find(byPhone).url.replace(/\+/g, "%20"));
  for (const variant of ["+447700900123", "447700900123", "07700900123", "07700 900123", "+44 7700 900123"]) {
    check(soql.includes(variant), `SOQL matches the "${variant}" format`);
  }
  for (const field of ["Phone", "MobilePhone", "HomePhone", "OtherPhone"]) {
    check(soql.includes(`${field} IN (`), `${field} searched`);
  }
});

// I2: SOSL terms must never carry a "+" regardless of origin country
await runTest("international lookups stay SOSL-safe", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [{ Id: "003INTL0000002AAA", Phone: "+33123456789" }] } }
  ];
  await worker.fetch(
    lookupRequest("FIND {+33123456789} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    env, makeCtx());
  const search = calls.find(sfSearch);
  check(search && !search.url.includes("%2B"), "no reserved + in the SOSL term");
  check(search && search.url.includes("33123456789"), "digits preserved");
});

// I3: a different home country can be configured (ISO 3166 code)
await runTest("home country is configurable", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "003IE00000001AAAA" }] } },
    { match: contactPost, reply: { json: { id: "003IE00000001AAAA" }, status: 201 } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {0871234567} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    { ...env, HOME_COUNTRY: "IE" }, makeCtx());
  const data = await res.json();
  check(data.searchRecords?.[0]?.Phone === "+353871234567", `Irish national → +353 (got "${data.searchRecords?.[0]?.Phone}")`);
});

// I4: extensions and short codes must never become phone numbers
await runTest("short numbers are not turned into international numbers", async () => {
  for (const ext of ["101", "8000", "999"]) {
    calls = [];
    routes = [tokenRoute, { match: sfSearch, reply: { searchRecords: [] } }];
    const res = await worker.fetch(
      lookupRequest(`FIND {${ext}} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)`),
      env, makeCtx());
    const data = await res.json();
    check(data.searchRecords.length === 0, `${ext} treated as internal, no record created`);
    check(!calls.some(contactPost), `${ext} never created a contact`);
  }
});

// ── Person Account / Lead org models ────────────────────────────────────

const paEnv = { ...env, SALESFORCE_ORG_MODEL: "personaccount" };
const leadEnv = { ...env, SALESFORCE_ORG_MODEL: "lead" };

const byAccountPhone = r => r.method === "GET" && r.url.includes("FROM+Account+WHERE+IsPersonAccount");
const byAccountContactId = r => r.method === "GET" && r.url.includes("FROM+Account+WHERE+PersonContactId");
const byLeadPhone = r => r.method === "GET" && r.url.includes("FROM+Lead+WHERE+IsConverted");
const byLeadId = r => r.method === "GET" && r.url.includes("FROM+Lead+WHERE+Id");
const recordTypeQuery = r => r.method === "GET" && r.url.includes("FROM+RecordType");
const accountPost = r => r.method === "POST" && r.url.endsWith("/sobjects/Account");
const leadPost = r => r.method === "POST" && r.url.endsWith("/sobjects/Lead");

const personAccount = (id, contactId, phone, over = {}) => ({
  Id: id, PersonContactId: contactId, FirstName: "Unregistered Contact", LastName: phone,
  Phone: phone, Description: "ring-time", ...over
});
const openLead = (id, phone, over = {}) => ({
  Id: id, FirstName: "Unregistered Contact", LastName: phone, Phone: phone,
  Description: "ring-time", ...over
});

// P0: Person Accounts not enabled → no record type → nothing created.
// Runs before P1 because the worker caches the record type id for the
// lifetime of the isolate (correct in production — one org per worker).
await runTest("personaccount: missing record type creates nothing", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byAccountPhone, reply: { records: [] } },
    { match: recordTypeQuery, reply: { records: [] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    paEnv, makeCtx());
  const data = await res.json();
  check(data.searchRecords.length === 0, "lookup stays empty");
  check(!calls.some(accountPost), "no Account created without a record type");
});

// P1: personaccount mode creates an Account, returns PersonContactId to 3CX
await runTest("personaccount: ring-time creates Person Account with record type", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: recordTypeQuery, reply: { records: [{ Id: "012RT00000000001AAA" }] } },
    { match: byAccountPhone, reply: (r, hits) => hits === 1
      ? { records: [] }
      : { records: [personAccount("001PA0000000001AAA", "003PC0000000001AAA", "+447911123456")] } },
    { match: accountPost, reply: { json: { id: "001PA0000000001AAA" }, status: 201 } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    paEnv, makeCtx());
  const data = await res.json();

  const created = JSON.parse(calls.find(accountPost).body);
  check(created.RecordTypeId === "012RT00000000001AAA", "person-account record type discovered and applied");
  check(created.Phone === "+447911123456", "E.164 phone stored on the Account");
  check(calls.filter(contactPost).length === 0, "no plain Contact created");
  check(data.searchRecords?.[0]?.Id === "003PC0000000001AAA", "PersonContactId returned to 3CX, not the Account id");
  check(data.searchRecords?.[0]?.attributes?.type === "Contact", "entity type Contact so 3CX sets WhoId");
});

// P2: existing Person Account matched across the person phone fields
await runTest("personaccount: existing account matched on PersonMobilePhone", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byAccountPhone, reply: { records: [
      personAccount("001PA0000000002AAA", "003PC0000000002AAA", null, { PersonMobilePhone: "+447911123456", Phone: null })] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    paEnv, makeCtx());
  const data = await res.json();
  check(data.searchRecords?.[0]?.Id === "003PC0000000002AAA", "matched account returned");
  check(!calls.some(accountPost), "no duplicate account created");
  const q = decodeURIComponent(calls.find(byAccountPhone).url);
  check(q.includes("PersonMobilePhone") && q.includes("PersonHomePhone") && q.includes("PersonOtherPhone"),
    "all person phone fields searched");
});

// P3: journaling against a person contact maintains the ACCOUNT
await runTest("personaccount: journaling updates the Account, not a Contact", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000020AA" }, status: 201 } },
    { match: byAccountContactId, reply: { records: [personAccount("001PA0000000001AAA", "003PC0000000001AAA", "+447911123456")] } },
    noRecentCall,
    { match: byTask, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "00TAL700000000001AA" }] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003PC0000000001AAA")), paEnv, ctx);
  await Promise.all(ctx.tasks);

  const accountPatch = calls.find(c => c.method === "PATCH" && c.url.includes("/sobjects/Account/001PA0000000001AAA"));
  check(!!accountPatch, "Account record patched");
  check(!calls.some(c => c.method === "PATCH" && c.url.includes("/sobjects/Contact/")), "backing Contact left alone");
  const patches = calls.filter(c => c.method === "PATCH" && c.url.includes("/sobjects/Account/")).map(c => JSON.parse(c.body));
  check(!patches.some(p => p.FirstName), "name never auto-written onto the Account");
  check(patches.some(p => (p.Description || "").includes("my name is Sarah Jones")), "transcript appended to the Account");
  check(patches.some(p => (p.Description || "").includes('Possible caller name mentioned: "Sarah Jones"')), "hint recorded on the Account");
  check(alertTaskPost()?.WhoId === "003PC0000000001AAA", "reminder links to the person contact id");
});

// P3b: PersonContactId rejected as a filter → falls back via Contact.AccountId
await runTest("personaccount: falls back to Contact.AccountId if PersonContactId is unfilterable", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000023AA" }, status: 201 } },
    { match: byAccountContactId, reply: { json: [{ errorCode: "INVALID_FIELD" }], status: 400 } },
    { match: r => r.method === "GET" && r.url.includes("FROM+Contact+WHERE+Id"),
      reply: { records: [{ Id: "003PC0000000001AAA", AccountId: "001PA0000000001AAA", IsPersonAccount: true }] } },
    { match: r => r.method === "GET" && r.url.includes("FROM+Account+WHERE+Id"),
      reply: { records: [personAccount("001PA0000000001AAA", "003PC0000000001AAA", "+447911123456")] } },
    noRecentCall,
    { match: byTask, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "00TAL900000000001AA" }] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003PC0000000001AAA")), paEnv, ctx);
  await Promise.all(ctx.tasks);

  const accountPatch = calls.find(c => c.method === "PATCH" && c.url.includes("/sobjects/Account/001PA0000000001AAA"));
  check(!!accountPatch, "Account still maintained via the fallback path");
  check(!!alertTaskPost(), "reminder still raised");
});

// L1: lead mode creates a Lead with Company omitted (so it converts to a PA)
await runTest("lead: unknown caller creates a Lead with blank Company", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byAccountPhone, reply: { records: [] } },
    { match: byLeadPhone, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [openLead("00QLD0000000001AAA", "+447911123456")] } },
    { match: leadPost, reply: { json: { id: "00QLD0000000001AAA" }, status: 201 } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    leadEnv, makeCtx());
  const data = await res.json();

  const created = JSON.parse(calls.find(leadPost).body);
  check(!("Company" in created), "Company omitted so the Lead converts to a Person Account");
  check(created.Phone === "+447911123456", "E.164 phone on the Lead");
  check(data.searchRecords?.[0]?.Id === "00QLD0000000001AAA", "Lead id returned to 3CX");
  check(data.searchRecords?.[0]?.attributes?.type === "Lead", "entity type Lead");
  check(!calls.some(accountPost), "no Person Account created on first call");
});

// L2: once converted, the Person Account wins over any Lead
await runTest("lead: converted caller matches the Person Account first", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byAccountPhone, reply: { records: [personAccount("001PA0000000003AAA", "003PC0000000003AAA", "+447911123456")] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    leadEnv, makeCtx());
  const data = await res.json();
  check(data.searchRecords?.[0]?.Id === "003PC0000000003AAA", "Person Account returned");
  check(!calls.some(byLeadPhone), "Lead search skipped once an account matched");
  check(!calls.some(leadPost), "no second Lead created");
});

// L3: second call while the Lead is still unconverted reuses that Lead
await runTest("lead: unconverted repeat caller reuses the same Lead", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byAccountPhone, reply: { records: [] } },
    { match: byLeadPhone, reply: { records: [openLead("00QLD0000000001AAA", "+447911123456")] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    leadEnv, makeCtx());
  const data = await res.json();
  check(data.searchRecords?.[0]?.Id === "00QLD0000000001AAA", "existing Lead reused");
  check(!calls.some(leadPost), "no duplicate Lead created");
});

// L4: journaling against a Lead maintains the Lead and raises a Lead reminder
await runTest("lead: journaling updates the Lead and asks for qualification", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000021AA" }, status: 201 } },
    { match: byLeadId, reply: { records: [openLead("00QLD0000000001AAA", "+447911123456")] } },
    noRecentCall,
    { match: byTask, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "00TAL800000000001AA" }] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("00QLD0000000001AAA")), leadEnv, ctx);
  await Promise.all(ctx.tasks);

  const leadPatches = calls.filter(c => c.method === "PATCH" && c.url.includes("/sobjects/Lead/")).map(c => JSON.parse(c.body));
  check(!leadPatches.some(p => p.FirstName), "name never auto-written onto the Lead");
  check(leadPatches.some(p => (p.Description || "").includes("my name is Sarah Jones")), "transcript appended to the Lead");
  check(leadPatches.some(p => (p.Description || "").includes('Possible caller name mentioned: "Sarah Jones"')), "hint recorded on the Lead");
  const alert = alertTaskPost();
  check(alert?.WhoId === "00QLD0000000001AAA", "reminder linked to the Lead");
  check(alert?.Description.includes("convert the Lead"), "reminder asks for Lead qualification");
});

// L5: a converted/registered Lead stops reminder nagging
await runTest("lead: qualified Lead auto-completes leftover reminders", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000022AA" }, status: 201 } },
    { match: byLeadId, reply: { records: [{ Id: "00QLD0000000002AAA", FirstName: "Jane", LastName: "Doe", Phone: "+447911123456", Description: "" }] } },
    noRecentCall,
    { match: byTask, reply: { records: [{ Id: "00TOLD00000000002AA", Description: "old" }] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("00QLD0000000002AAA")), leadEnv, ctx);
  await Promise.all(ctx.tasks);
  const closed = taskPatches()[0];
  check(closed?.body.Status === "Completed", "leftover reminder completed");
  check(!calls.some(c => c.method === "PATCH" && c.url.includes("/sobjects/Lead/")), "qualified Lead left untouched");
});

// P4: extra field mapping is applied from config
await runTest("extra fields from config are stamped onto created records", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byAccountPhone, reply: { records: [] } },
    { match: byLeadPhone, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [openLead("00QLD0000000003AAA", "+447911123456")] } },
    { match: leadPost, reply: { json: { id: "00QLD0000000003AAA" }, status: 201 } }
  ];
  await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    { ...leadEnv, SALESFORCE_EXTRA_FIELDS: '{"Lead":{"LeadSource":"3CX","Care_Home__c":"Bristol"}}' }, makeCtx());
  const created = JSON.parse(calls.find(leadPost).body);
  check(created.LeadSource === "3CX" && created.Care_Home__c === "Bristol", "custom fields applied to the Lead");
});

// P5: malformed extra-field config must not break record creation
await runTest("invalid extra-field JSON is ignored rather than fatal", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byAccountPhone, reply: { records: [] } },
    { match: byLeadPhone, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [openLead("00QLD0000000004AAA", "+447911123456")] } },
    { match: leadPost, reply: { json: { id: "00QLD0000000004AAA" }, status: 201 } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)"),
    { ...leadEnv, SALESFORCE_EXTRA_FIELDS: "{not json" }, makeCtx());
  const data = await res.json();
  check(data.searchRecords?.[0]?.Id === "00QLD0000000004AAA", "Lead still created despite bad config");
});

// N1: pronouns and filler must never be captured as a caller's name
await runTest("name extraction rejects pronouns and filler", async () => {
  const rejected = [
    "Transcription: hi this is me calling about the invoice",
    "Transcription: hello I'm just calling back about my order",
    "Transcription: this is reception putting you through",
    "Transcription: I'm sorry I think I have the wrong number",
    "Transcription: my name is extension 102 testing",
    "Transcription: this is good morning to you"
  ];

  for (const transcript of rejected) {
    calls = [];
    routes = [
      tokenRoute,
      { match: taskPost, reply: { json: { id: "00TCALL0000000030AA" }, status: 201 } },
      { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
      noRecentCall,
      { match: byTask, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "00TAL999999999991AA" }] } },
      patch204, delete204
    ];
    const ctx = makeCtx();
    await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA",
      `17/07/2026 15:00: Answered incoming call from 447911123456  to 102 (00:00:20)\n\n${transcript}`)), env, ctx);
    await Promise.all(ctx.tasks);

    const named = contactPatches().find(p => p.body.FirstName);
    check(!named, `no name invented from "${transcript.slice(15, 45)}…" (got "${named?.body.FirstName}")`);
  }
});

// N2: a genuine introduction becomes a hint, never the record's name
await runTest("real introduction is recorded as a hint, not as the name", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000031AA" }, status: 201 } },
    { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
    noRecentCall,
    { match: byTask, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "00TAL999999999992AA" }] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA",
    "17/07/2026 15:00: Answered incoming call from 447911123456  to 102 (00:00:20)\n\nTranscription: hello my name is Kieran Paling and I have a question")), env, ctx);
  await Promise.all(ctx.tasks);
  check(!contactPatches().some(p => p.body.FirstName), "name field left as Unregistered Contact");
  const descPatch = contactPatches().find(p => p.body.Description);
  check(descPatch?.body.Description.includes('Possible caller name mentioned: "Kieran Paling"'),
    "detected name surfaced as an unverified hint");
});

// S1: type-ahead searches shorter than the minimum never reach Salesforce
await runTest("type-ahead: short search terms answered locally", async () => {
  routes = [tokenRoute];
  const shortSearch = "SELECT Id,FirstName FROM Contact WHERE FirstName LIKE '%07%' OR Phone LIKE '%07%' LIMIT 1";
  const res = await worker.fetch(
    new Request(`https://worker.example/services/data/v55.0/query/?q=${encodeURIComponent(shortSearch)}`,
      { headers: { "X-Proxy-API-Key": "secret" } }), env, makeCtx());
  const data = await res.json();
  check(res.status === 200 && data.totalSize === 0, "empty result returned");
  check(!calls.some(c => c.url.startsWith(SF) && c.url.includes("/query/")), "no Salesforce API call spent");
});

// S1b: once a term returns nothing, longer terms are answered locally
await runTest("type-ahead: empty result short-circuits every longer term", async () => {
  routes = [
    tokenRoute,
    { match: r => r.url.startsWith(`${SF}/services/data/v55.0/query/`), reply: { totalSize: 0, done: true, records: [] } }
  ];
  const search = t => new Request(
    `https://worker.example/services/data/v55.0/query/?q=${encodeURIComponent(`SELECT Id FROM Contact WHERE Phone LIKE '%${t}%' LIMIT 20`)}`,
    { headers: { "X-Proxy-API-Key": "secret" } });

  // First search reaches Salesforce and comes back empty.
  await worker.fetch(search("77714"), env, makeCtx());
  const afterFirst = calls.filter(c => c.url.startsWith(SF) && c.url.includes("/query/")).length;
  check(afterFirst === 1, "first search forwarded to Salesforce");

  // Every keystroke after that extends a known-empty term.
  for (const t of ["777141", "7771412", "77714123"]) {
    await worker.fetch(search(t), env, makeCtx());
  }
  const afterRest = calls.filter(c => c.url.startsWith(SF) && c.url.includes("/query/")).length;
  check(afterRest === 1, `longer terms answered locally (Salesforce hit ${afterRest} times, expected 1)`);

  // An unrelated term is not suppressed by the cache.
  routes.push({ match: r => true, reply: { totalSize: 0, done: true, records: [] } });
  await worker.fetch(search("99999"), env, makeCtx());
  const afterUnrelated = calls.filter(c => c.url.startsWith(SF) && c.url.includes("/query/")).length;
  check(afterUnrelated === 2, "unrelated search still reaches Salesforce");
});

// S2: real searches still pass through
await runTest("type-ahead: full-length search still queries Salesforce", async () => {
  routes = [
    tokenRoute,
    { match: r => r.url.startsWith(`${SF}/services/data/v55.0/query/`), reply: { records: [{ Id: "003REAL000001AAA" }] } }
  ];
  const longSearch = "SELECT Id,FirstName FROM Contact WHERE Phone LIKE '%07700900456%' LIMIT 1";
  const res = await worker.fetch(
    new Request(`https://worker.example/services/data/v55.0/query/?q=${encodeURIComponent(longSearch)}`,
      { headers: { "X-Proxy-API-Key": "secret" } }), env, makeCtx());
  const data = await res.json();
  check(data.records?.[0]?.Id === "003REAL000001AAA", "query forwarded to Salesforce");
});

// T13: GetAccountName guard — WHERE Id = '' answered locally
await runTest("empty-AccountId query short-circuited locally", async () => {
  routes = [tokenRoute];
  const res = await worker.fetch(
    new Request(`https://worker.example/services/data/v55.0/query/?q=${encodeURIComponent("SELECT Name from Account where Id = ''")}`, {
      headers: { "X-Proxy-API-Key": "secret" }
    }), env, makeCtx());
  const data = await res.json();
  check(res.status === 200 && data.totalSize === 0, "returns empty result set without hitting Salesforce");
  check(!calls.some(c => c.url.startsWith(SF) && c.url.includes("/query/")), "Salesforce not queried");
});

// ── Structural dedup via a unique External ID field ─────────────────────

const upsertEnv = { ...env, SALESFORCE_EXTERNAL_ID_FIELD: "Phone_E164__c" };
const keyGet   = r => r.method === "GET" && r.url.includes("/sobjects/Contact/Phone_E164__c/");
const keyQuery = r => r.method === "GET" && r.url.includes("WHERE+Phone_E164__c");
const anyWrite = r => ["POST", "PATCH", "DELETE"].includes(r.method) && r.url.includes("/sobjects/Contact");

// X1: unknown caller — the key is absent, so a record is inserted carrying it
await runTest("external id: absent key inserts, carrying the key", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: keyGet, reply: { json: [{ errorCode: "NOT_FOUND" }], status: 404 } },
    { match: keyQuery, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "003UPS000000001AAA", FirstName: "Unregistered Contact", LastName: "+447911123456", Phone: "+447911123456" }] } },
    { match: byPhone, reply: { records: [] } },
    { match: contactPost, reply: { json: { id: "003UPS000000001AAA" }, status: 201 } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {447911123456} IN PHONE FIELDS RETURNING Contact(Id)"), upsertEnv, makeCtx());

  check(!!calls.find(keyGet), "looked the key up before writing anything");
  const insert = calls.find(contactPost);
  check(!!insert, "inserted the record");
  check(JSON.parse(insert.body).Phone_E164__c === "+447911123456", "external id written on insert");
  check(!calls.some(c => c.method === "PATCH" && c.url.includes("Phone_E164__c/")), "never PATCHes the key endpoint");
  check((await res.json()).searchRecords[0].Id === "003UPS000000001AAA", "record returned to 3CX");
});

// X2: THE REGRESSION. A curated record whose Phone the finder cannot match,
// but whose External ID does. Before read-before-write this PATCHed the
// ring-time placeholder over it, erasing the name and every call block.
await runTest("external id: never overwrites a record the phone finder missed", async () => {
  const curated = {
    Id: "003CURATED0001AAA",
    FirstName: "Margaret",
    LastName: "Hale",
    Phone: "07911 123 456",
    Description: "14 previous calls and staff notes"
  };
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: keyGet, reply: { json: curated, status: 200 } },
    { match: keyQuery, reply: { records: [curated] } },
    { match: byPhone, reply: { records: [] } },
    { match: anyWrite, reply: { json: { id: "SHOULD_NOT_HAPPEN" }, status: 201 } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {447911123456} IN PHONE FIELDS RETURNING Contact(Id)"), upsertEnv, makeCtx());

  check(!calls.some(anyWrite), "NOTHING is written to the matched record");
  const returned = (await res.json()).searchRecords[0];
  check(returned.Id === "003CURATED0001AAA", "the existing record is handed back to 3CX");
  check(returned.FirstName === "Margaret" && returned.LastName === "Hale", "human-entered name intact");
});

// X3: a simultaneous insert loses to the unique constraint and adopts the winner
await runTest("external id: insert race adopts the winner", async () => {
  const winner = { Id: "003WIN00000001AAA", FirstName: "Unregistered Contact", LastName: "+447911123456", Phone: "+447911123456" };
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: keyGet, reply: { json: [{ errorCode: "NOT_FOUND" }], status: 404 } },
    { match: keyQuery, reply: { records: [winner] } },
    { match: byPhone, reply: { records: [] } },
    { match: contactPost, reply: { json: [{ errorCode: "DUPLICATE_VALUE", message: "duplicate value found" }], status: 400 } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {447911123456} IN PHONE FIELDS RETURNING Contact(Id)"), upsertEnv, makeCtx());

  check((await res.json()).searchRecords[0].Id === "003WIN00000001AAA", "adopted the record that won the race");
  check(!calls.some(c => c.method === "DELETE"), "no convergence delete needed, the constraint did the work");
});

// X4: the finder itself now searches the external id, so the miss never happens
await runTest("external id: the finder searches the key as well as the phone fields", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [{ Id: "003FOUND000001AAA", FirstName: "Margaret", LastName: "Hale", Phone: "07911 123 456" }] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {447911123456} IN PHONE FIELDS RETURNING Contact(Id)"), upsertEnv, makeCtx());

  // Turn the URL's "+" separators into %20 BEFORE decoding, so the literal
  // plus in "+447911123456" (encoded %2B) survives as a plus.
  const q = decodeURIComponent(calls.find(byPhone).url.replace(/\+/g, "%20"));
  check(q.includes("Phone_E164__c = '+447911123456'"), "identity query includes the external id");
  check((await res.json()).searchRecords[0].Id === "003FOUND000001AAA", "curated record found without any write");
  check(!calls.some(anyWrite), "and nothing written");
});

// X5: without the field configured, the query is unchanged
await runTest("external id: unconfigured leaves the identity query alone", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [{ Id: "003PLAIN00001AAA", Phone: "+447911123456" }] } }
  ];
  await worker.fetch(lookupRequest("FIND {447911123456} IN PHONE FIELDS RETURNING Contact(Id)"), env, makeCtx());
  const q = decodeURIComponent(calls.find(byPhone).url);
  check(!q.includes("Phone_E164__c"), "no external id clause when the variable is unset");
});

// ── Background failure visibility ───────────────────────────────────────

const failureTaskPost = () => calls.filter(taskPost).map(c => JSON.parse(c.body))
  .find(b => (b.Subject || "").startsWith("3CX Integration Error:"));

// V1: a silent maintenance failure raises a visible alert
await runTest("failure alert: maintenance error becomes a Salesforce task", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000009AA" }, status: 201 } },
    noRecentCall,
    { match: r => r.method === "GET" && r.url.includes("3CX+Integration+Error"), reply: { records: [] } },
    { match: byId, reply: { json: [{ message: "boom" }], status: 500 } }
  ];
  const ctx = makeCtx();
  const res = await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")), env, ctx);
  await Promise.all(ctx.tasks);

  check(res.status === 201, "the call log itself still succeeded");
  const alert = failureTaskPost();
  check(!!alert, "an error task was raised");
  check(alert?.WhoId === "003RING00000001AAA", "linked to the affected record");
  check(alert?.Priority === "High", "flagged high priority");
  check(alert?.Subject !== undefined && !alert.Subject.startsWith("Action Required:"),
    "kept distinct from caller reminders so the upsert cannot overwrite it");
});

// V2: repeated failures update the existing alert rather than stacking
await runTest("failure alert: repeat failures update one alert", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000010AA" }, status: 201 } },
    noRecentCall,
    { match: r => r.method === "GET" && r.url.includes("3CX+Integration+Error"), reply: { records: [{ Id: "00TERR0000000001AA" }] } },
    { match: byId, reply: { json: [{ message: "boom" }], status: 500 } },
    patch204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")), env, ctx);
  await Promise.all(ctx.tasks);

  check(!failureTaskPost(), "no second alert task created");
  check(taskPatches().some(p => p.url.includes("00TERR0000000001AA")), "existing alert updated instead");
});

// V3: the webhook fires so someone hears about it even if Salesforce is down
await runTest("failure alert: webhook notified when configured", async () => {
  const hook = "https://hooks.example.com/notify";
  routes = [
    tokenRoute,
    { match: taskPost, reply: { json: { id: "00TCALL0000000011AA" }, status: 201 } },
    noRecentCall,
    { match: r => r.url === hook, reply: { ok: true } },
    { match: r => r.method === "GET" && r.url.includes("3CX+Integration+Error"), reply: { records: [] } },
    { match: byId, reply: { json: [{ message: "boom" }], status: 500 } }
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")),
    { ...env, ALERT_WEBHOOK_URL: hook }, ctx);
  await Promise.all(ctx.tasks);

  const posted = calls.find(c => c.url === hook);
  check(!!posted && posted.method === "POST", "webhook called");
  check(JSON.parse(posted.body).text.includes("003RING00000001AAA"), "names the affected record");
});

// ── Readable call history ───────────────────────────────────────────────

const maintenanceRoutes = (extra = []) => [
  tokenRoute,
  { match: taskPost, reply: { json: { id: "00TCALL0000000020AA" }, status: 201 } },
  { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
  noRecentCall,
  { match: byTask, reply: { records: [] } },
  ...extra,
  patch204, delete204
];
const appendedDescription = () => contactPatches().find(p => p.body.Description)?.body.Description || "";

// R1: the call's own timestamp is used, not the moment it was journaled
await runTest("history: uses the call's timestamp, not processing time", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")), env, ctx);
  await Promise.all(ctx.tasks);

  // inboundDescription opens "17/07/2026 15:00: Answered incoming call ..."
  check(appendedDescription().includes("15:00"), "block header carries the call's own time");
  const stamped = contactPatches().find(p => p.body.LastName)?.body.LastName || "";
  check(stamped.includes("15:00"), `record name carries the call's own time (got "${stamped}")`);
});

// R2: 3CX's raw line is not pasted in, so the display name cannot echo
await runTest("history: caller's own name is not echoed back into their history", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")), env, ctx);
  await Promise.all(ctx.tasks);

  const d = appendedDescription();
  check(!d.includes("Answered incoming call from"), "3CX's raw line not pasted into the record");
  check(!d.includes("Unregistered Contact +447911123456 to"), "display name not echoed");
  check(d.includes("Transcription: Hello my name is Sarah Jones"), "transcript still kept");
});

// R3: sections with no content are dropped rather than left as empty headings
await runTest("history: empty transcript sections are omitted", async () => {
  const bare = "17/07/2026 15:00: Answered incoming call from 447911123456 to 102 (00:09:42)\n\n" +
               "Transcription: \n\nSummary: \n\nSentiment: \n\nRecording:";
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", bare)), env, ctx);
  await Promise.all(ctx.tasks);

  const d = appendedDescription();
  check(!/Transcription:\s*$/m.test(d), "no empty Transcription heading");
  check(!/Summary:\s*$/m.test(d), "no empty Summary heading");
  check(!/Sentiment:\s*$/m.test(d), "no empty Sentiment heading");
  check(d.includes("No transcription or recording available"), "says so plainly instead");
  check(d.includes("00:09:42"), "duration still recorded in the header");
});

// R4: the site an extension belongs to reaches the record
await runTest("history: department mapped from the extension", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")),
    { ...env, EXTENSION_DEPARTMENTS: '{"10":"Arbour Walk","102":"Bath House"}' }, ctx);
  await Promise.all(ctx.tasks);

  const name = contactPatches().find(p => p.body.LastName)?.body.LastName || "";
  check(name.includes("Bath House"), `longest prefix wins over shorter (got "${name}")`);
  check(!name.includes("Arbour Walk"), "shorter prefix not used when a longer one matches");
  check(appendedDescription().includes("Ext 102 (Bath House)"), "site shown in the call block");
});

// R5: unmapped extensions and bad JSON degrade quietly
await runTest("history: no department mapping changes nothing", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")),
    { ...env, EXTENSION_DEPARTMENTS: "{not json" }, ctx);
  await Promise.all(ctx.tasks);

  const name = contactPatches().find(p => p.body.LastName)?.body.LastName || "";
  check(/^\+447911123456 \(Inbound 15:00, Ext 102\)$/.test(name),
    `invalid JSON ignored, name unchanged (got "${name}")`);
  check(appendedDescription().includes("Ext 102"), "call block still names the extension");
});

// ── Routing legs (auto attendant, queue) ────────────────────────────────

const ivrDescription =
  "17/07/2026 15:44: Answered incoming call from 447911123456 to 1001 (01:02)\n\n" +
  "Transcription: \n\nSummary: \n\nSentiment: \n\nRecording:";
const queueDescription =
  "17/07/2026 15:45: Answered incoming call from 447911123456 to 1002 (28:14)\n\n" +
  "Transcription: \n\nSummary: \n\nSentiment: \n\nRecording:";
const sysEnv = { ...env, EXTENSION_DEPARTMENTS: '{"1002":"Reception queue"}' };
const sysHeaders = { "X-System-Extensions": "1001,1002" };
const legacySysEnv = { ...env, SYSTEM_EXTENSIONS: "1001,1002" };

// S1: an auto attendant leg must not claim the record's name
await runTest("routing: auto attendant does not stamp the record name", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", ivrDescription), sysHeaders), sysEnv, ctx);
  await Promise.all(ctx.tasks);

  check(!contactPatches().some(p => p.body.LastName),
    "name left as the bare number, so the human leg can stamp it");
  const d = appendedDescription();
  check(d.includes("Routed via extension 1001 at 15:44"), "recorded as a one-line routing note");
  check(!d.includes("====="), "no full call block for a routing leg");
  check(!d.includes("No transcription or recording available"), "no filler about a missing transcript");
});

// S2: a long queue hold is one line, not a block that buries the real call
await runTest("routing: queue hold recorded compactly with its wait", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", queueDescription), sysHeaders), sysEnv, ctx);
  await Promise.all(ctx.tasks);

  const d = appendedDescription();
  check(d.includes("Reception queue (1002)"), "queue named from the department map");
  check(d.includes("held 28:14"), "wait time kept, since it is worth knowing");
  check(!d.includes("====="), "no full call block");
});

// S3: the human leg still behaves normally
await runTest("routing: the human leg still stamps and logs in full", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA"), sysHeaders), sysEnv, ctx);
  await Promise.all(ctx.tasks);

  const name = contactPatches().find(p => p.body.LastName)?.body.LastName || "";
  check(name.includes("Ext 102"), `real extension stamps the name (got "${name}")`);
  check(appendedDescription().includes("====="), "full block for a real conversation");
});

// S4: a routing leg that somehow carries a transcript is not discarded
await runTest("routing: a routing leg with a transcript keeps it", async () => {
  const talkingIvr = ivrDescription.replace("Transcription: \n", "Transcription: Caller asked for the nursing team\n");
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", talkingIvr), sysHeaders), sysEnv, ctx);
  await Promise.all(ctx.tasks);

  const d = appendedDescription();
  check(d.includes("Caller asked for the nursing team"), "transcript preserved");
  check(d.includes("====="), "given a full block because something was said");
});

// S5: a PBX still on an older template falls back to the variable
await runTest("routing: SYSTEM_EXTENSIONS variable still honoured without the header", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", ivrDescription)), legacySysEnv, ctx);
  await Promise.all(ctx.tasks);

  check(appendedDescription().includes("Routed via extension 1001"), "recognised from the variable alone");
  check(!contactPatches().some(p => p.body.LastName), "still does not stamp the record name");
});

// S6: with neither configured, nothing is treated as routing
await runTest("routing: unconfigured means every extension is treated as a person", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", ivrDescription)), env, ctx);
  await Promise.all(ctx.tasks);

  check(appendedDescription().includes("====="), "auto attendant leg gets a full block");
  const name = contactPatches().find(p => p.body.LastName)?.body.LastName || "";
  check(name.includes("Ext 1001"), `and stamps the menu extension onto the name (got "${name}")`);
});

// S7: a wildcard covers a whole family of call-handling objects
await runTest("routing: wildcard matches a family of system extensions", async () => {
  const groupCall = "17/07/2026 15:44: Answered incoming call from 447911123456 to GRP0007 (00:31)\n\n" +
                    "Transcription: \n\nSummary: \n\nSentiment: \n\nRecording:";
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", groupCall),
    { "X-System-Extensions": "1001, GRP*" }), env, ctx);
  await Promise.all(ctx.tasks);

  check(appendedDescription().includes("Routed via extension GRP0007"), "ring group matched by prefix");
  check(!contactPatches().some(p => p.body.LastName), "does not stamp the record name");
});

// S8: the wildcard must be explicit, so a bare entry cannot over-match
await runTest("routing: entries without a wildcard stay exact", async () => {
  const ext1050 = "17/07/2026 15:44: Answered incoming call from 447911123456 to 1050 (04:12)\n\n" +
                  "Transcription: Hello, this is the nursing team\n\nSummary: \n\nSentiment: \n\nRecording:";
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", ext1050),
    { "X-System-Extensions": "10, 1001" }), env, ctx);
  await Promise.all(ctx.tasks);

  const name = contactPatches().find(p => p.body.LastName)?.body.LastName || "";
  check(name.includes("Ext 1050"), `"10" does not swallow 1050 (got "${name}")`);
  check(appendedDescription().includes("Hello, this is the nursing team"), "treated as a real conversation");
});

// ── Excluded extensions ─────────────────────────────────────────────────

// E1: a confidential extension's call never reaches Salesforce
await runTest("excluded ext: call log dropped entirely", async () => {
  routes = [tokenRoute];
  const ctx = makeCtx();
  const res = await worker.fetch(
    taskRequest(callTaskBody("003RING00000001AAA"), { "X-Excluded-Extensions": "102" }), env, ctx);
  await Promise.all(ctx.tasks);

  const body = await res.json();
  check(res.status === 201 && body.success === true, "3CX told it succeeded, so it does not retry");
  check(body.filtered === "extension", "reported as an extension exclusion");
  check(!calls.some(taskPost), "nothing written to Salesforce");
  check(!calls.some(c => c.method === "PATCH"), "record not touched either");
});

// E2: the wildcard works here too
await runTest("excluded ext: wildcard covers a range", async () => {
  routes = [tokenRoute];
  const ctx = makeCtx();
  const res = await worker.fetch(
    taskRequest(callTaskBody("003RING00000001AAA"), { "X-Excluded-Extensions": "1*" }), env, ctx);
  await Promise.all(ctx.tasks);
  check((await res.json()).filtered === "extension", "extension 102 matched by the 1* prefix");
});

// E3: everyone else is unaffected
await runTest("excluded ext: other extensions still logged", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(
    taskRequest(callTaskBody("003RING00000001AAA"), { "X-Excluded-Extensions": "300,301" }), env, ctx);
  await Promise.all(ctx.tasks);
  check(!!forwardedCallTask(), "unlisted extension journals normally");
});

// E4: ring time, when 3CX supplies the extension, nothing is created
await runTest("excluded ext: no record created at ring time", async () => {
  routes = [tokenRoute, { match: sfSearch, reply: { searchRecords: [] } }];
  const res = await worker.fetch(
    lookupRequest("FIND {447911123456} IN PHONE FIELDS RETURNING Contact(Id)",
      { "X-Excluded-Extensions": "102", "X-Agent-Extension": "102" }), env, makeCtx());

  check((await res.json()).searchRecords.length === 0, "lookup stays empty");
  check(!calls.some(contactPost), "no record created");
});

// E5: an unsubstituted placeholder must not be mistaken for an extension
await runTest("excluded ext: unsubstituted [Agent] placeholder ignored", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "003NEW0000000001AA", Phone: "+447911123456" }] } },
    { match: contactPost, reply: { json: { id: "003NEW0000000001AA" }, status: 201 } }
  ];
  await worker.fetch(
    lookupRequest("FIND {447911123456} IN PHONE FIELDS RETURNING Contact(Id)",
      { "X-Excluded-Extensions": "102", "X-Agent-Extension": "[Agent]" }), env, makeCtx());

  check(calls.some(contactPost), "record still created, placeholder not treated as an extension");
});

// ── Confidential extensions ─────────────────────────────────────────────

const confHeaders = { "X-Confidential-Extensions": "102" };

// C1: the call is logged, its content is not
await runTest("confidential: call logged, content withheld", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  const res = await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA"), confHeaders), env, ctx);
  await Promise.all(ctx.tasks);

  check(res.status === 201, "call still journaled");
  const logged = forwardedCallTask();
  check(!!logged, "call log written to Salesforce");
  check(logged.Description.includes("Answered incoming call"), "who, when and how long is kept");
  check(logged.Description.includes("Content withheld"), "says plainly why there is no transcript");
});

// C2: nothing derived from what was said survives, summary included
await runTest("confidential: transcript, summary, sentiment and recording all removed", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA"), confHeaders), env, ctx);
  await Promise.all(ctx.tasks);

  const d = forwardedCallTask().Description;
  check(!d.includes("Sarah Jones"), "transcript gone");
  check(!d.includes("Caller asked about an order"), "AI summary gone, being the same content in fewer words");
  check(!d.includes("Neutral"), "sentiment gone");
  check(!d.includes("rec.wav"), "recording link gone");
});

// C3: and none of it reaches the record either
await runTest("confidential: content never reaches the contact record", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA"), confHeaders), env, ctx);
  await Promise.all(ctx.tasks);

  const d = appendedDescription();
  check(d.length > 0, "the call is still appended to the record");
  check(!d.includes("Sarah Jones"), "no transcript on the record");
  check(!d.includes("rec.wav"), "no recording link on the record");
  check(!alertTaskPost()?.Description?.includes("Sarah Jones"), "and no name hint mined from it");
});

// C4: other extensions keep their transcripts
await runTest("confidential: unlisted extensions unaffected", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA"),
    { "X-Confidential-Extensions": "300,4*" }), env, ctx);
  await Promise.all(ctx.tasks);
  check(forwardedCallTask().Description.includes("Sarah Jones"), "extension 102 keeps its transcript");
});

// ═════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} checks passed, ${failed} failed`);
globalThis.fetch = realFetch;
process.exit(failed === 0 ? 0 : 1);
