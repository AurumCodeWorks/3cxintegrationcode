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
    body: init.body ? String(init.body) : null,
    headers: new Headers(init.headers || {})
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
const callLogPostsOf = log => log.filter(taskPost).map(c => JSON.parse(c.body)).filter(b => b.Subject === "3CX PhoneSystem Call");
const integrationAlerts = () => calls.filter(taskPost).map(c => JSON.parse(c.body))
  .filter(b => (b.Subject || "").startsWith("3CX Integration Error:"));
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
  check(!descPatch?.body.Description.includes("my name is Sarah Jones"), "transcription kept off the contact");
  check(forwardedCallTask()?.Description.includes("my name is Sarah Jones"), "transcription stays on the call log");
  check(!descPatch?.body.Description.includes("Sarah Jones"), "no name heard on the call written to the record");
  check(alertTaskPost()?.Description.includes("(unverified, from call transcription)"), "hint is explicitly marked unverified");
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
  check(descPatch?.body.Description.includes("15:00 · Inbound · 0:35"), "second call added to the history");
  check(!alertTaskPost(), "no duplicate reminder created");
  const reminderPatch = taskPatches().find(p => p.body.Description);
  check(reminderPatch?.body.Description.includes("Original reminder text"), "reminder history preserved");
  check(reminderPatch?.body.Description.includes("15:00 · Inbound · ext 102"), "reminder lists the repeat call");
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
  check(descPatch?.body.Description.includes("· Missed"), "direction captured in history");
  const alert = alertTaskPost();
  check(alert?.Subject.includes("+447700900123"), "reminder references the number");
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
  check(merged?.Description.includes("Then ext 102 at 15:00"), "continuation line added");
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
  const since = new Date(query.match(/LastModifiedDate >= (\S+)/)[1]);
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
  // Contacts are matched on Phone and MobilePhone only. HomePhone,
  // OtherPhone, AssistantPhone and Fax were dropped from both the template
  // and these queries because Cedar Care's org hides them from the
  // integration user, and one hidden field fails the whole lookup (see the
  // findings in SALESFORCE-PERMISSIONS.md).
  for (const field of ["Phone", "MobilePhone"]) {
    check(soql.includes(`${field} IN (`), `${field} searched`);
  }
  for (const field of ["HomePhone", "OtherPhone", "AssistantPhone"]) {
    check(!soql.includes(`${field} IN (`), `${field} left out, since the org hides it`);
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
const byBusinessContact = r => r.method === "GET" && r.url.includes("FROM+Contact+WHERE+IsPersonAccount+%3D+false");
const noBusinessContact = { match: byBusinessContact, reply: { records: [] } };
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
    noBusinessContact,
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
    noBusinessContact,
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
  check(patches.some(p => (p.Description || "").includes("Answered by ext 102")), "call added to the Account's history");
  check(!patches.some(p => (p.Description || "").includes("Sarah Jones")), "nothing said on the call written to the Account");
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
    noBusinessContact,
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
  check(leadPatches.some(p => (p.Description || "").includes("Answered by ext 102")), "call added to the Lead's history");
  check(!leadPatches.some(p => (p.Description || "").includes("Sarah Jones")), "nothing said on the call written to the Lead");
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
    noBusinessContact,
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
    noBusinessContact,
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
  check(alertTaskPost()?.Description.includes('Possible caller name mentioned: "Kieran Paling"'),
    "detected name surfaced as an unverified hint on the reminder");
  check(!(descPatch?.body.Description || "").includes("Kieran"), "and kept off the record itself");
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

// ── Person Accounts with the External ID: the live configuration ────────

const paKeyEnv  = { ...paEnv, SALESFORCE_EXTERNAL_ID_FIELD: "Phone_E164__c" };
const paKeyGet  = r => r.method === "GET" && r.url.includes("/sobjects/Account/Phone_E164__c/");
const paKeyQ    = r => r.method === "GET" && r.url.includes("WHERE+Phone_E164__c");
const paAnyWrite = r => ["POST", "PATCH", "DELETE"].includes(r.method) && r.url.includes("/sobjects/Account");

// PX1: the configuration going live — a curated Person Account the phone
// finder cannot match must be returned untouched, with PersonContactId intact
await runTest("personaccount + key: curated account matched and left alone", async () => {
  const curated = {
    Id: "001CURATED0001AAA",
    FirstName: "Margaret",
    LastName: "Hale",
    Phone: "07911 123 456",
    PersonContactId: "003BACKING0001AAA",
    Description: "months of call history"
  };
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: recordTypeQuery, reply: { records: [{ Id: "012RT00000000001AAA" }] } },
    { match: paKeyQ, reply: { records: [curated] } },
    { match: byAccountPhone, reply: { records: [curated] } },
    { match: paKeyGet, reply: { json: curated, status: 200 } },
    { match: paAnyWrite, reply: { json: { id: "SHOULD_NOT_HAPPEN" }, status: 201 } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {447911123456} IN PHONE FIELDS RETURNING Contact(Id)"), paKeyEnv, makeCtx());

  check(!calls.some(paAnyWrite), "nothing written to the Person Account");
  const rec = (await res.json()).searchRecords[0];
  check(rec.Id === "003BACKING0001AAA", "PersonContactId returned to 3CX, not the Account id");
  check(rec.attributes.type === "Contact", "typed as Contact so 3CX populates WhoId");
});

// PX2: the finder query in personaccount mode carries the key and still
// excludes business accounts
await runTest("personaccount + key: identity query keeps IsPersonAccount and adds the key", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: recordTypeQuery, reply: { records: [{ Id: "012RT00000000001AAA" }] } },
    { match: byAccountPhone, reply: { records: [{ Id: "001PA0000000009AAA", PersonContactId: "003B00000000009AAA" }] } }
  ];
  await worker.fetch(lookupRequest("FIND {447911123456} IN PHONE FIELDS RETURNING Contact(Id)"),
    paKeyEnv, makeCtx());

  const q = decodeURIComponent(calls.find(byAccountPhone).url.replace(/\+/g, "%20"));
  check(q.includes("IsPersonAccount = true AND ("), "business accounts still excluded");
  check(q.includes("Phone_E164__c = '+447911123456'"), "external id searched alongside the phone fields");
});

// PX3: an unknown caller inserts, and the insert carries the key so the
// unique constraint actually covers the new row
await runTest("personaccount + key: new caller inserted with the key set", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    noBusinessContact,
    { match: recordTypeQuery, reply: { records: [{ Id: "012RT00000000001AAA" }] } },
    { match: paKeyGet, reply: { json: [{ errorCode: "NOT_FOUND" }], status: 404 } },
    { match: paKeyQ, reply: { records: [{ Id: "001NEW0000000001AAA", PersonContactId: "003NEW0000000001AAA" }] } },
    { match: byAccountPhone, reply: { records: [] } },
    { match: accountPost, reply: { json: { id: "001NEW0000000001AAA" }, status: 201 } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {447911123456} IN PHONE FIELDS RETURNING Contact(Id)"), paKeyEnv, makeCtx());

  const created = JSON.parse(calls.find(accountPost).body);
  check(created.Phone_E164__c === "+447911123456", "key written on insert");
  check(created.RecordTypeId === "012RT00000000001AAA", "person record type still applied");
  check((await res.json()).searchRecords[0].Id === "003NEW0000000001AAA", "backing contact id returned");
});

// PX4: when the keyed insert fails for any reason, the fallback insert must
// still carry the key — Salesforce excludes nulls from unique constraints, so
// a fallback row without it sits outside the guarantee
await runTest("personaccount + key: fallback insert still carries the key", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    noBusinessContact,
    { match: recordTypeQuery, reply: { records: [{ Id: "012RT00000000001AAA" }] } },
    { match: paKeyGet, reply: { json: [{ errorCode: "SERVER_ERROR" }], status: 503 } },
    { match: paKeyQ, reply: { records: [] } },
    { match: byAccountPhone, reply: (r, hits) => hits === 1 ? { records: [] }
        : { records: [{ Id: "001FBK0000000001AA", PersonContactId: "003FBK0000000001AA" }] } },
    { match: accountPost, reply: { json: { id: "001FBK0000000001AA" }, status: 201 } }
  ];
  await worker.fetch(lookupRequest("FIND {447911123456} IN PHONE FIELDS RETURNING Contact(Id)"),
    paKeyEnv, makeCtx());

  const created = JSON.parse(calls.find(accountPost).body);
  check(created.Phone_E164__c === "+447911123456",
    "fallback row is inside the unique constraint, not outside it");
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
    { match: keyQuery, reply: { records: [{ Id: "003UPS000000001AAA", FirstName: "Unregistered Contact", LastName: "+447911123456", Phone: "+447911123456" }] } },
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
  check(!d.includes("Sarah Jones"), "transcript kept off the record");
  check(d.includes("Recording: https://example.com/rec.wav"), "recording link kept");
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
  check(!d.includes("No transcription"), "no filler line in place of the sections");
  check(d.includes("15:00 · Inbound · 9:42"), "duration recorded in the headline");
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
  check(appendedDescription().includes("Answered by ext 102, Bath House"), "home shown in the call entry");
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
  check(appendedDescription().includes("Answered by ext 102"), "call entry still names the extension");
});

// ── Routing legs (auto attendant, queue) ────────────────────────────────

const ivrDescription =
  "17/07/2026 15:44: Answered incoming call from 447911123456 to 1001 (01:02)\n\n" +
  "Transcription: \n\nSummary: \n\nSentiment: \n\nRecording:";
const queueDescription =
  "17/07/2026 15:45: Answered incoming call from 447911123456 to 1002 (28:14)\n\n" +
  "Transcription: \n\nSummary: \n\nSentiment: \n\nRecording:";
const sysEnv = { ...env, EXTENSION_DEPARTMENTS: '{"1002":"Reception queue"}' };
const sysHeaders = { "X-Receptionist-Extensions": "1001,1002" };

// S1: an auto attendant leg must not claim the record's name
await runTest("routing: auto attendant does not stamp the record name", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", ivrDescription), sysHeaders), sysEnv, ctx);
  await Promise.all(ctx.tasks);

  check(!contactPatches().some(p => p.body.LastName),
    "name left as the bare number, so the human leg can stamp it");
  const d = appendedDescription();
  check(d.includes("15:44 · Inbound · 1:02\nmenu 1001"), "recorded as a short routing entry");
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
  check(d.includes("Reception queue menu 1002"), "named from the department map");
  check(d.includes("· 28:14"), "wait time kept, since it is worth knowing");
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
  check(appendedDescription().includes("Answered by ext 102"), "entry names who took the call");
});

// S4: a routing leg that somehow carries a transcript keeps it on its call log
await runTest("routing: a routing leg's transcript stays on its call log", async () => {
  const talkingIvr = ivrDescription.replace("Transcription: \n", "Transcription: Caller asked for the nursing team\n");
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", talkingIvr), sysHeaders), sysEnv, ctx);
  await Promise.all(ctx.tasks);

  const d = appendedDescription();
  check(!d.includes("Caller asked for the nursing team"), "transcript kept off the record");
  check((forwardedCallTask()?.Description || "").includes("Caller asked for the nursing team"), "transcript kept on the call log");
});

// S5: a PBX still on an older template falls back to the variable
await runTest("routing: a tracked queue counts as a system extension without listing it twice", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", queueDescription),
    { "X-Tracked-Queues": "1002" }), sysEnv, ctx);
  await Promise.all(ctx.tasks);

  const d = appendedDescription();
  check(d.includes("queue 1002"), "queue leg recorded as a queue");
  check(!d.includes("====="), "no full call block");
  check(!contactPatches().some(p => p.body.LastName), "queue does not stamp the record name");
});

// S6: with neither configured, nothing is treated as routing
await runTest("routing: unconfigured means every extension is treated as a person", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", ivrDescription)), env, ctx);
  await Promise.all(ctx.tasks);

  check(appendedDescription().includes("Answered by ext 1001"), "an unlisted extension is treated as a person");
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
    { "X-Receptionist-Extensions": "1001, GRP*" }), env, ctx);
  await Promise.all(ctx.tasks);

  check(appendedDescription().includes("menu GRP0007"), "ring group matched by prefix");
  check(!contactPatches().some(p => p.body.LastName), "does not stamp the record name");
});

// S8: the wildcard must be explicit, so a bare entry cannot over-match
await runTest("routing: entries without a wildcard stay exact", async () => {
  const ext1050 = "17/07/2026 15:44: Answered incoming call from 447911123456 to 1050 (04:12)\n\n" +
                  "Transcription: Hello, this is the nursing team\n\nSummary: \n\nSentiment: \n\nRecording:";
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", ext1050),
    { "X-Receptionist-Extensions": "10, 1001" }), env, ctx);
  await Promise.all(ctx.tasks);

  const name = contactPatches().find(p => p.body.LastName)?.body.LastName || "";
  check(name.includes("Ext 1050"), `"10" does not swallow 1050 (got "${name}")`);
  check(appendedDescription().includes("Answered by ext 1050"), "treated as a person, not a menu");
});

// ── Call history format ─────────────────────────────────────────────────

const ukToday = (() => {
  const [dd, mm, yyyy] = new Date().toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "numeric", year: "numeric" }).split("/");
  return `${Number(dd)} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(mm) - 1]} ${yyyy}`;
})();
const historyOf = (...entries) =>
  `--- 3CX call history, newest first ---\n\n${entries.join("\n\n")}\n\n--- end of call history ---`;
const enquiryRecord = (description) => ({
  Id: "003HIST000000001AA", FirstName: "Arbour Walk", LastName: "Enquiry +447911123456 (15 Sep 15:00)",
  Phone: "+447911123456", Description: description
});
const historyRoutes = (record, extra = []) => [
  tokenRoute,
  ...extra,
  { match: taskPost, reply: { json: { id: "00THIST00000000001A" }, status: 201 } },
  { match: byId, reply: { records: [record] } },
  { match: byTask, reply: { records: [] } },
  patch204, delete204
];

// H1: a transferred leg joins the latest entry rather than starting another
await runTest("history: receptionist and answering legs become one entry", async () => {
  const existing = `New enquiry through Arbour Walk (queue 800)\n${ukToday} at 15:00\n\n` +
    historyOf(`${ukToday} 15:00 · Inbound · 0:56\nArbour Walk menu 1001`);
  routes = historyRoutes(enquiryRecord(existing), [
    { match: recentCallQuery, reply: { records: [{ Id: "00TPRIOR0000000002A", Description: "menu leg", CallDurationInSeconds: 56 }] } }
  ]);
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003HIST000000001AA"), { "X-Receptionist-Extensions": "1001" }),
    { ...env, EXTENSION_DEPARTMENTS: '{"10":"Arbour Walk"}' }, ctx);
  await Promise.all(ctx.tasks);

  const d = appendedDescription();
  check((d.match(/^\d{1,2} [A-Z][a-z]{2} \d{4} \d{1,2}:\d{2} · /gm) || []).length === 1, "still a single entry");
  check(d.includes(`${ukToday} 15:00 · Inbound · 1:31`), "durations added together");
  check(d.includes("Arbour Walk menu 1001 (0:56), then ext 102 (0:35)"), "route shows both legs");
  check(d.includes("Recording: https://example.com/rec.wav"), "the recording link is added");
  check(!d.includes("Sarah Jones"), "what was said is not");
  check(d.startsWith("New enquiry through Arbour Walk (queue 800)"), "opening lines kept");
});

// H2: a new call goes on top, and notes a person added stay where they were
await runTest("history: newest call first, and a person's notes are left alone", async () => {
  const existing = `New enquiry through Arbour Walk (queue 800)\n1 Sep 2026 at 09:00\n\n` +
    historyOf("1 Sep 2026 09:00 · Inbound · 2:00\nAnswered by ext 105") + "\n\nNotes: prefers a call in the morning";
  routes = historyRoutes(enquiryRecord(existing), [noRecentCall]);
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003HIST000000001AA")), env, ctx);
  await Promise.all(ctx.tasks);

  const d = appendedDescription();
  check(d.indexOf(`${ukToday} 15:00`) < d.indexOf("1 Sep 2026 09:00"), "today's call above the older one");
  check(d.endsWith("--- end of call history ---\n\nNotes: prefers a call in the morning"), "notes untouched below the history");
  check((d.match(/--- 3CX call history/g) || []).length === 1, "one history section");
});

// H3: when the field fills, the oldest calls go, never the notes
await runTest("history: oldest calls dropped to fit, notes kept", async () => {
  const old = Array.from({ length: 40 }, (_, i) =>
    `1 Aug 2026 ${String(i % 24).padStart(2, "0")}:00 · Inbound · 1:00\nAnswered by ext 105\nRecording: https://example.com/${"r".repeat(960)}`);
  const existing = historyOf(...old) + "\n\nNotes: keep this";
  routes = historyRoutes(enquiryRecord(existing), [noRecentCall]);
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003HIST000000001AA")), env, ctx);
  await Promise.all(ctx.tasks);

  const d = appendedDescription();
  check(d.length <= 30000, "within the Description limit");
  check(d.includes("Notes: keep this"), "notes kept");
  check(d.indexOf(`${ukToday} 15:00`) !== -1 && d.indexOf(`${ukToday} 15:00`) < d.indexOf("1 Aug 2026"), "newest call kept at the top");
  check((d.match(/1 Aug 2026/g) || []).length < 40, "oldest calls dropped");
});

// H4: a record from before the new format keeps its old text below the history
await runTest("history: older free-text descriptions are kept underneath", async () => {
  routes = historyRoutes(enquiryRecord("Spoke to the daughter last week."), [noRecentCall]);
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003HIST000000001AA")), env, ctx);
  await Promise.all(ctx.tasks);

  const d = appendedDescription();
  check(d.startsWith("--- 3CX call history, newest first ---"), "history starts the description");
  check(d.endsWith("Spoke to the daughter last week."), "existing text kept after it");
});

// H6: a menu leg adds to the history but raises no reminder of its own
await runTest("history: a menu leg raises no reminder", async () => {
  routes = historyRoutes(enquiryRecord(""), [noRecentCall]);
  const ctx = makeCtx();
  const menuLeg = "17/07/2026 15:00: Answered incoming call from 447911123456 to 1001 (00:00:56)\n\nTranscription: \n\nSummary: \n\nSentiment: \n\nRecording:";
  await worker.fetch(taskRequest(callTaskBody("003HIST000000001AA", menuLeg), { "X-Receptionist-Extensions": "10*" }), env, ctx);
  await Promise.all(ctx.tasks);
  check(appendedDescription().includes("menu 1001"), "menu leg recorded in the history");
  check(!alertTaskPost(), "no reminder raised for the menu");
});

// H5: a reminder lists its calls newest first
await runTest("history: reminder lists repeat calls newest first", async () => {
  routes = [
    tokenRoute,
    noRecentCall,
    { match: taskPost, reply: { json: { id: "00THIST00000000002A" }, status: 201 } },
    { match: byId, reply: { records: [enquiryRecord("")] } },
    { match: byTask, reply: { records: [{ Id: "00TREM0000000001AA", Description: "Caller: +447911123456\n\nCalls:\n1 Sep 2026 09:00 · Inbound · ext 105" }] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003HIST000000001AA")), env, ctx);
  await Promise.all(ctx.tasks);

  const reminder = taskPatches().find(p => p.url.includes("00TREM0000000001AA"))?.body.Description || "";
  check(reminder.indexOf(`${ukToday} 15:00 · Inbound · ext 102`) < reminder.indexOf("1 Sep 2026 09:00"), "today's call listed first");
});

// ── Tracked queues ──────────────────────────────────────────────────────
// Only calls answered through a tracked queue create a record for an unknown
// caller. 3CX cannot tell a lookup which queue a call is on, so the lookup
// returns a stand-in and the decision is made when the call is journaled.

const tracked = (over = {}) => ({ "X-Tracked-Queues": "800", ...over });
const standIn = "PENDING_CALLER_447911123456";
const queueLegDescription = inboundDescription.replace(" to 102 ", " to 800 ");

// Q1: unknown caller at ring time gets a stand-in, and nothing is created
await runTest("tracked queues: unknown caller gets a stand-in at ring time", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id,FirstName,LastName,Phone)", tracked()),
    env, makeCtx());
  const match = (await res.json()).searchRecords?.[0];
  check(match?.Id === standIn, "stand-in id carries the number");
  check(match?.FirstName === "New Caller", "agent sees a new caller");
  check(!/ to |Ext/.test(`${match?.FirstName} ${match?.LastName}`), "no direction text in the name");
  check(contactPosts().length === 0, "nothing created at ring time");
});

// Q2: an existing record is still found and returned at ring time
await runTest("tracked queues: existing record returned at ring time", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [ringTimeContact("003EXIST0000001AAA", "+447911123456")] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id)", tracked()), env, makeCtx());
  check((await res.json()).searchRecords?.[0]?.Id === "003EXIST0000001AAA", "real record returned");
});

// Q3: an outbound call to an unknown number gets nothing
await runTest("tracked queues: outbound to an unknown number stays empty", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id)", tracked({ "X-Call-Direction": "Outbound" })),
    env, makeCtx());
  check((await res.json()).searchRecords.length === 0, "no stand-in for outbound");
  check(contactPosts().length === 0, "nothing created");
});

// Q4: answered through a tracked queue, so the record is created and the call linked to it
await runTest("tracked queues: answered through a tracked queue creates the record", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [ringTimeContact("003NEW0000000001AA", "+447911123456")] } },
    { match: contactPost, reply: { json: { id: "003NEW0000000001AA" }, status: 201 } },
    { match: taskPost, reply: { json: { id: "00TCALL0000000030AA" }, status: 201 } },
    { match: byId, reply: { records: [ringTimeContact("003NEW0000000001AA", "+447911123456")] } },
    noRecentCall,
    { match: byTask, reply: { records: [] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  const res = await worker.fetch(
    taskRequest(callTaskBody(standIn), tracked({ "X-Queue-Extension": "800" })), env, ctx);
  await Promise.all(ctx.tasks);
  check(res.status === 201, "call logged");
  check(contactPosts().length === 1, "one record created");
  check(JSON.parse(contactPosts()[0].body).Phone === "+447911123456", "created with the E.164 number");
  check(forwardedCallTask()?.WhoId === "003NEW0000000001AA", "call linked to the new record, not the stand-in");
});

// Q5: a wildcard selects a family of queues
await runTest("tracked queues: wildcard selects a range of queues", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [ringTimeContact("003NEW0000000002AA", "+447911123456")] } },
    { match: contactPost, reply: { json: { id: "003NEW0000000002AA" }, status: 201 } },
    { match: taskPost, reply: { json: { id: "00TCALL0000000031AA" }, status: 201 } },
    { match: byId, reply: { records: [ringTimeContact("003NEW0000000002AA", "+447911123456")] } },
    noRecentCall, { match: byTask, reply: { records: [] } }, patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(
    taskRequest(callTaskBody(standIn), { "X-Tracked-Queues": "80*", "X-Queue-Extension": "801" }), env, ctx);
  await Promise.all(ctx.tasks);
  check(contactPosts().length === 1, "queue 801 matched by 80*");
});

// Q6: unknown caller on any other route, so nothing is created or logged
await runTest("tracked queues: unknown caller on another route is dropped", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [] } }
  ];
  const ctx = makeCtx();
  const res = await worker.fetch(
    taskRequest(callTaskBody(standIn), tracked({ "X-Queue-Extension": "[QueueExtension]" })), env, ctx);
  await Promise.all(ctx.tasks);
  const body = await res.json();
  check(res.status === 201 && body.success === true, "3CX told it succeeded, so it does not retry");
  check(body.filtered === "queue", "reported as a queue filter");
  check(contactPosts().length === 0, "no record created");
  check(!calls.some(taskPost), "no call log written");
});

// Q7: the leg for the queue itself (nobody answered yet) never creates a record
await runTest("tracked queues: unanswered queue leg does not create", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [] } }
  ];
  const ctx = makeCtx();
  const res = await worker.fetch(
    taskRequest(callTaskBody(standIn, queueLegDescription), tracked({ "X-Queue-Extension": "800" })), env, ctx);
  await Promise.all(ctx.tasks);
  check((await res.json()).filtered === "queue", "abandoned or diverted enquiry dropped");
  check(contactPosts().length === 0, "no record created");
});

// Q8: existing record on another route is logged while Always Log is on (the default)
await runTest("tracked queues: existing record logged on any route by default", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA"), tracked()), env, ctx);
  await Promise.all(ctx.tasks);
  check(!!forwardedCallTask(), "call logged against the existing record");
});

// Q9: Always Log off, so an existing record on another route is dropped
await runTest("tracked queues: always-log off drops untracked calls for existing records", async () => {
  routes = [tokenRoute, noRecentCall];
  const ctx = makeCtx();
  const res = await worker.fetch(
    taskRequest(callTaskBody("003RING00000001AAA"), tracked({ "X-Log-Existing-Always": "False" })), env, ctx);
  await Promise.all(ctx.tasks);
  check((await res.json()).filtered === "queue", "dropped");
  check(!calls.some(taskPost), "no call log written");
});

// Q10: Always Log off, but an existing record through a tracked queue is still logged
await runTest("tracked queues: always-log off still logs tracked calls", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA"),
    tracked({ "X-Log-Existing-Always": "False", "X-Queue-Extension": "800" })), env, ctx);
  await Promise.all(ctx.tasks);
  check(!!forwardedCallTask(), "tracked call logged");
});

// Q11: Always Log off, but a transfer out of a tracked call is kept and merged
await runTest("tracked queues: always-log off keeps a transferred leg of a tracked call", async () => {
  routes = [
    tokenRoute,
    { match: recentCallQuery, reply: { records: [{ Id: "00TPRIOR0000000001A", Description: "first leg", CallDurationInSeconds: 30 }] } },
    { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
    { match: byTask, reply: { records: [] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  const res = await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA"),
    tracked({ "X-Log-Existing-Always": "False" })), env, ctx);
  await Promise.all(ctx.tasks);
  check((await res.json()).merged === true, "leg merged into the tracked call");
  check(taskPatches().some(p => p.url.includes("00TPRIOR0000000001A")), "prior call log updated");
});

// Q12: Salesforce failing on a tracked call logs it unlinked, never loses it
await runTest("tracked queues: Salesforce failure logs a tracked call unlinked", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { status: 500, json: [{ errorCode: "SERVER_UNAVAILABLE" }] } },
    { match: byPhone, reply: { status: 500, json: [{ errorCode: "SERVER_UNAVAILABLE" }] } },
    { match: taskPost, reply: { json: { id: "00TCALL0000000032AA" }, status: 201 } }
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody(standIn), tracked({ "X-Queue-Extension": "800" })), env, ctx);
  await Promise.all(ctx.tasks);
  check(contactPosts().length === 0, "nothing created blind");
  check(forwardedCallTask() && !("WhoId" in forwardedCallTask()), "call log kept, unlinked");
});

// Q13: lead mode, the live configuration, creates a Lead
await runTest("tracked queues: lead mode creates a Lead", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    noBusinessContact,
    { match: byAccountPhone, reply: { records: [] } },
    { match: byLeadPhone, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [openLead("00QNEW0000000001AA", "+447911123456")] } },
    { match: leadPost, reply: { json: { id: "00QNEW0000000001AA" }, status: 201 } },
    { match: taskPost, reply: { json: { id: "00TCALL0000000033AA" }, status: 201 } },
    { match: byLeadId, reply: { records: [openLead("00QNEW0000000001AA", "+447911123456")] } },
    noRecentCall, { match: byTask, reply: { records: [] } }, patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody(standIn), tracked({ "X-Queue-Extension": "800" })), leadEnv, ctx);
  await Promise.all(ctx.tasks);
  check(calls.filter(leadPost).length === 1, "one Lead created");
  check(!("Company" in JSON.parse(calls.find(leadPost).body)), "Company left blank so it converts to a Person Account");
  check(forwardedCallTask()?.WhoId === "00QNEW0000000001AA", "call linked to the Lead");
});

// Q13b: a blank Tracked Queues list that 3CX omits must not revert to creating for everyone
await runTest("tracked queues: a blank list creates nothing, rather than reverting to old behaviour", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id)", { "X-Log-Existing-Always": "True" }),
    env, makeCtx());
  check((await res.json()).searchRecords.length === 0, "no stand-in while no queue is tracked");
  check(contactPosts().length === 0, "no ring-time record");
});

// Q13c: a receptionist leg that carries the queue is not someone answering
await runTest("tracked queues: receptionist leg never counts as answered, even with the queue on it", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [] } }
  ];
  const ctx = makeCtx();
  const receptionistLeg = inboundDescription.replace(" to 102 ", " to 1001 ");
  const res = await worker.fetch(taskRequest(callTaskBody(standIn, receptionistLeg),
    tracked({ "X-Queue-Extension": "800", "X-Receptionist-Extensions": "1001" })), env, ctx);
  await Promise.all(ctx.tasks);
  check((await res.json()).filtered === "queue", "receptionist leg dropped");
  check(contactPosts().length === 0, "no Lead for a caller who pressed 1 and hung up");
});

// Q14: the CRM link for a stand-in opens the object list, not a missing record
await runTest("tracked queues: stand-in CRM link opens the object list", async () => {
  routes = [tokenRoute];
  const res = await worker.fetch(new Request(`https://worker.example/${standIn}`), leadEnv, makeCtx());
  check(res.status === 302 && res.headers.get("Location").endsWith("/lightning/o/Lead/home"), "redirects to Leads");
});

// ── Excluded extensions ─────────────────────────────────────────────────

// E1: an excluded extension's call never reaches Salesforce
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

// E4: an exclusion beats Tracked Queues, so no record is created
await runTest("excluded ext: wins over a tracked queue, nothing created", async () => {
  routes = [tokenRoute];
  const ctx = makeCtx();
  const res = await worker.fetch(taskRequest(callTaskBody("PENDING_CALLER_447911123456"),
    { "X-Tracked-Queues": "800", "X-Queue-Extension": "800", "X-Excluded-Extensions": "102" }), env, ctx);
  await Promise.all(ctx.tasks);
  check((await res.json()).filtered === "extension", "dropped as excluded");
  check(!calls.some(contactPost), "no record created");
  check(!calls.some(taskPost), "no call log written");
});

// E5: a whole queue can be excluded by its extension
await runTest("excluded ext: excluding a queue drops calls through it", async () => {
  routes = [tokenRoute];
  const ctx = makeCtx();
  const res = await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA"),
    { "X-Queue-Extension": "850", "X-Excluded-Extensions": "850" }), env, ctx);
  await Promise.all(ctx.tasks);
  check((await res.json()).filtered === "extension", "call through queue 850 dropped");
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

// ── Closed review gaps ──────────────────────────────────────────────────
// One test per gap found in the September 2026 review, so none can reopen.

const header = (text) => `17/07/2026 15:00: ${text}`;
// Forwarded URLs keep 3CX's own encoding, so match on the decoded query.
const urlHas = (r, text) => decodeURIComponent(r.url.replace(/\+/g, "%20")).includes(text);

// G1: words spoken on the call cannot change which extension the privacy rules use
await runTest("gaps: transcript cannot pose as the call header", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  const description = header("Answered outgoing call from 300 to 447911123456 (00:00:35)") +
    "\n\nTranscription: she read out Answered incoming call from 447000000000 to 102 (00:00:10) to me" +
    "\n\nSummary: resident health discussed\n\nSentiment: Neutral\n\nRecording: https://example.com/r.wav";
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", description),
    { "X-Confidential-Extensions": "300" }), env, ctx);
  await Promise.all(ctx.tasks);
  const logged = forwardedCallTask()?.Description || "";
  check(logged.includes("Content withheld"), "confidential rule applied to the real extension");
  check(!logged.includes("resident health"), "nothing said on the call reaches Salesforce");
});

// G2: redaction keeps only the header line when the section headings are missing
await runTest("gaps: confidential redaction fails closed without headings", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  const description = header("Answered incoming call from 447911123456 to 102 (00:00:35)") +
    "\nthe caller discussed a resident's medication";
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", description),
    { "X-Confidential-Extensions": "102" }), env, ctx);
  await Promise.all(ctx.tasks);
  check(!(forwardedCallTask()?.Description || "").includes("medication"), "unlabelled content removed");
});

// G3: a heading spoken inside the transcript is not taken as the real section
await runTest("gaps: spoken section heading does not leak the transcript", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  const description = header("Answered incoming call from 447911123456 to 102 (00:00:35)") +
    "\n\nTranscription: hello\nSummary: private words from the caller" +
    "\n\nSummary: Real summary\n\nSentiment: Neutral\n\nRecording: https://example.com/r.wav";
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", description),
    { "X-Transcript-Policy": "Metadata only" }), env, ctx);
  await Promise.all(ctx.tasks);
  const logged = forwardedCallTask()?.Description || "";
  check(logged.includes("Summary: Real summary"), "the real summary is kept");
  check(!logged.includes("private words"), "the transcript stays withheld");
});

// G4: an unanswered outbound call to a stamped record is still read as unanswered
await runTest("gaps: unanswered outbound to a stamped name keeps its direction", async () => {
  routes = [tokenRoute];
  const description = header("Unanswered outgoing call from 102 to 447911123456 Unregistered Contact +447911123456 (Inbound 15:04, Ext 102)");
  const res = await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", description),
    { "X-Journal-Unanswered": "False" }), env, makeCtx());
  check((await res.json()).filtered === "direction", "dropped by the Unanswered switch");
});

// G5: 3CX's [Agent] header wins over the extension parsed from text
await runTest("gaps: [Agent] header decides the extension", async () => {
  routes = [tokenRoute];
  const res = await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA"),
    { "X-Agent-Extension": "300", "X-Excluded-Extensions": "300" }), env, makeCtx());
  check((await res.json()).filtered === "extension", "excluded on the header's extension");
});

// G6: the passthrough forwards the template's reads and nothing else
await runTest("gaps: passthrough forwards queries only", async () => {
  routes = [tokenRoute, { match: r => r.method === "GET" && urlHas(r, "from User"), reply: { records: [{ Id: "005xx0000012345AAA" }] } }];
  const ok = await worker.fetch(new Request(
    `https://worker.example/services/data/v55.0/query/?q=${encodeURIComponent("SELECT Id from User where Email = 'a@b.com' AND IsActive = true LIMIT 1")}`,
    { headers: { "X-Proxy-API-Key": "secret" } }), env, makeCtx());
  check(ok.status === 200 && (await ok.json()).records.length === 1, "ReportCall's user query forwarded");

  calls = [];
  const del = await worker.fetch(new Request("https://worker.example/services/data/v55.0/sobjects/Contact/003RING00000001AAA",
    { method: "DELETE", headers: { "X-Proxy-API-Key": "secret" } }), env, makeCtx());
  check(del.status === 403, "DELETE refused");
  const composite = await worker.fetch(new Request("https://worker.example/services/data/v55.0/composite",
    { method: "POST", headers: { "X-Proxy-API-Key": "secret" }, body: "{}" }), env, makeCtx());
  check(composite.status === 403, "other APIs refused");
  check(!calls.some(c => c.url.startsWith(SF)), "nothing refused reached Salesforce");
});

// G7: a path starting "//" cannot send the Salesforce token to another host
await runTest("gaps: double-slash path cannot change the target host", async () => {
  routes = [tokenRoute];
  await worker.fetch(new Request(
    `https://worker.example//evil.example/services/data/v55.0/query/?q=${encodeURIComponent("SELECT Id FROM Contact LIMIT 1")}`,
    { headers: { "X-Proxy-API-Key": "secret" } }), env, makeCtx());
  check(!calls.some(c => /^https?:\/\/evil\.example/.test(c.url)), "no request to another host");
});

// G8: a wrong key is refused, not just a missing one
await runTest("gaps: wrong proxy key refused", async () => {
  routes = [tokenRoute];
  const res = await worker.fetch(new Request("https://worker.example/services/data/v55.0/query/?q=x",
    { headers: { "X-Proxy-API-Key": "not-the-key" } }), env, makeCtx());
  check(res.status === 401, "401 for a wrong key");
});

// G9: an empty Lead search does not hide Contacts for the same term
await runTest("gaps: type-ahead cache is per query, not per term", async () => {
  routes = [
    tokenRoute,
    { match: r => urlHas(r, "FROM Lead"), reply: { records: [] } },
    { match: r => urlHas(r, "FROM Contact"), reply: { records: [{ Id: "003ZQX0000000001AA" }] } }
  ];
  const ask = (object) => worker.fetch(new Request(
    `https://worker.example/services/data/v55.0/query/?q=${encodeURIComponent(`SELECT Id FROM ${object} WHERE LastName LIKE '%zqxw%' LIMIT 20`)}`,
    { headers: { "X-Proxy-API-Key": "secret" } }), env, makeCtx());
  await ask("Lead");
  const contacts = await (await ask("Contact")).json();
  check(contacts.records.length === 1, "Contact results still returned");
});

// G11: a maintenance write Salesforce rejects raises the failure alert
await runTest("gaps: rejected maintenance write raises an alert", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: (r, hits) => ({ json: { id: `00TGAP00000000${hits}AA` }, status: 201 }) },
    { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
    noRecentCall,
    { match: r => r.method === "GET" && r.url.includes("3CX+Integration+Error"), reply: { records: [] } },
    { match: byTask, reply: { records: [] } },
    { match: r => r.method === "PATCH" && r.url.includes("/sobjects/Contact/"), reply: { status: 400, json: [{ errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION" }] } },
    patch204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")), env, ctx);
  await Promise.all(ctx.tasks);
  check(!!failureTaskPost(), "error task raised for the rejected write");
  check(calls.filter(c => c.method === "PATCH").every(c => c.headers.get("Sforce-Auto-Assign") === "FALSE"),
    "updates never re-run assignment rules");
});

// G12: a transcript over Salesforce's limit is trimmed, not lost
await runTest("gaps: oversized call log is trimmed to fit", async () => {
  routes = maintenanceRoutes();
  const ctx = makeCtx();
  const description = header("Answered incoming call from 447911123456 to 102 (01:00:00)") +
    `\n\nTranscription: ${"words ".repeat(8000)}\n\nSummary: s\n\nSentiment: n\n\nRecording: r`;
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA", description)), env, ctx);
  await Promise.all(ctx.tasks);
  const logged = forwardedCallTask()?.Description || "";
  check(logged.length <= 30000, "within the Description limit");
  check(logged.startsWith("17/07/2026 15:00"), "call details kept");
});

// G13: a call log Salesforce refuses for its link is saved unlinked
await runTest("gaps: refused link retries the call log unlinked", async () => {
  routes = [
    tokenRoute,
    noRecentCall,
    { match: taskPost, reply: (r, hits) => hits === 1
        ? { status: 400, json: [{ errorCode: "INVALID_CROSS_REFERENCE_KEY" }] }
        : { json: { id: "00TGAP0000000013AA" }, status: 201 } }
  ];
  const ctx = makeCtx();
  const res = await worker.fetch(taskRequest(callTaskBody("003GONE0000000001AA")), env, ctx);
  await Promise.all(ctx.tasks);
  const posts = callLogPostsOf(calls);
  check(res.status === 201, "3CX sees the call saved");
  check(posts.length === 2 && !("WhoId" in posts[1]), "second attempt carried no link");
  const alert = integrationAlerts().find(a => a.Subject === "3CX Integration Error: call saved without its caller's record");
  check(!!alert && !alert.WhoId, "staff told in Salesforce, on an unlinked Task");
  check(alert?.OwnerId === "005xx0000012345AAA", "owned by whoever took the call");
  check((alert?.Description || "").includes("+447911123456") && alert.Description.includes("003GONE0000000001AA"),
    "with the caller's number and the record it was meant for");
});

// G14: a non-JSON call log is refused rather than forwarded unfiltered
await runTest("gaps: non-JSON call log refused", async () => {
  routes = [tokenRoute];
  const res = await worker.fetch(new Request("https://worker.example/services/data/v55.0/sobjects/task",
    { method: "POST", headers: { "X-Proxy-API-Key": "secret" }, body: "not json" }), env, makeCtx());
  check(res.status === 400, "400");
  check(!calls.some(taskPost), "nothing forwarded");
});

// G15: a converted Lead holding the key sends the call to what it became
await runTest("gaps: converted Lead routes the call to its converted record", async () => {
  const leadKeyEnv = { ...leadEnv, SALESFORCE_EXTERNAL_ID_FIELD: "Phone_E164__c" };
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byAccountPhone, reply: { records: [] } },
    { match: byLeadPhone, reply: { records: [] } },
    noBusinessContact,
    { match: r => r.method === "GET" && r.url.includes("/sobjects/Lead/Phone_E164__c/"), reply: { Id: "00QCONV000000001AA" } },
    { match: r => r.method === "GET" && r.url.includes("FROM+Lead+WHERE+Phone_E164__c"),
      reply: { records: [{ Id: "00QCONV000000001AA", IsConverted: true, ConvertedContactId: "003CONV000000001AA" }] } },
    { match: taskPost, reply: { json: { id: "00TGAP0000000015AA" }, status: 201 } },
    { match: byAccountContactId, reply: { records: [personAccount("001CONV000000001AA", "003CONV000000001AA", "+447911123456", { FirstName: "Jean", LastName: "Smith" })] } },
    noRecentCall, { match: byTask, reply: { records: [] } }, patch204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody(standIn), tracked({ "X-Queue-Extension": "800" })), leadKeyEnv, ctx);
  await Promise.all(ctx.tasks);
  check(!calls.some(leadPost), "no second Lead attempted");
  check(forwardedCallTask()?.WhoId === "003CONV000000001AA", "call linked to the converted record");
});

// G16: a professional already on file as a business Contact is not raised as an enquiry
await runTest("gaps: business Contact matched before creating a Lead", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byAccountPhone, reply: { records: [] } },
    { match: byLeadPhone, reply: { records: [] } },
    { match: byBusinessContact, reply: { records: [{ Id: "003BIZ0000000001AA", FirstName: "Jo", LastName: "Social" }] } },
    { match: taskPost, reply: { json: { id: "00TGAP0000000016AA" }, status: 201 } },
    { match: byAccountContactId, reply: { records: [] } },
    { match: byId, reply: { records: [{ Id: "003BIZ0000000001AA", FirstName: "Jo", LastName: "Social", IsPersonAccount: false }] } },
    noRecentCall, { match: byTask, reply: { records: [] } }, patch204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody(standIn), tracked({ "X-Queue-Extension": "800" })), leadEnv, ctx);
  await Promise.all(ctx.tasks);
  check(!calls.some(leadPost), "no Lead created");
  check(forwardedCallTask()?.WhoId === "003BIZ0000000001AA", "call linked to the Contact");
});

// G17: a duplicate rule blocking the insert adopts the record it matched
await runTest("gaps: duplicate-rule block adopts the existing record", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [ringTimeContact("003DUP0000000001AA", "+447911123456")] } },
    { match: contactPost, reply: { status: 400, json: [{ errorCode: "DUPLICATES_DETECTED" }] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id)"), env, makeCtx());
  check((await res.json()).searchRecords?.[0]?.Id === "003DUP0000000001AA", "existing record used");
});

// G18: a new enquiry is named after the home, from the 3CX department
await runTest("gaps: enquiry named home first from 3CX departments", async () => {
  const pbxEnv = { ...env, THREECX_URL: "https://pbx.example", THREECX_CLIENT_ID: "900", THREECX_CLIENT_SECRET: "s" };
  const pbx = p => r => r.url.startsWith(`https://pbx.example${p}`);
  routes = [
    tokenRoute,
    { match: pbx("/connect/token"), reply: { access_token: "pbx" } },
    { match: pbx("/xapi/v1/Groups"), reply: { value: [{ Id: 1, Name: "DEFAULT", IsDefault: true }, { Id: 7, Name: "Arbour Walk", IsDefault: false }] } },
    { match: pbx("/xapi/v1/Users"), reply: { value: [{ Number: "102", Groups: [{ GroupId: 1 }, { GroupId: 7 }] }] } },
    { match: pbx("/xapi/v1/Queues"), reply: { value: [{ Number: "800", Groups: [{ GroupId: 7 }] }] } },
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "003HOME000000001AA", FirstName: "Arbour Walk", LastName: "Enquiry +447911123456 (17 Jul 15:00)" }] } },
    { match: contactPost, reply: { json: { id: "003HOME000000001AA" }, status: 201 } },
    { match: taskPost, reply: { json: { id: "00TGAP0000000018AA" }, status: 201 } },
    { match: byId, reply: { records: [{ Id: "003HOME000000001AA", FirstName: "Arbour Walk", LastName: "Enquiry +447911123456 (17 Jul 15:00)", Phone: "+447911123456" }] } },
    noRecentCall, { match: byTask, reply: { records: [] } }, patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody(standIn), tracked({ "X-Queue-Extension": "800" })), pbxEnv, ctx);
  await Promise.all(ctx.tasks);
  const created = JSON.parse(contactPosts()[0]?.body || "{}");
  check(created.FirstName === "Arbour Walk", "first name is the home");
  check((created.Description || "").startsWith("New enquiry through Arbour Walk (queue 800)\n"), "description opens with where the enquiry came in");
  check(/^Enquiry \+447911123456 \(\d{1,2} [A-Z][a-z]{2} 15:00\)$/.test(created.LastName || ""), `last name is Enquiry, the number and the call time (got ${created.LastName})`);
  check(!!alertTaskPost(), "still unregistered, so a reminder is raised");
  check(!contactPatches().some(p => p.body.LastName), "not renamed after creation");
});

// G19: a rename Salesforce refuses does not stop the append or the reminder
await runTest("gaps: refused rename still appends the call and raises the reminder", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: (r, hits) => ({ json: { id: `00TGAP0000000019A${hits}` }, status: 201 }) },
    { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
    noRecentCall,
    { match: r => r.method === "GET" && r.url.includes("3CX+Integration+Error"), reply: { records: [] } },
    { match: byTask, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "00TGAP0000000019AA" }] } },
    { match: r => r.method === "PATCH" && r.url.includes("/sobjects/Contact/") && (r.body || "").includes("LastName"),
      reply: { status: 400, json: [{ errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION" }] } },
    patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")), env, ctx);
  await Promise.all(ctx.tasks);
  check(contactPatches().some(p => p.body.Description), "call still appended to the record");
  check(!!alertTaskPost(), "reminder still raised");
  check(!!failureTaskPost(), "the refused rename is reported");
});

// G20: a converted Lead is found on a call that may not create a record
await runTest("gaps: converted Lead found on an untracked missed call", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byAccountPhone, reply: { records: [] } },
    { match: r => r.method === "GET" && urlHas(r, "IsConverted = true"),
      reply: { records: [{ Id: "00QOLD0000000001AA", ConvertedContactId: "003CONV000000002AA" }] } },
    { match: byLeadPhone, reply: { records: [] } },
    noBusinessContact,
    { match: taskPost, reply: { json: { id: "00TGAP0000000020AA" }, status: 201 } },
    { match: byAccountContactId, reply: { records: [personAccount("001CONV000000002AA", "003CONV000000002AA", "+447911123456", { FirstName: "Jean", LastName: "Smith" })] } },
    noRecentCall, { match: byTask, reply: { records: [] } }, patch204
  ];
  const ctx = makeCtx();
  const missed = header("Missed call from 447911123456 to 102");
  await worker.fetch(taskRequest(callTaskBody(standIn, missed), tracked()), leadEnv, ctx);
  await Promise.all(ctx.tasks);
  check(forwardedCallTask()?.WhoId === "003CONV000000002AA", "logged against the converted record");
  check(!calls.some(leadPost), "nothing created");
});

// G21: an older template honours Excluded Extensions at ring time too
await runTest("gaps: pre-v46 lookup creates nothing for an excluded extension", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { records: [] } }
  ];
  const res = await worker.fetch(lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id)",
    { "X-Agent-Extension": "999", "X-Excluded-Extensions": "999" }), env, makeCtx());
  check((await res.json()).searchRecords.length === 0, "lookup stays empty");
  check(contactPosts().length === 0, "no record created");
});

// ── Aligned with Cedar Care's Salesforce answers ────────────────────────
// Care home on the Lead for assignment, an owner when 3CX finds no user, the
// words of a call kept to the call log for retention, the My Domain login,
// and duplicate rules set to Allow not refusing API inserts.

const homeEnv = { ...leadEnv, EXTENSION_DEPARTMENTS: '{"800":"Arbour Walk","102":"Arbour Walk"}' };
const openIntegrationAlert = r => r.method === "GET" && r.url.includes("FROM+Task") && urlHas(r, "3CX Integration Error:");
const hook = r => r.url.startsWith("https://hooks.example/");
const webhookTexts = () => calls.filter(hook).map(c => JSON.parse(c.body).text || "");
const leadPosts = () => calls.filter(leadPost).map(c => ({ body: JSON.parse(c.body), headers: c.headers }));
const callLogPosts = () => calls.filter(taskPost).map(c => JSON.parse(c.body)).filter(b => b.Subject === "3CX PhoneSystem Call");
const enquiryLead = { Id: "00QHOME000000001AA", FirstName: "Arbour Walk", LastName: "Enquiry +447911123456 (17 Jul 15:00)", Phone: "+447911123456" };

// Lead-mode routes for an enquiry answered through queue 800. leadReply
// decides how the Lead insert is answered.
const enquiryRoutes = (leadReply, extra = []) => [
  tokenRoute,
  ...extra,
  { match: hook, reply: { ok: true } },
  { match: byAccountPhone, reply: { records: [] } },
  { match: byLeadPhone, reply: (r, hits) => hits % 2 === 1 ? { records: [] } : { records: [enquiryLead] } },
  noBusinessContact,
  { match: leadPost, reply: leadReply },
  { match: taskPost, reply: { json: { id: "00TALIGN000000001A" }, status: 201 } },
  { match: byLeadId, reply: { records: [enquiryLead] } },
  { match: openIntegrationAlert, reply: { records: [] } },
  noRecentCall, { match: byTask, reply: { records: [] } }, patch204, delete204
];
const created201 = { json: { id: "00QHOME000000001AA" }, status: 201 };
const enquiryCall = () => taskRequest(callTaskBody(standIn), tracked({ "X-Queue-Extension": "800" }));

// A1: the home goes onto the Lead, where its assignment rule can see it
await runTest("aligned: care home stamped on the Lead at creation", async () => {
  routes = enquiryRoutes(created201);
  const ctx = makeCtx();
  await worker.fetch(enquiryCall(), { ...homeEnv, SALESFORCE_HOME_FIELD: "Care_Home__c" }, ctx);
  await Promise.all(ctx.tasks);
  const [insert] = leadPosts();
  check(insert?.body.Care_Home__c === "Arbour Walk", `Care_Home__c is the 3CX department (got "${insert?.body.Care_Home__c}")`);
  check(insert?.body.FirstName === "Arbour Walk", "still named after the home");
  check(forwardedCallTask()?.WhoId === "00QHOME000000001AA", "call linked to the new Lead");
});

// A2: a duplicate rule set to Allow does not refuse the insert; only record inserts say so
await runTest("aligned: record inserts allow saves past Allow duplicate rules", async () => {
  routes = enquiryRoutes(created201);
  const ctx = makeCtx();
  await worker.fetch(enquiryCall(), homeEnv, ctx);
  await Promise.all(ctx.tasks);
  check(leadPosts()[0]?.headers.get("Sforce-Duplicate-Rule-Header") === "allowSave=true", "Lead insert carries allowSave=true");
  check(!calls.filter(taskPost).some(c => c.headers.get("Sforce-Duplicate-Rule-Header")), "Task inserts do not");
  check(!calls.filter(c => c.method === "PATCH").some(c => c.headers.get("Sforce-Duplicate-Rule-Header")), "updates do not");
  check(!("Care_Home__c" in (leadPosts()[0]?.body || {})), "no home field unless one is configured");
});

// A3: a map translates department names into the field's own values
await runTest("aligned: SALESFORCE_HOME_VALUES maps departments to picklist values", async () => {
  routes = enquiryRoutes(created201);
  let ctx = makeCtx();
  await worker.fetch(enquiryCall(), { ...homeEnv, SALESFORCE_HOME_FIELD: "Care_Home__c",
    SALESFORCE_HOME_VALUES: '{"arbour walk":"Arbour Walk Care Home"}' }, ctx);
  await Promise.all(ctx.tasks);
  check(leadPosts()[0]?.body.Care_Home__c === "Arbour Walk Care Home", "mapped value used, matched regardless of case");

  calls = [];
  routes = enquiryRoutes(created201);
  ctx = makeCtx();
  await worker.fetch(enquiryCall(), { ...homeEnv, SALESFORCE_HOME_FIELD: "Care_Home__c",
    SALESFORCE_HOME_VALUES: '{"Oakhill":"Oakhill House"}' }, ctx);
  await Promise.all(ctx.tasks);
  check(leadPosts().length === 1 && leadPosts()[0].body.Care_Home__c === "Arbour Walk",
    "a home the map does not list is sent as 3CX names it");
});

// A4: a value the picklist will not take costs the field, never the Lead
await runTest("aligned: refused care home value retried without it and reported", async () => {
  routes = enquiryRoutes(r => JSON.parse(r.body).Care_Home__c
    ? { status: 400, json: [{ message: "bad value for restricted picklist field: Arbour Walk", errorCode: "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", fields: ["Care_Home__c"] }] }
    : created201);
  const ctx = makeCtx();
  const res = await worker.fetch(enquiryCall(), { ...homeEnv, SALESFORCE_HOME_FIELD: "Care_Home__c",
    SALESFORCE_EXTRA_FIELDS: '{"Lead":{"LeadSource":"Phone Enquiry"}}', ALERT_WEBHOOK_URL: "https://hooks.example/alert" }, ctx);
  await Promise.all(ctx.tasks);
  const posts = leadPosts();
  check(res.status === 201, "call logged");
  check(posts.length === 2, `retried once (got ${posts.length} inserts)`);
  check(posts[1] && !("Care_Home__c" in posts[1].body), "retry leaves the refused field out");
  check(posts[1]?.body.LeadSource === "Phone Enquiry", "and keeps the fields that were fine");
  check(forwardedCallTask()?.WhoId === "00QHOME000000001AA", "the enquiry still has its Lead");
  check(webhookTexts().some(t => t.includes("Care_Home__c")), "the refusal reaches the integration's own reports");
  const missing = integrationAlerts().find(a => a.Subject === "3CX Integration Error: new enquiry is missing details");
  check(missing?.WhoId === "00QHOME000000001AA", "staff told on the Lead itself");
  check(missing?.OwnerId === "005xx0000012345AAA", "owned by whoever took the call");
  check((missing?.Description || "").includes('Care home (Care_Home__c) not set') && missing.Description.includes('"Arbour Walk"'),
    "saying which field and value, in words staff can act on");

  // The next enquiry from the same home does not offer the refused value again.
  calls = [];
  routes = enquiryRoutes(r => JSON.parse(r.body).Care_Home__c
    ? { status: 400, json: [{ message: "bad value for restricted picklist field: Arbour Walk", errorCode: "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", fields: ["Care_Home__c"] }] }
    : created201);
  const ctx2 = makeCtx();
  await worker.fetch(enquiryCall(), { ...homeEnv, SALESFORCE_HOME_FIELD: "Care_Home__c",
    SALESFORCE_EXTRA_FIELDS: '{"Lead":{"LeadSource":"Phone Enquiry"}}', ALERT_WEBHOOK_URL: "https://hooks.example/alert" }, ctx2);
  await Promise.all(ctx2.tasks);
  check(leadPosts().length === 1 && !("Care_Home__c" in leadPosts()[0].body), "refused value not sent again");
  check(!webhookTexts().some(t => t.includes("Salesforce refused")), "the integration's report is not repeated");
  check(integrationAlerts().some(a => a.Subject === "3CX Integration Error: new enquiry is missing details" && a.WhoId === "00QHOME000000001AA"),
    "but staff are still told on this Lead, since it needs the home setting too");
});

// A5: a refused Lead Source value (not added to the picklist yet) is handled the same way
await runTest("aligned: refused Lead Source retried without it", async () => {
  routes = enquiryRoutes(r => JSON.parse(r.body).LeadSource
    ? { status: 400, json: [{ message: "bad value for restricted picklist field: Phone Enquiry", errorCode: "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", fields: ["LeadSource"] }] }
    : created201);
  const ctx = makeCtx();
  await worker.fetch(enquiryCall(), { ...homeEnv, SALESFORCE_HOME_FIELD: "Home_Site__c",
    SALESFORCE_EXTRA_FIELDS: '{"Lead":{"LeadSource":"Phone Enquiry"}}' }, ctx);
  await Promise.all(ctx.tasks);
  const posts = leadPosts();
  check(posts.length === 2 && !("LeadSource" in posts[1].body), "Lead Source left out of the retry");
  check(posts[1]?.body.Home_Site__c === "Arbour Walk", "care home kept");
});

// A5b: only the refusal's own code and fields count, not a trigger's failure that mentions the field
await runTest("aligned: a deeper failure naming the home field does not drop it", async () => {
  routes = enquiryRoutes({ status: 400, json: [{
    errorCode: "CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY",
    message: "LeadTrigger: execution of AfterInsert caused by: System.QueryException: No such column 'Home_Nested__c' on entity 'Lead'",
    fields: []
  }] });
  const ctx = makeCtx();
  await worker.fetch(enquiryCall(), { ...homeEnv, SALESFORCE_HOME_FIELD: "Home_Nested__c" }, ctx);
  await Promise.all(ctx.tasks);
  check(leadPosts().length === 1, "not retried: the Lead itself was refused");

  calls = [];
  routes = enquiryRoutes(created201);
  const ctx2 = makeCtx();
  await worker.fetch(enquiryCall(), { ...homeEnv, SALESFORCE_HOME_FIELD: "Home_Nested__c" }, ctx2);
  await Promise.all(ctx2.tasks);
  check(leadPosts()[0]?.body.Home_Nested__c === "Arbour Walk", "and the field is still sent next time");
});

// A5c: a lookup field given a name rather than an id costs the field
await runTest("aligned: MALFORMED_ID on the home field retried without it", async () => {
  routes = enquiryRoutes(r => JSON.parse(r.body).Home_Lookup__c
    ? { status: 400, json: [{ errorCode: "MALFORMED_ID", message: "Care Home: id value of incorrect type: Arbour Walk", fields: ["Home_Lookup__c"] }] }
    : created201);
  const ctx = makeCtx();
  await worker.fetch(enquiryCall(), { ...homeEnv, SALESFORCE_HOME_FIELD: "Home_Lookup__c" }, ctx);
  await Promise.all(ctx.tasks);
  check(leadPosts().length === 2 && !("Home_Lookup__c" in leadPosts()[1].body), "retried without the lookup");
  check(forwardedCallTask()?.WhoId === "00QHOME000000001AA", "the enquiry still has its Lead");
});

// A5d: a value refusal that names no field sets every optional field aside
await runTest("aligned: JSON_PARSER_ERROR retries without the optional fields", async () => {
  routes = enquiryRoutes(r => JSON.parse(r.body).Home_Parsed__c
    ? { status: 400, json: [{ errorCode: "JSON_PARSER_ERROR", message: "Cannot deserialize instance of boolean from VALUE_STRING value Arbour Walk at [line:1, column:120]" }] }
    : created201);
  const ctx = makeCtx();
  await worker.fetch(enquiryCall(), { ...homeEnv, SALESFORCE_HOME_FIELD: "Home_Parsed__c" }, ctx);
  await Promise.all(ctx.tasks);
  const posts = leadPosts();
  check(posts.length === 2 && !("Home_Parsed__c" in posts[1].body), "retried without it");
  check(posts[1]?.body.FirstName === "Arbour Walk" && posts[1]?.body.Phone === "+447911123456", "core fields untouched");
});

// A5e: a refused field is reported even when the insert still fails afterwards
await runTest("aligned: a field set aside is reported even if the retry fails", async () => {
  routes = enquiryRoutes(r => JSON.parse(r.body).Home_Hidden__c
    ? { status: 400, json: [{ errorCode: "INVALID_FIELD_FOR_INSERT_UPDATE", message: "Unable to create/update fields: Home_Hidden__c. Please check the security settings of this field.", fields: ["Home_Hidden__c"] }] }
    : { status: 400, json: [{ errorCode: "UNABLE_TO_LOCK_ROW", message: "unable to obtain exclusive access to this record" }] });
  const ctx = makeCtx();
  await worker.fetch(enquiryCall(), { ...homeEnv, SALESFORCE_HOME_FIELD: "Home_Hidden__c", ALERT_WEBHOOK_URL: "https://hooks.example/alert" }, ctx);
  await Promise.all(ctx.tasks);
  check(webhookTexts().some(t => t.includes("Home_Hidden__c")), "the unwritable field is reported");
  check(!forwardedCallTask()?.WhoId, "the enquiry itself still logged unlinked");
  const unlinked = integrationAlerts().find(a => a.Subject === "3CX Integration Error: enquiry call saved without a record");
  check((unlinked?.Description || "").includes("Home_Hidden__c") && unlinked.Description.includes("Edit access"),
    "staff alert explains the field problem as well");
});

// A6: a field the org has not built is left off every later insert
await runTest("aligned: a missing home field is set aside after one refusal", async () => {
  const missing = r => JSON.parse(r.body).Home_Not_Built__c
    ? { status: 400, json: [{ message: "No such column 'Home_Not_Built__c' on sobject of type Lead", errorCode: "INVALID_FIELD" }] }
    : created201;
  const missingEnv = { ...homeEnv, SALESFORCE_HOME_FIELD: "Home_Not_Built__c" };
  routes = enquiryRoutes(missing);
  let ctx = makeCtx();
  await worker.fetch(enquiryCall(), missingEnv, ctx);
  await Promise.all(ctx.tasks);
  check(leadPosts().length === 2, "first enquiry: refused, then created without it");

  calls = [];
  routes = enquiryRoutes(missing);
  ctx = makeCtx();
  await worker.fetch(enquiryCall(), missingEnv, ctx);
  await Promise.all(ctx.tasks);
  check(leadPosts().length === 1 && !("Home_Not_Built__c" in leadPosts()[0].body), "next enquiry does not send it at all");
  check(!integrationAlerts().some(a => a.Subject === "3CX Integration Error: new enquiry is missing details"),
    "and staff are not told again on every Lead about a field only an admin can fix");
});

// A7: 3CX found no Salesforce user, so the call log, and its reminder, go to the fallback owner
await runTest("aligned: fallback owner when 3CX finds no user", async () => {
  const userQuery = r => r.method === "GET" && r.url.includes("FROM+User");
  routes = maintenanceRoutes([{ match: userQuery, reply: { records: [{ Id: "005FALLBACK0001AAA" }] } }]);
  const body = callTaskBody("003RING00000001AAA");
  delete body.OwnerId;
  const ctx = makeCtx();
  await worker.fetch(taskRequest(body), { ...env, SALESFORCE_FALLBACK_OWNER: "005FALLBACK0001AAA" }, ctx);
  await Promise.all(ctx.tasks);
  check(forwardedCallTask()?.OwnerId === "005FALLBACK0001AAA", "call log owned by the fallback owner");
  check(alertTaskPost()?.OwnerId === "005FALLBACK0001AAA", "reminder follows it");
  check(calls.some(c => userQuery(c) && urlHas(c, "IsActive = true") && urlHas(c, "UserType = 'Standard'")),
    "fallback checked to be an active user who can own Tasks");

  calls = [];
  routes = maintenanceRoutes([{ match: userQuery, reply: { records: [{ Id: "005FALLBACK0001AAA" }] } }]);
  const ctx2 = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")), { ...env, SALESFORCE_FALLBACK_OWNER: "005FALLBACK0001AAA" }, ctx2);
  await Promise.all(ctx2.tasks);
  check(forwardedCallTask()?.OwnerId === "005xx0000012345AAA", "the user 3CX found is kept");
  check(!calls.some(userQuery), "no owner lookup needed");
});

// A8: the fallback can be a queue that takes Tasks, named by its API name
await runTest("aligned: fallback owner can be a Task queue", async () => {
  const queueQuery = r => r.method === "GET" && r.url.includes("FROM+QueueSobject");
  routes = maintenanceRoutes([{ match: queueQuery, reply: { records: [{ QueueId: "00GPLACEMENT001AAA" }] } }]);
  const body = callTaskBody("003RING00000001AAA");
  delete body.OwnerId;
  const ctx = makeCtx();
  await worker.fetch(taskRequest(body), { ...env, SALESFORCE_FALLBACK_OWNER: "Central_Placement_Team" }, ctx);
  await Promise.all(ctx.tasks);
  check(forwardedCallTask()?.OwnerId === "00GPLACEMENT001AAA", "call log owned by the queue");
  check(calls.some(c => queueQuery(c) && urlHas(c, "SobjectType = 'Task'")), "queue checked to take Tasks");
});

// A9: an inactive fallback owner is not used
await runTest("aligned: inactive fallback owner is set aside", async () => {
  routes = maintenanceRoutes([{ match: r => r.method === "GET" && r.url.includes("FROM+User"), reply: { records: [] } }]);
  const body = callTaskBody("003RING00000001AAA");
  delete body.OwnerId;
  const ctx = makeCtx();
  const res = await worker.fetch(taskRequest(body), { ...env, SALESFORCE_FALLBACK_OWNER: "005INACTIVE00001AA" }, ctx);
  await Promise.all(ctx.tasks);
  check(res.status === 201, "call logged");
  check(!("OwnerId" in (forwardedCallTask() || {})), "left with the integration user");
});

// A10: a fallback owner refused at insert costs the owner, not the call log or its link
await runTest("aligned: refused fallback owner retried without it", async () => {
  routes = [
    tokenRoute,
    { match: r => r.method === "GET" && r.url.includes("FROM+User"), reply: { records: [{ Id: "005REFUSED00001AAA" }] } },
    { match: taskPost, reply: r => JSON.parse(r.body).OwnerId === "005REFUSED00001AAA"
      ? { status: 400, json: [{ message: "operation performed with inactive user", errorCode: "INACTIVE_OWNER_OR_USER", fields: ["OwnerId"] }] }
      : { json: { id: "00TREFUSED0000001A" }, status: 201 } },
    { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
    noRecentCall, { match: byTask, reply: { records: [] } }, patch204, delete204
  ];
  const body = callTaskBody("003RING00000001AAA");
  delete body.OwnerId;
  const ctx = makeCtx();
  const res = await worker.fetch(taskRequest(body), { ...env, SALESFORCE_FALLBACK_OWNER: "005REFUSED00001AAA" }, ctx);
  await Promise.all(ctx.tasks);
  const logs = callLogPosts();
  check(res.status === 201, "call logged");
  check(logs.length === 2 && !("OwnerId" in logs[1]), "retried without the owner");
  check(logs[1]?.WhoId === "003RING00000001AAA", "and still linked to the record");

  // Set aside: the next call neither re-checks it nor offers it again.
  calls = [];
  const again = callTaskBody("003RING00000001AAA");
  delete again.OwnerId;
  const ctx2 = makeCtx();
  await worker.fetch(taskRequest(again), { ...env, SALESFORCE_FALLBACK_OWNER: "005REFUSED00001AAA" }, ctx2);
  await Promise.all(ctx2.tasks);
  check(callLogPosts().length === 1 && !("OwnerId" in callLogPosts()[0]), "refused owner not offered again");
  check(!calls.some(r => r.method === "GET" && r.url.includes("FROM+User")), "nor checked again within the hour");
});

// A10b: 3CX's user refused as an owner, so the fallback owner takes the call log
await runTest("aligned: refused 3CX owner replaced by the fallback owner", async () => {
  routes = [
    tokenRoute,
    { match: r => r.method === "GET" && r.url.includes("FROM+User"), reply: { records: [{ Id: "005FALLBACK0002AAA" }] } },
    { match: taskPost, reply: r => JSON.parse(r.body).OwnerId === "005xx0000012345AAA"
      ? { status: 400, json: [{ message: "invalid cross reference id", errorCode: "INVALID_CROSS_REFERENCE_KEY", fields: ["OwnerId"] }] }
      : { json: { id: "00TOWNER00000001AA" }, status: 201 } },
    { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
    noRecentCall, { match: byTask, reply: { records: [] } }, patch204, delete204
  ];
  const ctx = makeCtx();
  const res = await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")),
    { ...env, SALESFORCE_FALLBACK_OWNER: "005FALLBACK0002AAA" }, ctx);
  await Promise.all(ctx.tasks);
  const logs = callLogPosts();
  check(res.status === 201, "call logged");
  check(logs.length === 2 && logs[1].OwnerId === "005FALLBACK0002AAA", "retried with the fallback owner");
  check(logs[1]?.WhoId === "003RING00000001AAA", "still linked");
  check(alertTaskPost()?.OwnerId === "005FALLBACK0002AAA", "reminder follows the owner the call log got");
});

// A10c: a reminder whose owner is refused is still raised
await runTest("aligned: refused reminder owner costs the owner, not the reminder", async () => {
  routes = [
    tokenRoute,
    { match: taskPost, reply: r => {
      const b = JSON.parse(r.body);
      return (b.Subject || "").startsWith("Action Required") && b.OwnerId
        ? { status: 400, json: [{ message: "owner is inactive", errorCode: "INACTIVE_OWNER_OR_USER", fields: ["OwnerId"] }] }
        : { json: { id: "00TREMIND0000001AA" }, status: 201 };
    } },
    { match: byId, reply: { records: [ringTimeContact("003RING00000001AAA", "+447911123456")] } },
    noRecentCall, { match: byTask, reply: { records: [] } }, patch204, delete204
  ];
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003RING00000001AAA")), env, ctx);
  await Promise.all(ctx.tasks);
  const reminders = calls.filter(taskPost).map(c => JSON.parse(c.body)).filter(b => (b.Subject || "").startsWith("Action Required"));
  check(reminders.length === 2 && !("OwnerId" in reminders[1]), "reminder saved again without the owner");
  check(!calls.filter(taskPost).some(c => (JSON.parse(c.body).Subject || "").startsWith("3CX Integration Error")), "no failure alert needed");
});

// A11: words from calls already in a record's history go the next time it is written
await runTest("aligned: transcripts already in a history are removed on the next call", async () => {
  const existing = historyOf(
    "1 Sep 2026 09:00 · Inbound · 2:00\nAnswered by ext 105\n" +
    'Possible caller name mentioned: "Jane Doe" (unverified, from call transcription)\n' +
    "Transcript: my mother needs nursing care\nand she lives alone\nSummary: Asked about nursing care.\nSentiment: Positive\n" +
    "Recording: https://example.com/old.wav") + "\n\nNotes: Transcript: typed by a person";
  routes = historyRoutes(enquiryRecord(existing), [noRecentCall]);
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003HIST000000001AA")), env, ctx);
  await Promise.all(ctx.tasks);
  const d = appendedDescription();
  check(!/mother|lives alone|nursing care|Jane Doe|Sentiment/.test(d.split("--- end of call history ---")[0]), "old transcript, summary, sentiment and name removed");
  check(d.includes("1 Sep 2026 09:00 · Inbound · 2:00\nAnswered by ext 105\nRecording: https://example.com/old.wav"), "old entry keeps when, who and the recording");
  check(d.endsWith("Notes: Transcript: typed by a person"), "a person's notes outside the history untouched");
});

// A11b: CRLF line endings do not cost an entry its recording link
await runTest("aligned: recording links survive CRLF descriptions", async () => {
  const existing = historyOf("1 Sep 2026 09:00 · Inbound · 2:00\r\nAnswered by ext 105\r\nTranscript: words\r\nRecording: https://example.com/crlf.wav");
  routes = historyRoutes(enquiryRecord(existing), [noRecentCall]);
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003HIST000000001AA")), env, ctx);
  await Promise.all(ctx.tasks);
  const d = appendedDescription();
  check(d.includes("Answered by ext 105\nRecording: https://example.com/crlf.wav"), "recording kept");
  check(!d.includes("Transcript: words"), "transcript still removed");
});

// A11c: a record someone has named gets no new entries, but loses old transcripts
await runTest("aligned: a named record's history is cut back too", async () => {
  const named = {
    Id: "003REG0000000002AA", FirstName: "Jane", LastName: "Smith", Phone: "+447911123456",
    Description: historyOf("1 Sep 2026 09:00 · Inbound · 2:00\nAnswered by ext 105\nTranscript: private words\nRecording: https://example.com/reg.wav") +
      "\n\nNotes: keep"
  };
  routes = historyRoutes(named, [noRecentCall]);
  const ctx = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003REG0000000002AA")), env, ctx);
  await Promise.all(ctx.tasks);
  const d = appendedDescription();
  check(d && !d.includes("private words"), "transcript removed");
  check(d.includes("Recording: https://example.com/reg.wav") && d.endsWith("Notes: keep"), "recording and notes kept");
  check(!d.includes(`${ukToday} 15:00`), "no new entry on a named record");

  calls = [];
  routes = historyRoutes({ ...named, Description: historyOf("1 Sep 2026 09:00 · Inbound · 2:00\nAnswered by ext 105") }, [noRecentCall]);
  const ctx2 = makeCtx();
  await worker.fetch(taskRequest(callTaskBody("003REG0000000002AA")), env, ctx2);
  await Promise.all(ctx2.tasks);
  check(contactPatches().length === 0, "a clean history is left alone");
});

// A12: an enquiry that could not be given a record says so, without the whole number
await runTest("aligned: tracked enquiry with no record raises an alert", async () => {
  routes = [
    tokenRoute,
    { match: hook, reply: { ok: true } },
    { match: byAccountPhone, reply: { status: 500, json: [{ errorCode: "SERVER_ERROR" }] } },
    { match: taskPost, reply: { json: { id: "00TUNLINKED000001A" }, status: 201 } }
  ];
  const ctx = makeCtx();
  await worker.fetch(enquiryCall(), { ...homeEnv, ALERT_WEBHOOK_URL: "https://hooks.example/alert" }, ctx);
  await Promise.all(ctx.tasks);
  check(forwardedCallTask() && !forwardedCallTask().WhoId, "call log saved unlinked");
  const text = webhookTexts().join("\n");
  check(text.includes("could not be given a Salesforce record"), "alert raised");
  check(text.includes("queue 800") && !text.includes("7911123456"), "names the queue, masks the number");

  const alert = integrationAlerts().find(a => a.Subject === "3CX Integration Error: enquiry call saved without a record");
  check(!!alert && !alert.WhoId, "staff alert raised in Salesforce on its own");
  check(alert?.OwnerId === "005xx0000012345AAA", "owned by whoever took the call");
  const d = alert?.Description || "";
  check(d.includes("Caller: +447911123456") && d.includes("Arbour Walk queue 800") && d.includes("ext 102"),
    "with the whole number, the home, the queue and the extension, since it stays inside Salesforce");
  check(d.includes("find or create their record, and link the call log to it"), "and what to do");
});

// A12a: staff alerts go to the fallback owner when 3CX found no user
await runTest("aligned: staff alert follows the fallback owner", async () => {
  routes = [
    tokenRoute,
    { match: r => r.method === "GET" && r.url.includes("FROM+User"), reply: { records: [{ Id: "005FALLBACK0003AAA" }] } },
    { match: byAccountPhone, reply: { status: 500, json: [{ errorCode: "SERVER_ERROR" }] } },
    { match: taskPost, reply: { json: { id: "00TUNLINKED000002A" }, status: 201 } }
  ];
  const body = callTaskBody(standIn);
  delete body.OwnerId;
  const ctx = makeCtx();
  await worker.fetch(taskRequest(body, tracked({ "X-Queue-Extension": "800" })),
    { ...homeEnv, SALESFORCE_FALLBACK_OWNER: "005FALLBACK0003AAA" }, ctx);
  await Promise.all(ctx.tasks);
  check(integrationAlerts()[0]?.OwnerId === "005FALLBACK0003AAA", "alert owned by the fallback owner");
});

// A12b: that alert is not sent when the call log was not saved either
await runTest("aligned: no 'saved unlinked' alert when the call log also failed", async () => {
  routes = [
    tokenRoute,
    { match: hook, reply: { ok: true } },
    { match: byAccountPhone, reply: { status: 500, json: [{ errorCode: "SERVER_ERROR" }] } },
    { match: taskPost, reply: { status: 500, json: [{ errorCode: "SERVER_ERROR" }] } }
  ];
  const ctx = makeCtx();
  await worker.fetch(enquiryCall(), { ...homeEnv, ALERT_WEBHOOK_URL: "https://hooks.example/alert" }, ctx);
  await Promise.all(ctx.tasks);
  const texts = webhookTexts();
  check(!texts.some(t => t.includes("was saved without one")), "does not claim the call log was saved");
  check(texts.some(t => t.includes("call log not saved")), "reports that it was not");
  check(!integrationAlerts().some(a => a.Subject === "3CX Integration Error: enquiry call saved without a record"),
    "no staff alert claiming it was saved");
  check(integrationAlerts().some(a => a.Subject === "3CX Integration Error: call could not be saved" &&
    (a.Description || "").includes("+447911123456")), "a 'could not be saved' alert is attempted in Salesforce");
});

// A13: the login URL must be the org's My Domain
await runTest("aligned: generic Salesforce login hosts refused", async () => {
  routes = [tokenRoute];
  const res = await worker.fetch(lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id)"),
    { ...env, SALESFORCE_LOGIN_URL: "https://login.salesforce.com" }, makeCtx());
  check(res.status === 502, "request refused");
  check(calls.length === 0, "nothing sent to Salesforce");

  calls = [];
  const lightning = await worker.fetch(lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id)"),
    { ...env, SALESFORCE_LOGIN_URL: "https://cedarcarehomes.lightning.force.com" }, makeCtx());
  check(lightning.status === 502 && calls.length === 0, "the Lightning address copied from a browser is refused too");

  const link = await worker.fetch(new Request("https://worker.example/003RING00000001AAA"),
    { ...env, SALESFORCE_LOGIN_URL: "https://login.example.com/" }, makeCtx());
  check(link.headers.get("Location") === "https://login.example.com/003RING00000001AAA", "a trailing slash does not double up in record links");
});

// ── Surviving a Salesforce that refuses things ──────────────────────────
// The September 2026 outage: one field the integration user could not read
// failed the 3CX lookup, the Worker handed 3CX the error, and 3CX never
// journaled anything. No Leads, no call logs, no transcripts, for every call.

// X1: a refused lookup is answered as "nobody matched", so journaling carries on
await runTest("outage: a refused 3CX lookup never reaches 3CX", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { status: 400, json: [{ message: "No such column 'AssistantPhone' on entity 'Contact'.", errorCode: "INVALID_FIELD" }] } },
    { match: byPhone, reply: { records: [] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id,AssistantPhone)", tracked()), env, makeCtx());
  check(res.status === 200, `3CX sees a normal answer, not the error (got ${res.status})`);
  const match = (await res.json()).searchRecords?.[0];
  check(match?.Id === standIn, "and an unknown caller still gets a stand-in, so the call is still journaled");
});

// X2: a field the user cannot read is dropped from the query rather than failing it
await runTest("outage: an unreadable field is dropped from the lookup query", async () => {
  const personAccountQuery = r => r.method === "GET" && r.url.includes("FROM+Account+WHERE+IsPersonAccount");
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: personAccountQuery, reply: r => urlHas(r, "PersonOtherPhone")
      ? { status: 400, json: [{ message: "No such column 'PersonOtherPhone' on entity 'Account'.", errorCode: "INVALID_FIELD" }] }
      : { records: [personAccount("001BLK0000000001AA", "003BLK0000000001AA", "+447911123456")] } },
    noBusinessContact
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id)"), paEnv, makeCtx());
  check((await res.json()).searchRecords?.[0]?.Id === "003BLK0000000001AA", "the caller is still found, on the fields that remain");
  const queries = calls.filter(personAccountQuery);
  check(queries.length === 2, `refused once, then asked again without it (got ${queries.length} tries)`);
  check(!urlHas(queries[1], "PersonOtherPhone"), "second try leaves the unreadable field out");

  // Remembered, so the next caller does not pay for it again.
  calls = [];
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: personAccountQuery, reply: { records: [personAccount("001BLK0000000002AA", "003BLK0000000002AA", "+447911123457")] } },
    noBusinessContact
  ];
  await worker.fetch(lookupRequest("FIND {07911123457} IN PHONE FIELDS RETURNING Contact(Id)"), paEnv, makeCtx());
  const next = calls.filter(personAccountQuery);
  check(next.length === 1 && !urlHas(next[0], "PersonOtherPhone"), "asked once, already without it");
});

// X2b: a user who cannot write Description still gets the enquiry its record
await runTest("outage: an unwritable Description costs the text, not the Lead", async () => {
  routes = enquiryRoutes(r => JSON.parse(r.body).Description
    ? { status: 400, json: [{ errorCode: "INVALID_FIELD_FOR_INSERT_UPDATE", message: "Unable to create/update fields: Description. Please check the security settings of this field.", fields: ["Description"] }] }
    : created201);
  const ctx = makeCtx();
  await worker.fetch(enquiryCall(), homeEnv, ctx);
  await Promise.all(ctx.tasks);
  const posts = leadPosts();
  check(posts.length === 2 && !("Description" in posts[1].body), "retried without the description");
  check(posts[1]?.body.FirstName === "Arbour Walk" && posts[1]?.body.Phone === "+447911123456", "the enquiry keeps its name and number");
  check(forwardedCallTask()?.WhoId === "00QHOME000000001AA", "and the call is linked to it");
});

// X3: a refusal it cannot narrow is still reported as a failure, not as "no such caller"
await runTest("outage: an unexplained refusal is still a failure", async () => {
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: byPhone, reply: { status: 500, json: [{ errorCode: "SERVER_ERROR" }] } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id)"), env, makeCtx());
  check((await res.json()).searchRecords.length === 0, "no match invented");
  check(contactPosts().length === 0, "and nothing created on a failed query");
});

// G10 (last, since it sets the External ID aside for the rest of the run):
// a missing or hidden key field degrades to phone matching instead of stopping creation
await runTest("gaps: broken External ID field falls back to phone matching", async () => {
  const brokenKeyEnv = { ...env, SALESFORCE_EXTERNAL_ID_FIELD: "Phone_E164__c" };
  routes = [
    tokenRoute,
    { match: sfSearch, reply: { searchRecords: [] } },
    { match: r => r.method === "GET" && r.url.includes("Phone_E164__c"),
      reply: { status: 400, json: [{ errorCode: "INVALID_FIELD", message: "No such column 'Phone_E164__c' on entity 'Contact'." }] } },
    { match: byPhone, reply: (r, hits) => hits === 1 ? { records: [] } : { records: [{ Id: "003KEY0000000001AA", Phone: "+447911123456" }] } },
    { match: contactPost, reply: { json: { id: "003KEY0000000001AA" }, status: 201 } }
  ];
  const res = await worker.fetch(
    lookupRequest("FIND {07911123456} IN PHONE FIELDS RETURNING Contact(Id)"), brokenKeyEnv, makeCtx());
  check((await res.json()).searchRecords?.[0]?.Id === "003KEY0000000001AA", "record still created and returned");
  check(!JSON.parse(contactPosts()[0]?.body || "{}").Phone_E164__c, "created without the unusable field");
});

// ═════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} checks passed, ${failed} failed`);
globalThis.fetch = realFetch;
process.exit(failed === 0 ? 0 : 1);
