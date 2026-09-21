/**
 * 3CX Salesforce Integration Proxy with Client Credentials Flow
 *
 * Intercepts lookups and call journaling from 3CX to Salesforce.
 * Authenticates with Salesforce using OAuth 2.0 Client Credentials Flow.
 * Creates a record for an enquiry answered through a tracked queue, logs calls
 * for callers already on file, and never creates duplicates.
 *
 * Tracked queues (template v46):
 *  - Only calls answered through a listed queue create a record for an
 *    unknown caller. The lookup cannot see the queue, so it returns a
 *    per-number stand-in and the record is created when the call is
 *    journaled. See trackedQueueGate and applyTrackedQueueGate. Callers who
 *    already have a record are logged whatever the route unless the Always
 *    Log toggle is off. The ring-time creation below applies to older
 *    templates.
 *
 * Ring-time contact creation:
 *  - When an unknown number calls (or is called) and the auto-create policy
 *    allows it, the worker creates the REAL Salesforce contact during the
 *    lookup and returns it to 3CX. The agent therefore sees a genuine CRM
 *    match whose (CRM) link opens the actual record, editable mid-call.
 *  - At call end, 3CX journals the task against that real contact id. The
 *    worker then maintains the contact in the background: adds the call to
 *    its history (what was said stays on the call log), stamps the name, and
 *    upserts the "Action Required" reminder task.
 *
 * Duplicate protection strategy:
 *  - Contact dedup uses a real-time SOQL exact match on the normalized E.164
 *    phone number. SOSL FIND is index-based and can lag new records by
 *    minutes, so it is only used as a fallback to catch manually created
 *    contacts with formatted numbers ("+44 7911 123456").
 *  - After creating a contact the worker re-queries and keeps only the
 *    oldest record for that number, so two simultaneous calls converge on a
 *    single contact.
 *  - The "Action Required" reminder task is upserted: while the contact is
 *    still unregistered, repeat calls update the existing open task instead
 *    of stacking a new one. Once the contact has real details, leftover
 *    reminders are auto-completed.
 *  - If Salesforce lookups fail transiently, the worker returns empty
 *    results / forwards the call log untouched rather than blindly creating
 *    a (possibly duplicate) contact. The next successful call heals things.
 */

import { parsePhoneNumberFromString, getCountryCallingCode } from "libphonenumber-js";

const SF_API_PATH = "/services/data/v55.0";
// With the enquiry queue gate on, an unknown caller is answered with a
// per-number stand-in rather than a new record, because 3CX cannot tell the
// lookup which queue the call is on. See pendingCallerMatch.
const PENDING_PREFIX = "PENDING_CALLER_";
const PENDING_FIRST_NAME = "New Caller";
const ALERT_SUBJECT_PREFIX = "Action Required:";
// Alerts for Cedar Care's own staff, raised as Salesforce Tasks for whoever
// took the call. Deliberately a different prefix from the caller reminders
// above, so the reminder upsert never overwrites an error alert and the
// auto-close never silently clears one. One prefix for all of them, so a
// list view or retention job finds every kind.
const INTEGRATION_ERROR_PREFIX = "3CX Integration Error:";
const FAILURE_SUBJECT = `${INTEGRATION_ERROR_PREFIX} call details could not be saved automatically`;
const MISSING_DETAILS_SUBJECT = `${INTEGRATION_ERROR_PREFIX} new enquiry is missing details`;
const UNLINKED_ENQUIRY_SUBJECT = `${INTEGRATION_ERROR_PREFIX} enquiry call saved without a record`;
const UNLINKED_CALL_SUBJECT = `${INTEGRATION_ERROR_PREFIX} call saved without its caller's record`;
const NOT_SAVED_SUBJECT = `${INTEGRATION_ERROR_PREFIX} call could not be saved`;
const SF_TEXT_LIMIT = 30000; // Description fields hard-cap at 32,000 chars
const DEFAULT_FIRST_NAME = "Unregistered Contact";

// Salesforce key prefixes — the first three characters of every record id
const PREFIX_CONTACT = "003";
const PREFIX_LEAD = "00Q";

// Memory cache for Salesforce credentials
let cachedToken = null;
let cachedInstanceUrl = null;
let tokenExpiry = 0;

// The run-as user's id, read from the token response. Lets the Worker tell
// the tasks it created from ones people logged by hand.
let cachedUserId = null;

// Memory cache for the org's person-account record type
let cachedPersonRecordTypeId = null;

// Set when Salesforce reports SALESFORCE_EXTERNAL_ID_FIELD missing or hidden.
// Matching then falls back to the phone fields for the life of the isolate,
// rather than every lookup failing and nothing being created.
let externalIdDisabled = false;

// Optional fields ("Lead.Care_Home__c") Salesforce reported missing or not
// writable by the integration user, and values it refused for one
// ('Lead.Care_Home__c="Oakhill"'). Left off every later insert for the life
// of the isolate, so a field the org has not built, or a home the picklist
// spells differently, costs one refused insert and one report, not one per
// enquiry.
const unusableFields = new Set();
const refusedValues = new Set();
const REFUSED_VALUES_MAX = 200;

// Reports raised while a request is handled. They start at once and are kept
// alive with ctx.waitUntil when the response goes, so a slow webhook never
// holds up 3CX.
const pendingReports = [];

// The fallback owner, checked against Salesforce at most hourly.
let fallbackOwnerCache = { setting: "", id: null, expiry: 0 };
const FALLBACK_OWNER_MS = 60 * 60_000;
const FALLBACK_OWNER_RETRY_MS = 5 * 60_000;

// Negative cache for 3CX's search-as-you-type. Keyed by the query's shape and
// the search term, valued by expiry. See isKnownEmptySearch for why this is safe.
const emptySearchTerms = new Map();
const NEGATIVE_CACHE_MS = 60_000;
const NEGATIVE_CACHE_MAX = 500;

/**
 * True when this search is guaranteed to return nothing because a SHORTER
 * term already did in the same query.
 *
 * 3CX searches with LIKE '%term%'. If nothing contains "101", then nothing
 * can contain "1015" either — any record matching the longer term would
 * necessarily match the shorter one. So once a term comes back empty, every
 * term that extends it can be answered locally without asking Salesforce.
 *
 * That only holds within one query. 3CX sends a separate query per object
 * (Contacts, Leads, Accounts), and a term that finds no Lead can still find a
 * Contact, so each query shape is cached on its own.
 *
 * Entries expire quickly, and any record the Worker creates clears the cache.
 */
function isKnownEmptySearch(shape, term) {
  const now = Date.now();
  for (const [key, expiry] of emptySearchTerms) {
    if (expiry < now) {
      emptySearchTerms.delete(key);
      continue;
    }
    const [cachedShape, cachedTerm] = JSON.parse(key);
    if (cachedShape === shape && term.includes(cachedTerm)) return true;
  }
  return false;
}

function rememberEmptySearch(shape, term) {
  // Bound memory — the isolate is long-lived and terms are unbounded.
  if (emptySearchTerms.size >= NEGATIVE_CACHE_MAX) emptySearchTerms.clear();
  emptySearchTerms.set(JSON.stringify([shape, term]), Date.now() + NEGATIVE_CACHE_MS);
}

/** The query with its search term taken out, so each object's query caches separately. */
function searchShape(q, term) {
  return q.split(`%${term}%`).join("%?%");
}

/**
 * Which Salesforce data model this org uses. Set SALESFORCE_ORG_MODEL in the
 * Cloudflare dashboard:
 *
 *   "contact"       → standard Contact records (default, original behaviour)
 *   "personaccount" → Person Accounts (Account rows with IsPersonAccount)
 *   "lead"          → Lead-first: unknown callers become Leads, and once a
 *                     Lead is converted, later calls match the Person Account
 */
function orgModel(env) {
  const model = (env.SALESFORCE_ORG_MODEL || "contact").trim().toLowerCase();
  return ["contact", "personaccount", "lead", "none"].includes(model) ? model : "contact";
}

/** False when the template has switched record creation off altogether. */
function creationAllowed(env) {
  return orgModel(env) !== "none";
}

/**
 * Whether this object type keeps a call history in its Description. The
 * template decides it per record type, so an org can keep the history on
 * enquiry Leads while leaving converted Person Accounts clean. Contacts
 * follow the deployed behaviour, which is to keep it.
 */
function keepsHistory(env, objectType) {
  const off = String(env.SALESFORCE_HISTORY_OFF || "").split(",").map(v => v.trim()).filter(Boolean);
  return !off.includes(objectType);
}

/**
 * The template's per-call switches, folded into env so everything downstream
 * sees them without being passed the headers:
 *
 *   New Enquiries Create Leads / Create Person Accounts → SALESFORCE_ORG_MODEL
 *   Keep Call History On Leads / On Person Accounts     → SALESFORCE_HISTORY_OFF
 *
 * Person Accounts win when both are on, and with both off nothing is created
 * at all, though callers already on file are still logged. A template that
 * sends none of them leaves the deployed settings exactly as they are.
 */
function envForRequest(env, headers) {
  const flag = (name) => {
    const raw = headers && headers.get ? headers.get(name) : null;
    const value = (raw || "").trim();
    // 3CX sends the placeholder itself when a setting is not substituted.
    if (!value || value.startsWith("[")) return null;
    return !/^false$/i.test(value);
  };

  const leads = flag("X-Create-Leads");
  const personAccounts = flag("X-Create-Person-Accounts");
  const overrides = {};
  if (leads !== null || personAccounts !== null) {
    overrides.SALESFORCE_ORG_MODEL = personAccounts ? "personaccount" : (leads ? "lead" : "none");
  }

  const historyOff = [];
  if (flag("X-Append-History-Lead") === false) historyOff.push("Lead");
  if (flag("X-Append-History-Account") === false) historyOff.push("Account");
  if (historyOff.length > 0) overrides.SALESFORCE_HISTORY_OFF = historyOff.join(",");

  if (flag("X-Diagnostics") === true) overrides.SALESFORCE_DIAGNOSTICS = "true";
  if (flag("X-Raise-Reminders") === false) overrides.SALESFORCE_REMINDERS_OFF = "true";

  const days = (headers && headers.get ? headers.get("X-Log-Retention-Days") : "") || "";
  if (days.trim() && !days.trim().startsWith("[")) overrides.SALESFORCE_LOG_DAYS = days.trim();

  const request = Object.keys(overrides).length > 0 ? { ...env, ...overrides } : { ...env };
  // Somewhere for this request's diagnostic lines to collect, when they are
  // being kept. Per request, never shared between them.
  if (logRetentionDays(request) > 0) request.__log = [];
  return request;
}

/**
 * Diagnostic logging, switched on per PBX from the template while something is
 * being chased, and off again afterwards. It says what the Worker was told and
 * what it decided, which is the part that is otherwise invisible: settings a
 * template upload may have cleared, the queue and extension on the leg, and
 * why a call led to nothing.
 *
 * Numbers are masked and nothing said on a call is ever logged, so it stays
 * safe to leave on.
 */
function diagnosticsOn(env) {
  return /^true$/i.test(String(env.SALESFORCE_DIAGNOSTICS || "").trim());
}

/** True when the template has switched the "Action Required" reminders off. */
function remindersOff(env) {
  return /^true$/i.test(String(env.SALESFORCE_REMINDERS_OFF || "").trim());
}

/**
 * Answered calls shorter than the template's minimum never reach Salesforce:
 * wrong numbers and immediate hang-ups otherwise fill a record's history.
 * Missed calls are exempt, since their length is zero by definition.
 */
function tooShortToLog(headers, call, taskBody) {
  const minimum = Number((headers.get("X-Min-Call-Seconds") || "0").trim());
  if (!Number.isFinite(minimum) || minimum <= 0) return false;
  if (/Missed|Unanswered/.test(call.direction || "")) return false;

  const seconds = Number(taskBody.CallDurationInSeconds);
  const length = Number.isFinite(seconds) && seconds > 0 ? seconds : durationSeconds(call.duration);
  return length !== null && length < minimum;
}

/** The call log without its recording link, for orgs that keep recordings in 3CX alone. */
function withoutRecording(description) {
  const text = String(description || "").replace(/\r\n?/g, "\n");
  const headings = [...text.matchAll(/(^|\n)[ \t]*Recording:[ \t]*/gi)];
  if (headings.length === 0) return description;

  // The last heading, matching how every other reader of a call log treats
  // these sections, so nothing said on the call can cut it short.
  const last = headings[headings.length - 1];
  return text.slice(0, last.index).trimEnd();
}

function diag(env, message) {
  if (diagnosticsOn(env)) console.log(`[diagnostics] ${message}`);
  // Kept for the downloadable log as well, whether or not it goes to the
  // Worker's own logs, since the two are switched on separately.
  if (env.__log) env.__log.push(`${new Date().toISOString()} ${message}`);
}

/**
 * How long the template asks for diagnostic entries to be kept, in days.
 * 0, the default, stores nothing at all. Capped at 30: this is for chasing
 * something, not an archive, and every entry costs a write.
 */
function logRetentionDays(env) {
  const days = Number(String(env.SALESFORCE_LOG_DAYS || "0").trim());
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.min(Math.round(days), 30);
}

/** Writes this request's diagnostic lines to the log store, if one is bound. */
async function storeDiagnosticLog(env) {
  const lines = env.__log;
  if (!lines || lines.length === 0) return;

  const days = logRetentionDays(env);
  if (days === 0) return;
  if (!env.DIAGNOSTIC_LOGS) {
    console.error("Keep Diagnostic Logs is set in the 3CX template, but no log store is bound to this Worker.");
    return;
  }

  try {
    // Keyed so the newest sort first, since that is what a download wants.
    const countdown = String(9999999999999 - Date.now()).padStart(13, "0");
    await env.DIAGNOSTIC_LOGS.put(`log:${countdown}:${crypto.randomUUID().slice(0, 8)}`,
      lines.join("\n"), { expirationTtl: days * 86400 });
  } catch (e) {
    console.error("Could not store the diagnostic log entry:", e.message);
  }
}

/**
 * The stored entries as a plain text file, newest first. Behind the same
 * proxy key as everything else, so it is fetched with a command rather than
 * a browser link: a key in a URL ends up in history, bookmarks and logs.
 */
// Where the template's log download key is kept, so a browser request can be
// checked against it. The Worker is stateless, and only learns the key when
// 3CX sends it on a call.
const DOWNLOAD_KEY_RECORD = "config:log-download-key";
let downloadKeyWrittenAt = 0;
const DOWNLOAD_KEY_REFRESH_MS = 10 * 60_000;

/**
 * Notes the template's current log download key, at most every ten minutes.
 * Changing it in 3CX therefore takes effect on the next call, not instantly.
 */
/**
 * A key that survives being typed into a browser's address bar. Anything from
 * a "#" onwards is a fragment the browser keeps to itself, so a key with one
 * in it arrives empty; "%" starts an escape; "&", "+", "?" and spaces all mean
 * something else in a query string.
 */
function browserSafeKey(key) {
  return /^[A-Za-z0-9._~-]{6,}$/.test(key);
}

async function rememberDownloadKey(env, headers) {
  const key = (headers && headers.get ? headers.get("X-Log-Download-Key") : "") || "";
  const value = key.trim();
  if (!value || value.startsWith("[") || !env.DIAGNOSTIC_LOGS) return;
  if (Date.now() - downloadKeyWrittenAt < DOWNLOAD_KEY_REFRESH_MS) return;

  if (!browserSafeKey(value)) {
    console.error("The log download key set in the 3CX template cannot be used in a browser address bar. " +
      "Use at least six characters, letters, numbers, dashes, dots or underscores only: a \"#\" hides everything " +
      "after it from the Worker, and \"%\", \"&\", \"+\" and spaces mean other things in a web address. " +
      "The key still works when sent as the X-Log-Download-Key header.");
  }

  downloadKeyWrittenAt = Date.now();
  try {
    await env.DIAGNOSTIC_LOGS.put(DOWNLOAD_KEY_RECORD, value);
  } catch (e) {
    console.error("Could not store the log download key:", e.message);
  }
}

/**
 * The log file, for the proxy key sent as a header, or for the template's
 * separate log download key in the query string, which is what makes it
 * openable in a browser.
 *
 * The main proxy key is deliberately NOT accepted in the query string: it
 * writes to Salesforce, and a URL ends up in history, bookmarks and
 * screenshots. The download key only reads a log of masked numbers and
 * decisions, and changing it in 3CX revokes the old one.
 */
async function handleLogDownload(env, request, requestUrl) {
  const header = request.headers.get("X-Proxy-API-Key") || "";
  if (header && header === env.PROXY_API_KEY) return await downloadDiagnosticLog(env, requestUrl);

  const offered = (requestUrl.searchParams.get("key") || "").trim();
  const headerKey = (request.headers.get("X-Log-Download-Key") || "").trim();
  const stored = env.DIAGNOSTIC_LOGS ? await env.DIAGNOSTIC_LOGS.get(DOWNLOAD_KEY_RECORD) : null;
  if (stored && (offered === stored || headerKey === stored)) return await downloadDiagnosticLog(env, requestUrl);

  // The commonest ways this goes wrong, said plainly, because the person
  // reading it is looking at a browser tab and nothing else.
  let why;
  if (!stored) {
    why = "No log download key has reached the Worker yet. Set one in the 3CX template, save, then make one call: " +
      "the Worker learns it from that call.";
  } else if (!offered) {
    why = "No key arrived. If yours contains a \"#\", the browser keeps everything after it and the Worker never sees it. " +
      "Set a key of letters, numbers, dashes, dots or underscores in the 3CX template.";
  } else if (!browserSafeKey(offered)) {
    why = "That key contains characters a web address treats as punctuation, so it did not arrive as typed. " +
      "Use letters, numbers, dashes, dots or underscores.";
  } else {
    why = "That key does not match the one in the 3CX template. A key changed there reaches the Worker on the next call.";
  }

  return jsonResponse({ error: "Unauthorized", message: why }, 401);
}

async function downloadDiagnosticLog(env, requestUrl) {
  if (!env.DIAGNOSTIC_LOGS) {
    return jsonResponse({ error: "Not configured", message: "No log store is bound to this Worker." }, 404);
  }

  const asked = Number(requestUrl.searchParams.get("entries") || "200");
  const limit = Math.min(Number.isFinite(asked) && asked > 0 ? Math.round(asked) : 200, 500);
  const listed = await env.DIAGNOSTIC_LOGS.list({ prefix: "log:", limit });
  const entries = await Promise.all(listed.keys.map(key => env.DIAGNOSTIC_LOGS.get(key.name)));
  const body = entries.filter(Boolean).join("\n\n");

  return new Response(
    `3CX to Salesforce Worker, diagnostic log, newest first\nPulled ${new Date().toISOString()}, ` +
    `${listed.keys.length} entr${listed.keys.length === 1 ? "y" : "ies"}${listed.list_complete ? "" : ", more not shown"}\n\n${body || "Nothing stored."}\n`,
    {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="3cx-worker-log-${ukToday()}.txt"`,
        "Cache-Control": "no-store"
      }
    });
}

/** What the template told this request, as one line. */
function templateSettings(env, headers) {
  const read = name => (headers && headers.get ? headers.get(name) : "") || "";
  const count = value => value.split(",").map(v => v.trim()).filter(Boolean).length;
  return `template: tracked queues ${count(read("X-Tracked-Queues"))}, receptionists ${count(read("X-Receptionist-Extensions"))}, ` +
    `excluded extensions ${count(read("X-Excluded-Extensions"))}, excluded prefixes ${count(read("X-Excluded-Prefixes"))}, ` +
    `always log existing ${read("X-Log-Existing-Always") || "(unset)"}, creates ${orgModel(env)}, ` +
    `history off for ${env.SALESFORCE_HISTORY_OFF || "nothing"}, transcripts "${read("X-Transcript-Policy") || "(unset)"}"`;
}

/**
 * Extra fields stamped onto every record the worker creates, supplied as a
 * JSON object per object type in the SALESFORCE_EXTRA_FIELDS variable, e.g.
 *   {"Lead":{"LeadSource":"3CX"},"Account":{"Care_Home__c":"Bristol"}}
 * Keeps custom-field additions a dashboard change rather than a redeploy.
 */
function extraFields(env, objectType) {
  if (!env.SALESFORCE_EXTRA_FIELDS) return {};
  try {
    return JSON.parse(env.SALESFORCE_EXTRA_FIELDS)[objectType] || {};
  } catch (e) {
    console.error("SALESFORCE_EXTRA_FIELDS is not valid JSON — ignoring:", e.message);
    return {};
  }
}

/**
 * The care home a record created for an enquiry is stamped with, so the org's
 * assignment rules can route it by home. SALESFORCE_HOME_FIELD names the field
 * (Care_Home__c at Cedar Care) and the value is the 3CX department the enquiry
 * came through. Where the field's values differ from the department names,
 * SALESFORCE_HOME_VALUES maps one to the other:
 *
 *   {"Oakhill":"Oakhill House"}
 *
 * A home the map does not list is sent as 3CX names it.
 */
function homeFields(env, home) {
  const field = (env.SALESFORCE_HOME_FIELD || "").trim();
  if (!field || !home) return {};
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) {
    console.error(`SALESFORCE_HOME_FIELD "${field}" is not a field name — ignoring it.`);
    return {};
  }

  let map = null;
  if (env.SALESFORCE_HOME_VALUES) {
    try {
      map = JSON.parse(env.SALESFORCE_HOME_VALUES);
    } catch (e) {
      console.error("SALESFORCE_HOME_VALUES is not valid JSON — sending the 3CX department names as they are:", e.message);
    }
  }
  if (!map || typeof map !== "object") return { [field]: home };

  const key = Object.keys(map).find(k => k.trim().toLowerCase() === home.toLowerCase());
  return { [field]: key === undefined ? home : String(map[key]) };
}

// Fields a record is created with whatever the org's setup: its name, number,
// opening lines and record type. Anything else (SALESFORCE_EXTRA_FIELDS, the
// care home) helps, but a record without it is still worth having.
// Description is not among them on purpose. It carries the opening lines and
// later the call history, but an enquiry with a name, a number and a care home
// is still worth having, and a user who cannot write Description would
// otherwise cost the record itself.
const CORE_RECORD_FIELDS = new Set(["FirstName", "LastName", "Phone", "RecordTypeId"]);

// Refusals about one field's name, access or value rather than the record.
const FIELD_LEVEL_CODES = new Set([
  "INVALID_FIELD", "INVALID_FIELD_FOR_INSERT_UPDATE", "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST",
  "INVALID_TYPE_ON_FIELD_IN_RECORD", "STRING_TOO_LONG", "FIELD_INTEGRITY_EXCEPTION",
  "INVALID_CROSS_REFERENCE_KEY", "MALFORMED_ID", "FIELD_FILTER_VALIDATION_EXCEPTION",
  "FIELD_CUSTOM_VALIDATION_EXCEPTION", "JSON_PARSER_ERROR"
]);
// Of those, the ones that say the field itself is missing or not writable,
// whatever value is sent.
const FIELD_UNUSABLE_CODES = new Set(["INVALID_FIELD", "INVALID_FIELD_FOR_INSERT_UPDATE"]);

/**
 * The optional fields a refused insert names, as [{ key, unusable }].
 *
 * Read from Salesforce's error list entry by entry: the entry's own errorCode,
 * and the fields it lists or its message names. Only the top-level code
 * counts, so a trigger failing further in, whose message happens to mention
 * the same field name, sets nothing aside. JSON_PARSER_ERROR names a value
 * and a position rather than a field, so it sets every optional field aside.
 */
function refusedOptionalFields(errorText, objectType, optionalKeys) {
  let errors;
  try {
    errors = JSON.parse(errorText);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(errors)) return [];

  const byName = new Map(optionalKeys.map(key => [key.toLowerCase(), key]));
  const refused = new Map();
  for (const entry of errors) {
    const code = String((entry && entry.errorCode) || "");
    if (!FIELD_LEVEL_CODES.has(code)) continue;

    const message = String(entry.message || "");
    const named = (Array.isArray(entry.fields) ? entry.fields : []).map(String);
    const column = message.match(/No such column '(\w+)' on (?:sobject of type|entity) '?(\w+)'?/i);
    if (column && column[2].toLowerCase() === objectType.toLowerCase()) named.push(column[1]);
    const unwritable = message.match(/Unable to create\/update fields: ([\w\s,]+?)\./i);
    if (unwritable) named.push(...unwritable[1].split(","));

    const keys = code === "JSON_PARSER_ERROR" && named.length === 0
      ? optionalKeys
      : named.map(name => byName.get(name.trim().toLowerCase())).filter(Boolean);
    for (const key of keys) refused.set(key, refused.get(key) || FIELD_UNUSABLE_CODES.has(code));
  }
  return [...refused].map(([key, unusable]) => ({ key, unusable }));
}

/**
 * What staff are told on the record when an optional field could not be set,
 * written for them rather than for whoever maintains the integration.
 */
function fieldNotice(env, key, value, unusable) {
  const isHome = key === (env.SALESFORCE_HOME_FIELD || "").trim();
  const what = isHome ? `Care home (${key})` : key;
  return unusable
    ? `${what} not set: the phone integration's Salesforce user is not allowed to fill in this field. ` +
      `Fill it in by hand, and ask your Salesforce admin to give that user Edit access to it. Until then, ` +
      `records from the phone system arrive without it.`
    : `${what} not set: Salesforce would not accept "${value}" in this field. Fill it in by hand` +
      `${isHome ? " so the record reaches the right home" : ""}, and ask your Salesforce admin to add that value to the field.`;
}

/** Adds a staff notice once, when the caller is collecting them. */
function addNotice(notices, message) {
  if (notices && !notices.includes(message)) notices.push(message);
}

/**
 * Starts a report for whoever maintains the integration: the Worker logs, and
 * ALERT_WEBHOOK_URL when one is set. Kept alive past the response (see
 * pendingReports). Staff hear about problems through Salesforce Tasks instead.
 */
function queueReport(env, instanceUrl, message) {
  console.error(message);
  if (env.__log) env.__log.push(`${new Date().toISOString()} ${message}`);
  pendingReports.push(reportMaintenanceFailure(env, instanceUrl, null, new Error(message)));
}

// Salesforce's own duplicate rules still apply to these inserts. This only
// stops a rule set to "Allow" (with an alert) refusing an API insert as if it
// were set to "Block": the Worker has already searched for the caller by
// number, and a "Block" rule still blocks.
const DUPLICATE_RULE_HEADERS = { "Sforce-Duplicate-Rule-Header": "allowSave=true" };

/**
 * Inserts a record. When Salesforce refuses one of the optional fields (a
 * care home that is not in the picklist, a Lead Source value not added yet,
 * a field the org has not built or the integration user cannot write), the
 * insert is retried without it, so the enquiry still gets its record and is
 * still routed, just less precisely.
 *
 * The refusal is reported to the integration's logs when it happens, whatever
 * becomes of the retry, and the field or value is left off later inserts
 * without being reported there again. Staff are told on every record that
 * arrives without a value they can fill in by hand, through `notices`, which
 * the caller raises as a Salesforce Task. A field the integration user cannot
 * write is only noticed once, on the record where it was first refused.
 *
 * Returns { response, errorText }. errorText is set, and the body already
 * read, when the insert finally failed.
 */
async function insertRecord(env, instanceUrl, objectType, body, notices = null) {
  const url = `${instanceUrl}${SF_API_PATH}/sobjects/${objectType}`;
  const keyField = externalIdField(env);
  const isOptional = key => !CORE_RECORD_FIELDS.has(key) && key !== keyField;
  const valueKey = (key, value) => `${objectType}.${key}=${JSON.stringify(value)}`;

  // Only a value that comes from configuration is worth remembering: a care
  // home or a Lead Source is the same on the next call, so offering it again
  // wastes an insert. Text written per call, such as the description, is
  // different every time, and remembering it would both fill the set and
  // silently skip the next call's.
  const fromConfig = new Set([
    (env.SALESFORCE_HOME_FIELD || "").trim(),
    ...Object.keys(extraFields(env, objectType))
  ].filter(Boolean));

  const payload = {};
  const skipped = [];
  for (const [key, value] of Object.entries(body)) {
    if (isOptional(key) && unusableFields.has(`${objectType}.${key}`)) {
      skipped.push(key);
    } else if (isOptional(key) && refusedValues.has(valueKey(key, value))) {
      skipped.push(key);
      addNotice(notices, fieldNotice(env, key, value, false));
    } else {
      payload[key] = value;
    }
  }
  if (skipped.length > 0) {
    console.warn(`Inserting ${objectType} without ${skipped.join(", ")}, which Salesforce refused earlier.`);
  }

  for (;;) {
    const response = await sfFetch(env, url, { method: "POST", headers: DUPLICATE_RULE_HEADERS, body: JSON.stringify(payload) });
    if (response.ok) return { response };

    const errorText = await response.text();
    const refused = response.status === 400
      ? refusedOptionalFields(errorText, objectType, Object.keys(payload).filter(isOptional))
      : [];
    if (refused.length === 0) return { response, errorText };

    for (const { key, unusable } of refused) {
      if (unusable) {
        unusableFields.add(`${objectType}.${key}`);
      } else if (fromConfig.has(key)) {
        if (refusedValues.size >= REFUSED_VALUES_MAX) refusedValues.clear();
        refusedValues.add(valueKey(key, payload[key]));
      }
      addNotice(notices, fieldNotice(env, key, payload[key], unusable));
      delete payload[key];
    }
    queueReport(env, instanceUrl,
      `Salesforce refused ${refused.map(r => r.key).join(", ")} on a new ${objectType}, so it is left off this ` +
      `and later inserts until the Worker restarts: ${errorText.slice(0, 300)}`);
  }
}

/**
 * Finds the org's person-account record type, which every Person Account
 * insert must carry. Discovered at runtime and cached, so the same worker
 * works against any org without hardcoding an id.
 */
async function getPersonAccountRecordTypeId(env, instanceUrl) {
  if (cachedPersonRecordTypeId) return cachedPersonRecordTypeId;

  const records = await sfQuery(env, instanceUrl,
    `SELECT Id FROM RecordType WHERE SobjectType = 'Account' AND IsPersonType = true AND IsActive = true LIMIT 1`);

  if (records && records.length > 0) {
    cachedPersonRecordTypeId = records[0].Id;
  } else if (records) {
    console.error("No active person-account record type found — are Person Accounts enabled in this org?");
  }
  return cachedPersonRecordTypeId;
}

export default {
  async fetch(request, env, ctx) {
    // The template's settings apply from here down, and this request's
    // diagnostic lines collect on the env it returns.
    const runtime = envForRequest(env, request.headers);
    try {
      return await requestHandler.fetch(request, runtime, ctx);
    } finally {
      const waiting = [];
      // Reports raised along the way are already on their way; this keeps
      // them alive once the response has gone.
      if (pendingReports.length > 0) waiting.push(...pendingReports.splice(0));
      if (runtime.__log && runtime.__log.length > 0) waiting.push(storeDiagnosticLog(runtime));
      if (request.headers.get("X-Log-Download-Key")) waiting.push(rememberDownloadKey(runtime, request.headers));
      if (waiting.length > 0 && ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(Promise.all(waiting));
      }
    }
  }
};

const requestHandler = {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    // Repeated slashes collapse. A trailing slash on the Worker URL in 3CX
    // produces "//services/...", and a path beginning "//" is otherwise read
    // as a different host once resolved against the Salesforce URL.
    const path = requestUrl.pathname.replace(/\/{2,}/g, "/");

    // ── ContactUrl Redirect (Browser Traffic) ────────────────────────────
    // Browsers don't send the X-Proxy-API-Key header when a user clicks the
    // link in 3CX. We intercept it here, before API key verification, and
    // redirect the user's browser to the Salesforce URL.
    const bareIdMatch = path.match(/^\/([a-zA-Z0-9_]{15,30})$/);
    if (bareIdMatch && request.method === "GET") {
      const salesforceId = bareIdMatch[1];

      // A stand-in has no record yet, so open the list for the object the
      // Worker would create instead of a record page that does not exist.
      if (isPendingCallerId(salesforceId)) {
        const home = { contact: "Contact", personaccount: "Account", lead: "Lead" }[orgModel(env)];
        return Response.redirect(`${trimmedLoginUrl(env)}/lightning/o/${home}/home`, 302);
      }
      return Response.redirect(`${trimmedLoginUrl(env)}/${salesforceId}`, 302);
    }

    // The stored diagnostic log, as a text file. Checked before the proxy key,
    // because this one can also be opened in a browser with the template's
    // log download key, which a browser cannot send as a header.
    if (path === "/logs.txt" && request.method === "GET") {
      return await handleLogDownload(env, request, requestUrl);
    }

    // 1. Verify API Key from 3CX
    const apiKey = request.headers.get("X-Proxy-API-Key");
    if (!apiKey || apiKey !== env.PROXY_API_KEY) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    setHomeCountry(env);

    try {
      // 2. Obtain Salesforce access token & instance URL (stateless client
      //    credentials flow). The login URL is checked on every request, not
      //    only when a token is fetched, so a wrong one shows up straight away
      //    rather than when the cached token next expires.
      salesforceLoginUrl(env);
      const { accessToken, instanceUrl } = await getSalesforceToken(env);

      // Set when this request is a 3CX search-as-you-type query, so the
      // result can be learned from once Salesforce answers.
      let typeAhead = null;

      // A match with no AccountId makes 3CX's follow-up GetAccountName query
      // hit Salesforce with WHERE Id = '' and fail. Answer it locally with an
      // empty result set instead.
      if (/\/query\/?$/.test(path)) {
        const q = requestUrl.searchParams.get("q") || "";
        if (/WHERE\s+Id\s*=\s*''/i.test(q)) {
          return jsonResponse({ totalSize: 0, done: true, records: [] });
        }

        // 3CX searches as the user types, firing one query per object type
        // per keystroke — the single biggest consumer of Salesforce API
        // quota in this integration. Two guards keep it in check: a minimum
        // term length, and a negative cache of terms already known empty.
        const likeMatch = q.match(/LIKE\s+'%([^%']*)%'/i);
        if (likeMatch) {
          typeAhead = { term: likeMatch[1], shape: searchShape(q, likeMatch[1]) };
          let minLength = Number(env.MIN_SEARCH_LENGTH || "3");
          if (isNaN(minLength) || minLength < 0) minLength = 3;

          if (typeAhead.term.length < minLength || isKnownEmptySearch(typeAhead.shape, typeAhead.term)) {
            return jsonResponse({ totalSize: 0, done: true, records: [] });
          }
        }
      }

      let searchParams = requestUrl.search;

      // Canonicalize phone lookups. 3CX sends digits only (Prefix="Off"),
      // so "07700900123" is rewritten to the canonical UK digits
      // "447700900123". The SOSL term deliberately has no leading "+"
      // ("+" is a reserved SOSL character and fails with MALFORMED_SEARCH);
      // Salesforce's phone index ignores punctuation, so the digits-only
      // form still matches contacts stored as "+44...". The query string is
      // rebuilt through URLSearchParams so the encoding stays valid
      // regardless of how 3CX encoded the original request.
      if (/\/search\/?$/.test(path)) {
        const query = requestUrl.searchParams.get("q") || "";
        if (/IN\s+PHONE\s+FIELDS/i.test(query)) {
          const phoneMatch = query.match(/FIND\s+\{([0-9+][0-9\s\-().]*)\}/i);
          if (phoneMatch) {
            const soslTerm = soslPhoneTerm(phoneMatch[1]);
            if (soslTerm && soslTerm !== phoneMatch[1]) {
              const params = new URLSearchParams(requestUrl.searchParams);
              params.set("q", query.replace(`{${phoneMatch[1]}}`, `{${soslTerm}}`));
              searchParams = `?${params.toString()}`;
            }
          }
        }
      }

      // Construct the target by setting the path on the Salesforce URL, which
      // can never change its host, rather than resolving a string against it.
      const target = new URL(instanceUrl);
      target.pathname = path;
      target.search = searchParams;
      const targetUrl = target.toString();

      // Prepare headers to forward to Salesforce. The template's own X-
      // settings, the proxy key and hop-by-hop headers stay here.
      const forwardHeaders = new Headers();
      for (const [key, value] of request.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (lowerKey !== "host" && !lowerKey.startsWith("x-") && !lowerKey.startsWith("cf-")) {
          forwardHeaders.set(key, value);
        }
      }

      // Attach the Salesforce Bearer access token
      forwardHeaders.set("Authorization", `Bearer ${accessToken}`);

      const isDataPath = /^\/services\/data\/v\d+\.\d+\//.test(path);

      // 3. Intercept Contact Lookup (Search requests)
      if (isDataPath && /\/search\/?$/.test(path) && request.method === "GET") {
        return await handleLookupProxy(env, targetUrl, forwardHeaders, request.headers);
      }

      // 4. Intercept Call Journaling (Task creation). Case-insensitive, so
      //    "/sobjects/Task" cannot slip past the filters and redaction.
      if (isDataPath && /\/sobjects\/task\/?$/i.test(path) && request.method === "POST") {
        return await handleTaskProxy(env, ctx, targetUrl, forwardHeaders, request);
      }

      // 4b. Type-ahead search: forward, but learn from an empty result so
      //     every longer term is answered locally from here on.
      if (typeAhead) {
        return await handleTypeAheadQuery(env, targetUrl, forwardHeaders, typeAhead);
      }

      // 5. Pass-through, limited to the reads the 3CX template makes: SOQL
      //    queries and SOSL searches. The proxy key must not be a way to
      //    delete records or call any other Salesforce API as the
      //    integration user.
      const permitted = request.method === "GET" && /^\/services\/data\/v\d+\.\d+\/(?:query|search)\/?$/.test(path);
      if (!permitted) {
        console.warn(`Refused ${request.method} ${path}: not a request the 3CX template makes.`);
        return jsonResponse({ error: "Forbidden", message: "This proxy only forwards the requests the 3CX template makes." }, 403);
      }

      return await forwardWithAuthRetry(env, targetUrl, {
        method: "GET",
        headers: forwardHeaders
      });

    } catch (error) {
      // The detail stays in the logs. Salesforce's own error text is not
      // something to hand back to whoever made the request.
      console.error("Proxy error:", error);
      return jsonResponse({ error: "Proxy Error", message: "The request could not be completed." }, 502);
    }
  }
};

/**
 * Gets Salesforce REST API Access Token using Client Credentials Flow and caches it in memory.
 */
async function getSalesforceToken(env) {
  const now = Date.now();
  if (cachedToken && cachedInstanceUrl && now < tokenExpiry) {
    return { accessToken: cachedToken, instanceUrl: cachedInstanceUrl };
  }

  const tokenUrl = `${salesforceLoginUrl(env)}/services/oauth2/token`;
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.SALESFORCE_CLIENT_ID,
    client_secret: env.SALESFORCE_CLIENT_SECRET
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Salesforce OAuth client credentials failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  cachedInstanceUrl = data.instance_url;

  // The identity URL ends with the run-as user's id.
  const userId = String(data.id || "").split("/").pop();
  cachedUserId = /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(userId) ? userId : null;

  // Salesforce access tokens typically expire in 2 hours. We cache for 1 hour
  // 55 minutes; orgs with a shorter session timeout are covered by the
  // automatic 401-retry in forwardWithAuthRetry / sfFetch.
  tokenExpiry = now + 115 * 60 * 1000;

  return { accessToken: cachedToken, instanceUrl: cachedInstanceUrl };
}

// Salesforce addresses that look usable but do not serve the client
// credentials flow: the generic login hosts, and the Lightning, Visualforce and
// Experience Cloud addresses a browser shows. A denylist rather than requiring
// ".my.salesforce.com", so government cloud and other My Domain suffixes work.
const NOT_A_TOKEN_HOST = /^https:\/\/(?:(?:login|test)\.salesforce\.com|[^/]+\.force\.com|[^/]+\.my\.site\.com)$/i;

/**
 * The org's own My Domain address, without a trailing slash. The client
 * credentials flow is only served there, so the addresses that are not it are
 * refused with a message saying so rather than an OAuth error from Salesforce.
 */
function salesforceLoginUrl(env) {
  const url = trimmedLoginUrl(env);
  if (!/^https:\/\/[^/\s]+$/i.test(url) || NOT_A_TOKEN_HOST.test(url)) {
    throw new Error("SALESFORCE_LOGIN_URL must be the org's My Domain URL, e.g. https://example.my.salesforce.com " +
      "or https://example--uat.sandbox.my.salesforce.com. The client credentials flow is not available through " +
      "login.salesforce.com, test.salesforce.com, or the lightning.force.com and my.site.com addresses.");
  }
  return url;
}

function trimmedLoginUrl(env) {
  return String(env.SALESFORCE_LOGIN_URL || "").trim().replace(/\/+$/, "");
}

function invalidateSalesforceToken() {
  cachedToken = null;
  cachedInstanceUrl = null;
  tokenExpiry = 0;
}

/**
 * Forwards a request to Salesforce, refreshing the cached token and retrying
 * once if Salesforce rejects it (org session timeouts can be shorter than
 * our cache window).
 */
async function forwardWithAuthRetry(env, url, init) {
  let response = await fetch(url, init);
  if (response.status === 401) {
    invalidateSalesforceToken();
    const { accessToken } = await getSalesforceToken(env);
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${accessToken}`);
    response = await fetch(url, { ...init, headers });
  }
  return response;
}

/**
 * Worker-initiated Salesforce API call with fresh auth and 401 retry.
 */
async function sfFetch(env, url, options = {}) {
  const attempt = async () => {
    const { accessToken } = await getSalesforceToken(env);
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${accessToken}`);
    if (options.body) {
      headers.set("Content-Type", "application/json");
    }
    // Salesforce re-runs active Lead assignment rules on every API update
    // unless told not to. Appending a call must never hand a Lead to someone
    // else; assignment still applies when a Lead is created.
    if ((options.method || "GET").toUpperCase() === "PATCH") {
      headers.set("Sforce-Auto-Assign", "FALSE");
    }
    return fetch(url, { ...options, headers });
  };

  let response = await attempt();
  if (response.status === 401) {
    invalidateSalesforceToken();
    response = await attempt();
  }
  return response;
}

/**
 * A write background maintenance cannot silently lose. Throws with
 * Salesforce's reason, so the failure alert fires instead of the transcript
 * quietly never reaching the record.
 */
async function sfWrite(env, url, options) {
  const response = await sfFetch(env, url, options);
  if (!response.ok) {
    const where = url.split(SF_API_PATH)[1] || url;
    throw new Error(`${options.method} ${where} failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  return response;
}

/**
 * Runs a SOQL query. Returns the records array, or null if the query failed
 * (callers treat null as "unknown" rather than "not found" to avoid
 * creating duplicates on transient errors).
 *
 * A query that fails because the External ID field is missing or hidden is
 * retried once without it, and the field is set aside for this isolate. A
 * misconfigured field then costs the structural guarantee, not every call.
 */
async function sfQuery(env, instanceUrl, soql) {
  const run = q => sfFetch(env, `${instanceUrl}${SF_API_PATH}/query/?${new URLSearchParams({ q })}`);
  let query = withoutBlockedFields(soql);
  let response = await run(query);

  // A field the integration user cannot read fails the whole query, and
  // Salesforce words it exactly like a field that does not exist. Rather than
  // report the caller as unknown, the field is dropped and the query is run
  // again without it: a narrower match beats no match at all. Each one is
  // remembered, so the next call does not pay for it again.
  for (let attempts = 0; !response.ok && attempts < 4; attempts++) {
    const errorText = await response.text();
    const blocked = blockedFieldFrom(errorText);
    const withoutKey = externalIdUnusable(env, errorText) ? stripExternalIdClause(env, query) : query;
    const narrowed = blocked ? stripFieldFromSoql(withoutKey, blocked) : withoutKey;

    if (narrowed === query) {
      console.error(`SOQL query failed (${response.status}): ${errorText.slice(0, 500)}`);
      return null;
    }
    if (blocked && narrowed !== withoutKey) {
      rememberBlockedField(env, instanceUrl, blocked, errorText);
    }
    query = narrowed;
    response = await run(query);
  }

  if (!response.ok) {
    console.error(`SOQL query still failing after dropping unreadable fields (${response.status}).`);
    return null;
  }

  const data = await response.json();
  return data.records || [];
}

// Fields Salesforce says the integration user cannot read. Dropped from every
// later query for the life of the isolate, so one hidden field costs one
// refused query rather than one per call. Cleared by a deploy or a restart,
// which is when a permission fix takes effect anyway.
const blockedFields = new Set();

/** The field named by an "unreadable or missing field" error, if that is what it is. */
function blockedFieldFrom(errorText) {
  if (!/INVALID_FIELD|No such column|does not exist|not accessible/i.test(errorText)) return "";
  const named = errorText.match(/No such column '([A-Za-z0-9_]+)'/i) ||
                errorText.match(/\bfield '([A-Za-z0-9_]+)'/i);
  return named ? named[1] : "";
}

function rememberBlockedField(env, instanceUrl, field, errorText) {
  if (blockedFields.has(field)) return;
  blockedFields.add(field);
  queueReport(env, instanceUrl,
    `${field} cannot be read by the integration user, so it is left out of lookups until the Worker restarts. ` +
    `Callers are still matched on the fields that remain. Grant the integration user Read on ${field} to restore it. ` +
    `Salesforce said: ${errorText.slice(0, 200)}`);
}

/** The query with every already-known blocked field taken out. */
function withoutBlockedFields(soql) {
  let query = soql;
  for (const field of blockedFields) query = stripFieldFromSoql(query, field);
  return query;
}

/**
 * Takes one field out of a SOQL query: out of the SELECT list, and out of any
 * `Field = '…'` or `Field IN (…)` term, tidying up the OR or AND that joined
 * it. Returns the query unchanged when the field is not in it, or when
 * dropping it would leave a SELECT or a WHERE with nothing in it.
 */
function stripFieldFromSoql(soql, field) {
  if (!/^[A-Za-z0-9_]+$/.test(field) || !new RegExp(`\\b${field}\\b`).test(soql)) return soql;

  const parts = soql.match(/^(SELECT\s+)([\s\S]*?)(\s+FROM\s[\s\S]*)$/i);
  if (!parts) return soql;

  const selected = parts[2].split(",").map(f => f.trim()).filter(f => f.toLowerCase() !== field.toLowerCase());
  if (selected.length === 0) return soql;

  let rest = parts[3]
    .replace(new RegExp(`\\b${field}\\s*(?:=\\s*'[^']*'|IN\\s*\\([^)]*\\))\\s*(?:OR|AND)\\s+`, "gi"), "")
    .replace(new RegExp(`\\s*(?:OR|AND)\\s+\\b${field}\\s*(?:=\\s*'[^']*'|IN\\s*\\([^)]*\\))`, "gi"), "");

  // A WHERE left holding nothing, or still naming the field (a lone term, or
  // one this does not understand), is not worth guessing at.
  if (new RegExp(`\\b${field}\\b`).test(rest) || /WHERE\s*\(?\s*(?:\)|ORDER|LIMIT|$)/i.test(rest)) return soql;

  return `${parts[1]}${selected.join(", ")}${rest}`;
}

/**
 * True, once, when Salesforce reports the configured External ID field as
 * missing or hidden. Sets it aside so matching and creation carry on with the
 * phone fields alone.
 */
function externalIdUnusable(env, errorText) {
  const field = (env.SALESFORCE_EXTERNAL_ID_FIELD || "").trim();
  if (!field || !errorText.includes(field)) return false;
  if (!/INVALID_FIELD|No such column|does not exist|not accessible/i.test(errorText)) return false;
  if (!externalIdDisabled) {
    externalIdDisabled = true;
    console.error(`${field} is missing, misspelt or hidden from the integration user. ` +
      `Matching on phone fields only until the Worker restarts, so duplicates are no longer structurally ` +
      `prevented. Fix the field or SALESFORCE_EXTERNAL_ID_FIELD.`);
  }
  return true;
}

function stripExternalIdClause(env, soql) {
  const field = (env.SALESFORCE_EXTERNAL_ID_FIELD || "").trim().replace(/[^A-Za-z0-9_]/g, "");
  return field ? soql.replace(new RegExp(`${field} = '[^']*' OR `, "g"), "") : soql;
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: { "Content-Type": "application/json", ...extraHeaders }
  });
}

// Country used to interpret national-format numbers ("07911…"), as an ISO
// 3166 code. Override with HOME_COUNTRY in the Cloudflare dashboard.
let homeCountry = "GB";

function setHomeCountry(env) {
  const code = (env.HOME_COUNTRY || "GB").trim().toUpperCase();
  homeCountry = /^[A-Z]{2}$/.test(code) ? code : "GB";
}

function homeCallingCode() {
  try {
    return getCountryCallingCode(homeCountry);
  } catch (e) {
    return "44";
  }
}

// Below this, a string is an extension or short code, never a phone number.
const MIN_REAL_NUMBER_DIGITS = 7;

/**
 * Normalizes any number, from any country, to E.164.
 *
 * Uses libphonenumber (Google's numbering-plan database) rather than
 * hand-rolled rules, because a leading "0" is a national trunk prefix whose
 * meaning depends entirely on the country's numbering plan — there is no
 * regex that gets this right worldwide.
 *
 * The hard case is that the 3CX template sends digits only (Prefix="Off"),
 * stripping the "+" from international caller IDs. So "919876543210" could
 * be an Indian number missing its "+", or a national number somewhere. We
 * try it as E.164 first and accept only if it validates against the real
 * numbering plan, then fall back to reading it as a home-country national
 * number. Validity, not guesswork, decides.
 */
function normalizePhone(raw) {
  if (!raw) return raw;

  const cleaned = String(raw).trim().replace(/[^\d+]/g, "");
  const digits = cleaned.replace(/\D/g, "");
  if (!digits) return String(raw).trim();

  // Extensions and short codes must never become phone numbers.
  if (digits.length < MIN_REAL_NUMBER_DIGITS) return digits;

  const candidates = [];
  if (cleaned.startsWith("+")) {
    candidates.push(cleaned);
  } else if (digits.startsWith("00")) {
    // International access code used across most of the world.
    candidates.push(`+${digits.slice(2)}`);
  } else if (!digits.startsWith("0")) {
    // Possibly E.164 with the "+" stripped in transit.
    candidates.push(`+${digits}`);
  }

  const parsed = [
    ...candidates.map(c => tryParse(c)),
    // Otherwise read it as a national number for the configured home country.
    tryParse(digits, homeCountry)
  ].filter(Boolean);

  // Prefer a number the metadata recognises as an assigned range...
  for (const p of parsed) if (p.isValid()) return p.number;

  // ...but accept anything structurally possible for its country. Carriers
  // route numbers from reserved ranges (Ofcom's 07700 900xxx drama block)
  // and from ranges allocated after this metadata was published — and a
  // call that actually arrived is, by definition, a real number.
  for (const p of parsed) if (p.isPossible()) return p.number;

  // Unrecognisable anywhere: keep it predictable rather than inventing a
  // country code, so behaviour stays stable and debuggable.
  return cleaned.startsWith("+") ? cleaned : digits;
}

function tryParse(value, country) {
  try {
    return parsePhoneNumberFromString(value, country) || null;
  } catch (e) {
    return null;
  }
}

/**
 * Every plausible way this number might already be stored in Salesforce —
 * E.164, national, with or without spaces and "+". Lets the worker match
 * records typed by humans without depending on Salesforce-side formatting.
 */
function phoneVariants(phone) {
  const variants = new Set();
  const add = v => { if (v) variants.add(String(v).replace(/['\\]/g, "")); };

  add(phone);
  const digits = String(phone).replace(/\D/g, "");
  add(digits);

  const parsed = tryParse(String(phone).startsWith("+") ? phone : `+${digits}`);
  if (parsed && (parsed.isValid() || parsed.isPossible())) {
    add(parsed.number);                                    // +447700900123
    add(parsed.number.slice(1));                           // 447700900123
    add(parsed.formatInternational());                     // +44 7700 900123
    add(parsed.formatNational());                          // 07700 900123
    add(parsed.formatNational().replace(/[\s()-]/g, ""));  // 07700900123
    add(parsed.nationalNumber);                            // 7700900123
  }

  // Cap the list so the generated SOQL stays small and predictable.
  return [...variants].slice(0, 10);
}

/** Builds `Field IN ('a','b',…)` clauses across several phone fields. */
function phoneMatchClause(fields, phone) {
  const list = phoneVariants(phone).map(v => `'${v}'`).join(", ");
  return fields.map(f => `${f} IN (${list})`).join(" OR ");
}

/**
 * SOSL search term for a phone number: canonical digits without the leading
 * "+". "+" is a reserved character in SOSL — FIND {+44...} fails with
 * MALFORMED_SEARCH — and Salesforce's phone-field index ignores punctuation,
 * so the digits-only form still matches contacts stored as "+44...".
 */
function soslPhoneTerm(raw) {
  return (normalizePhone(raw) || "").replace(/^\+/, "");
}

/** Slices without splitting an emoji's surrogate pair, which Salesforce rejects as malformed text. */
function safeSlice(text, start, end = text.length) {
  let from = Math.max(0, start);
  let to = Math.min(text.length, end);
  if (from > 0 && /[\uDC00-\uDFFF]/.test(text[from])) from++;
  if (to < text.length && /[\uD800-\uDBFF]/.test(text[to - 1])) to--;
  return text.slice(from, to);
}

/** For a record's running history: keeps the newest calls. */
function truncateForSalesforce(text) {
  if (text.length <= SF_TEXT_LIMIT) return text;
  return `[Earlier history truncated]\n...${safeSlice(text, text.length - (SF_TEXT_LIMIT - 40))}`;
}

/**
 * For a single call log: keeps the start, where the call details and the
 * beginning of the transcript are. Salesforce rejects the whole call log if
 * its Description is over the limit, so a long transcript would otherwise
 * lose the call entirely.
 */
function truncateCallLog(text) {
  if (text.length <= SF_TEXT_LIMIT) return text;
  return `${safeSlice(text, 0, SF_TEXT_LIMIT - 60)}\n...[transcript truncated to fit Salesforce]`;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Today in the UK, e.g. "15 Sep 2026". Months are spelt out here: runtimes disagree on "Sep" and "Sept". */
function ukDate() {
  const [dd, mm, yyyy] = new Date()
    .toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "numeric", year: "numeric" })
    .split("/");
  return `${Number(dd)} ${MONTH_NAMES[Number(mm) - 1]} ${yyyy}`;
}

/** The time in the UK, e.g. "10:32". */
function ukTime() {
  return new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Date in the UK, as Salesforce's YYYY-MM-DD, so an after-midnight reminder is not due yesterday. */
function ukToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

/** "+447911123456" as "+44******456", for logs that should not hold whole numbers. */
function maskPhone(phone) {
  const text = String(phone || "");
  return text.length > 6 ? `${text.slice(0, 3)}${"*".repeat(text.length - 6)}${text.slice(-3)}` : text;
}

/**
 * Ring-time creation switch for templates older than v46, which send an
 * Auto-Create dropdown. From v46 Tracked Queues decides instead, and a blank
 * list means nothing is created. "After-Hours Only" from an even older
 * template is treated as "Always On", since office hours no longer apply.
 */
function shouldAutoCreate(headers) {
  const policy = (headers.get("X-Auto-Create-Policy") || "Always On").trim();
  return policy !== "Disabled";
}

/**
 * The tracked queue gate, read from the template's headers.
 *
 * Tracked Queues (template v46) lists the queues whose calls are recorded.
 * Only calls that come through one of them (New Care Enquiries for the
 * homes, the Placement Team at head office) may create a record for an
 * unknown caller. Excluded Extensions is checked before this and always
 * wins. Calls from people who already have a record are logged
 * whatever the route, unless Always Log Existing Records is switched off, in
 * which case they too are only logged when the call came through a listed
 * queue.
 *
 * 3CX gives a CRM template no route information at lookup time: the queue
 * extension arrives only with the call journal, as [QueueExtension]. So the
 * decision is made at journaling. A template older than v46 sends none of
 * these headers (see trackedQueuesConfigured), which leaves the gate off and
 * keeps the previous behaviour of creating records at ring time.
 *
 *   viaQueue  the call came through a listed queue
 *   answered  and a person picked it up. 3CX reports [Agent] as the queue
 *             itself when nobody answered, and a receptionist or ring group
 *             leg is routing rather than a person, so an abandoned or
 *             diverted enquiry never creates a record.
 */
function trackedQueueGate(headers, call) {
  if (!trackedQueuesConfigured(headers)) return { active: false };

  const list = trackedQueueList(headers);
  const queue = extensionFromHeader(headers, "X-Queue-Extension");
  const viaQueue = matchesExtension(list, queue) || matchesExtension(list, call.agent);
  const agentIsRouting = matchesExtension(routingExtensionList(headers), call.agent);
  const answered = viaQueue && !agentIsRouting && !/Missed|Unanswered/.test(call.direction || "");
  const logExisting = !/^false$/i.test((headers.get("X-Log-Existing-Always") || "True").trim());

  // A caller who gave up in the enquiries queue is a lost enquiry, not a
  // non-event, so by default they still get a record and a reminder to ring
  // back. The routing check is deliberately not applied: an abandoned queue
  // call is journaled against the queue itself, which is the whole point.
  // Only inbound counts — an outbound call nobody answered is ours, not an
  // enquiry.
  const captureMissed = !/^false$/i.test((headers.get("X-Capture-Missed") || "True").trim());
  const missed = viaQueue && captureMissed && /Inbound Missed/.test(call.direction || "");

  return { active: true, queue, viaQueue, answered, missed, create: answered || missed, logExisting };
}

/**
 * True for a v46+ template. The Boolean toggle is the marker rather than the
 * queue list, because a Boolean always carries a value while a blank list
 * might be omitted, and treating a blank list as an old template would
 * silently go back to creating a record for every caller.
 */
function trackedQueuesConfigured(headers) {
  return headers.get("X-Log-Existing-Always") !== null || headers.get("X-Tracked-Queues") !== null;
}

function trackedQueueList(headers) {
  return (headers.get("X-Tracked-Queues") || "").split(",").map(v => v.trim()).filter(Boolean);
}

function isPendingCallerId(id) {
  return typeof id === "string" && id.startsWith(PENDING_PREFIX);
}

/**
 * The stand-in match returned to 3CX for an unknown caller while the gate is
 * on. 3CX only journals a call whose lookup matched something, so without
 * it no call log would ever arrive to decide on. The id is unique per number
 * so 3CX never treats two callers as the same contact, and it carries the
 * number so journaling can find or create the real record.
 */
function pendingCallerMatch(phone) {
  const id = PENDING_PREFIX + phone.replace(/\D/g, "");
  return jsonResponse({
    searchRecords: [
      {
        attributes: { type: "Contact", url: `${SF_API_PATH}/sobjects/Contact/${id}` },
        Id: id,
        FirstName: PENDING_FIRST_NAME,
        LastName: phone,
        Phone: phone,
        Email: ""
      }
    ]
  }, 200, { "Cache-Control": "no-store" });
}

/**
 * The first line of a 3CX call description: its own timestamp, direction,
 * number and extension. Everything after it is what was said on the call or
 * generated from it.
 */
function callHeaderLine(description) {
  return (String(description || "").replace(/\r\n?/g, "\n").split("\n").find(line => line.trim()) || "").trim();
}

/**
 * Splits a 3CX call description into its header and the AI sections
 * (transcription / summary / sentiment / recording). 3CX composes these from
 * the template's [Transcription], [Summary], [Sentiment] and [RecordingUrl]
 * placeholders, each on its own labelled line, always in that order.
 *
 * What a caller says can contain the same words at the start of a line, so a
 * heading is not trusted just for existing. Working back from the end takes
 * the last Recording, the last Sentiment before it and the last Summary
 * before that, then the first Transcription before those. Nothing said on
 * the call can pose as a later section or cut the transcript short.
 */
function splitCallSections(description) {
  const text = String(description || "").replace(/\r\n?/g, "\n");
  const headings = label => [...text.matchAll(new RegExp(`(^|\\n)[ \\t]*${label}:[ \\t]*`, "gi"))]
    .map(m => ({ label, start: m.index + m[1].length, body: m.index + m[0].length }));

  const found = [];
  let limit = text.length;
  for (const label of ["Recording", "Sentiment", "Summary"]) {
    const before = headings(label).filter(h => h.start < limit);
    if (before.length) {
      found.push(before[before.length - 1]);
      limit = before[before.length - 1].start;
    }
  }
  const transcript = headings("Transcription").find(h => h.start < limit);
  if (transcript) found.push(transcript);
  found.sort((a, b) => a.start - b.start);

  const section = label => {
    const i = found.findIndex(h => h.label === label);
    if (i === -1) return "";
    const end = i + 1 < found.length ? found[i + 1].start : text.length;
    return text.slice(found[i].body, end).trim();
  };

  return {
    header: (found.length ? text.slice(0, found[0].start) : text).trim(),
    transcription: section("Transcription"),
    summary: section("Summary"),
    sentiment: section("Sentiment"),
    recording: section("Recording")
  };
}

/**
 * True when the number should never reach Salesforce — internal extensions
 * (short numbers) and admin-listed prefixes such as sister-site DDIs.
 * Filtering these keeps internal transfers, and their transcripts, out of
 * the CRM entirely.
 */
function isFilteredNumber(phone, headers) {
  const digits = (normalizePhone(phone) || "").replace(/[^0-9]/g, "");
  if (!digits) return true;

  // Internal extensions: anything at or below the configured digit count.
  let maxInternal = Number(headers.get("X-Internal-Max-Digits") || "6");
  if (isNaN(maxInternal) || maxInternal < 0) maxInternal = 6;
  if (digits.length <= maxInternal) return true;

  // Admin-listed prefixes (CSV), matched against the canonical E.164 form so
  // "07393...", "447393..." and "+447393..." all compare alike.
  const canonical = `+${digits}`;
  const excluded = (headers.get("X-Excluded-Prefixes") || "")
    .split(",")
    .map(p => normalizePrefix(p))
    .filter(Boolean);

  return excluded.some(prefix => canonical.startsWith(prefix));
}

/**
 * Canonicalizes a partial dialling prefix to E.164. normalizePhone can't be
 * reused here because its UK rule only fires on a full-length number, while
 * admins enter fragments such as "0117" for a sister site's landline range.
 */
function normalizePrefix(raw) {
  const cleaned = (raw || "").trim().replace(/[\s\-().]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("00")) return `+${cleaned.slice(2)}`;
  if (cleaned.startsWith("0")) return `+${homeCallingCode()}${cleaned.slice(1)}`; // national → E.164
  return `+${cleaned}`;
}

/**
 * Per-direction journaling switches. 3CX reports four call outcomes and each
 * can be turned off independently, e.g. to stop outbound campaigns or
 * unanswered attempts from cluttering the CRM.
 */
function shouldJournalDirection(direction, headers) {
  const enabled = key => (headers.get(key) || "True").trim().toLowerCase() !== "false";

  if (direction === "Inbound") return enabled("X-Journal-Inbound");
  if (direction === "Inbound Missed") return enabled("X-Journal-Missed");
  if (direction === "Outbound") return enabled("X-Journal-Outbound");
  if (direction === "Outbound Unanswered") return enabled("X-Journal-Unanswered");

  // Unrecognised description format — journal it rather than lose the record.
  return true;
}

/**
 * Applies the transcript policy to a call description.
 *
 *   "Include full transcript" → unchanged (default)
 *   "Metadata only"           → transcription and recording link removed
 *   "External inbound only"   → transcription kept only for inbound calls
 *
 * The call header line (time, direction, extension, duration) always
 * survives, so the activity history stays useful even when the words don't.
 */
function applyTranscriptPolicy(description, direction, headers) {
  const policy = (headers.get("X-Transcript-Policy") || "Include full transcript").trim();
  if (policy === "Include full transcript") return description;
  if (policy === "External inbound only" && direction.includes("Inbound")) return description;

  // Rebuilt from the header line and the sections actually found, never by
  // cutting pieces out: if the headings are missing, nothing else survives.
  const sections = splitCallSections(description);
  let redacted = `${callHeaderLine(description)}\n\n[Transcription withheld by CRM policy]`;
  if (sections.summary) redacted += `\n\nSummary: ${sections.summary}`;
  if (sections.sentiment) redacted += `\n\nSentiment: ${sections.sentiment}`;
  return redacted;
}

/**
 * Extensions where the call is worth logging but its content is not safe to
 * store: nurse to nurse, safeguarding, anything clinical.
 *
 * Keeps who called whom, when, and for how long, and discards everything
 * derived from what was said. That includes the **summary and sentiment**,
 * not just the transcript: an AI summary of a conversation about a resident
 * is the same confidential information in fewer words, which is why the
 * ordinary transcript policy is not enough here.
 */
function isConfidentialExtension(headers, agent) {
  const csv = (headers && headers.get ? headers.get("X-Confidential-Extensions") : "") || "";
  return matchesExtension(csv.split(",").map(v => v.trim()).filter(Boolean), agent);
}

function redactCallContent(description) {
  // Only the header line is kept, whatever shape the rest is in.
  return `${callHeaderLine(description)}\n\n[Content withheld: this extension is marked confidential. ` +
         `The call itself is logged, but the transcript, summary and recording ` +
         `link are not stored in Salesforce.]`;
}

/**
 * Smart Natural Language processing regex parser to extract names from transcription.
 * Searches for caller introductions like "my name is John", "this is Sarah", "I'm David".
 */
function extractNameFromTranscription(transcription) {
  if (!transcription) return null;

  // Clean the text to avoid punctuation issues, but preserve spacing
  const cleanText = transcription
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Case-insensitive patterns with word boundaries
  const patterns = [
    /\bmy name is\s+([a-z]+(?:\s+[a-z]+)?)\b/i,
    /\bthis is\s+([a-z]+(?:\s+[a-z]+)?)\b/i,
    /\bi am\s+([a-z]+(?:\s+[a-z]+)?)\b/i,
    /\bim\s+([a-z]+(?:\s+[a-z]+)?)\b/i,
    /\bi'm\s+([a-z]+(?:\s+[a-z]+)?)\b/i
  ];

  // Terms that are never a caller's name. Covers 3CX/telephony vocabulary
  // ("this is extension 102", "this is voicemail") and — just as important —
  // pronouns and filler, since "this is me" and "I'm sorry" otherwise get
  // captured as names.
  const blacklist = [
    // Telephony / operational
    "extension", "agent", "3cx", "call", "calling", "voicemail", "phone",
    "unregistered", "unknown", "outgoing", "incoming", "answered", "missed",
    "reception", "support", "sales", "accounts", "team", "office",
    // Pronouns and possessives
    "me", "my", "mine", "you", "your", "yours", "he", "him", "his", "she",
    "her", "hers", "it", "its", "we", "us", "our", "ours", "they", "them",
    "their", "theirs", "this", "that", "these", "those",
    // Articles, fillers and common openers
    "the", "a", "an", "and", "but", "so", "well", "just", "still", "again",
    "here", "there", "now", "sorry", "please", "thanks", "thank", "hello",
    "hi", "hey", "good", "morning", "afternoon", "evening", "yes", "no",
    "not", "ok", "okay", "actually", "really", "very", "back", "trying",
    "somebody", "someone", "nobody", "anybody", "everyone", "speaking",
    // Staff greetings: "this is Sarah from Arbour Walk", "this is Sarah at reception"
    "from", "at", "with", "calling", "ringing"
  ];

  for (const pattern of patterns) {
    const match = cleanText.match(pattern);
    if (match && match[1]) {
      const words = match[1].toLowerCase().trim().split(" ");

      // Filter out empty matches or blacklist matches
      const isValid = words.length > 0 &&
                      words[0].length > 1 &&
                      !words.some(word => blacklist.includes(word));

      if (isValid) {
        // Capitalize words
        return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      }
    }
  }

  return null;
}

/**
 * Proxies lookup queries. If Salesforce returns empty results for a
 * phone-number contact lookup and the auto-create conditions are met, the
 * REAL contact is created (duplicate-free) right now and returned, so the
 * agent gets a genuine, editable CRM record while the call is live and 3CX
 * journals against a real id at call end. Email and free-text lookups are
 * never intercepted, otherwise chats and CFD queries would spawn junk
 * contacts.
 */
async function handleLookupProxy(env, targetUrl, forwardHeaders, requestHeaders) {
  const response = await forwardWithAuthRetry(env, targetUrl, {
    method: "GET",
    headers: forwardHeaders
  });

  // Salesforce refusing this search must never reach 3CX. 3CX treats an error
  // from a lookup as the lookup failing, and a call whose lookup failed is
  // never journaled at all: no call log, no transcript, no record, for every
  // caller. One field the integration user cannot read is enough to do it.
  // Treated as "nobody found" instead, so the Worker's own lookup still runs
  // and a tracked enquiry still gets its stand-in and its call log.
  let data = { searchRecords: [] };
  // 200 even when Salesforce refused, since an empty answer is what 3CX is
  // being given.
  const lookupStatus = response.ok ? response.status : 200;
  if (response.ok) {
    data = await response.json();
  } else {
    const errorText = await response.text();
    const refusal = `Salesforce refused the 3CX lookup (${response.status}), continuing as if nobody matched: ` +
      `${errorText.slice(0, 300)}`;
    console.error(refusal);
    if (env.__log) env.__log.push(`${new Date().toISOString()} ${refusal}`);
    const blocked = blockedFieldFrom(errorText);
    if (blocked) {
      rememberBlockedField(env, new URL(targetUrl).origin, blocked, errorText);
      console.error(`The 3CX template is asking Salesforce for ${blocked}, which the integration user cannot read. ` +
        `Grant it Read on ${blocked}, or take that field out of the template's lookup scenarios.`);
    }
  }

  // If search records are empty
  if (!data.searchRecords || data.searchRecords.length === 0) {
    const query = new URL(targetUrl).searchParams.get("q") || "";
    const isPhoneContactLookup = /IN\s+PHONE\s+FIELDS/i.test(query) && /RETURNING\s+Contact/i.test(query);

    if (isPhoneContactLookup) {
      const phoneMatch = query.match(/FIND\s+\{(.*?)\}/i);
      const phone = normalizePhone(phoneMatch ? phoneMatch[1] : "").replace(/[^0-9+]/g, "");

      // Internal extensions and excluded prefixes never get a CRM record.
      // Returning the empty result also stops 3CX journaling the call at
      // all: the template's CreateCallActivity scenario is skipped when
      // EntityId is blank, so the transcript never reaches Salesforce.
      if (isFilteredNumber(phone, requestHeaders)) {
        console.log(`Filtered number ${maskPhone(phone)} — no record created, journaling suppressed.`);
        return jsonResponse(data, lookupStatus);
      }

      if (/[0-9]{4,}/.test(phone)) {
        const instanceUrl = new URL(targetUrl).origin;

        // With Tracked Queues set, nothing is created at ring time: the
        // lookup cannot see the queue, so creation waits for the journal.
        const gated = trackedQueuesConfigured(requestHeaders);

        // Finding an existing record is always worth doing: Salesforce's own
        // SOSL misses records stored in national format, and whether we may
        // CREATE a record is a separate question from whether one exists.
        // An older template creates at ring time, so an excluded extension
        // has to be honoured here too, whenever 3CX supplies [Agent].
        const lookupAgent = extensionFromHeader(requestHeaders, "X-Agent-Extension");
        const excluded = lookupAgent && isExcludedExtension(requestHeaders, lookupAgent);
        const mayCreate = !gated && !excluded && shouldAutoCreate(requestHeaders);
        const { target, created } = await locateRecord(env, instanceUrl, phone, mayCreate);

        diag(env, `lookup ${maskPhone(phone)}: ${target && target.whoId ? `matched ${target.objectType} ${target.recordId}` : "no match"}` +
          `, direction "${requestHeaders.get("X-Call-Direction") || "(unset)"}", agent ${lookupAgent || "(none)"}, ` +
          `${gated ? `${trackedQueueList(requestHeaders).length} tracked queues` : "no tracked queue headers"}`);

        if (target && target.whoId) {
          // 3CX is told the entity type that makes its own journaling work:
          // "Lead" so the task lands on the Lead, and "Contact" for a Person
          // Account (whoId is the backing PersonContactId — an Account type
          // would make 3CX populate WhatId instead of WhoId).
          const entityType = target.objectType === "Lead" ? "Lead" : "Contact";

          return jsonResponse({
            searchRecords: [
              {
                attributes: {
                  type: entityType,
                  url: `${SF_API_PATH}/sobjects/${entityType}/${target.whoId}`
                },
                Id: target.whoId,
                // A real record keeps its real (even blank) first name; only
                // one the Worker just created is shown as unregistered.
                FirstName: target.FirstName || (created ? DEFAULT_FIRST_NAME : ""),
                LastName: target.LastName || phone,
                // The number 3CX searched for, not whichever phone field the
                // record happens to hold first, so 3CX accepts the match.
                Phone: phone,
                Email: target.Email || ""
              }
            ]
          }, 200, { "Cache-Control": "no-store" });
        }

        // Unknown caller with the gate on: answer with a stand-in so 3CX
        // journals the call, and decide at journaling whether it came
        // through a tracked queue. An outbound call never passes through a
        // queue, so it gets nothing, and neither does any call while the
        // list is blank. [CallDirection] is documented for lookups; if 3CX
        // leaves it unsubstituted the stand-in is returned and the journal is
        // dropped instead.
        const outbound = /^outbound$/i.test((requestHeaders.get("X-Call-Direction") || "").trim());
        // Nothing is created while both record toggles are off, so an unknown
        // caller gets no stand-in either: journaling one would only be dropped.
        if (gated && trackedQueueList(requestHeaders).length > 0 && !outbound && creationAllowed(env)) {
          return pendingCallerMatch(phone);
        }

        // Nothing will be created and 3CX will not journal this call. Say why:
        // from the outside that is indistinguishable from the integration
        // being broken, and a template whose settings were lost on re-upload
        // looks exactly like this.
        if (!outbound) {
          console.warn(gated
            ? (trackedQueueList(requestHeaders).length === 0
                ? `Unknown caller ${maskPhone(phone)}: Tracked Queues is empty in the 3CX template, so no record is created ` +
                  `and 3CX will not journal the call. Check Integrations → CRM; an upload can clear saved settings.`
                : `Unknown caller ${maskPhone(phone)}: no record, and the call will not be journaled.`)
            : `Unknown caller ${maskPhone(phone)}: the template is not sending the tracked queue headers, so the ` +
              `pre-v46 ring-time rules apply and nothing is created.`);
        }
      }
    }
  }

  // Otherwise, return original Salesforce results (which will be empty, skipping call logging)
  return jsonResponse(data, lookupStatus);
}

/**
 * Ring-time find-or-create for the configured org model. Returns a uniform
 * shape so callers don't care which object backs the caller:
 *
 *   { objectType, recordId, whoId, FirstName, LastName, Phone }
 *
 * `whoId` is what Task.WhoId must be set to — the record itself for Contacts
 * and Leads, but the backing PersonContactId for a Person Account, since
 * WhoId only accepts Contact or Lead ids.
 *
 * Returns { target, failed, created }. failed=true means Salesforce could
 * not be queried reliably (or the create failed), so "not found" cannot be
 * trusted and nothing is created, rather than risking a duplicate.
 *
 * `names` ({ firstName, lastName, description, fields }) names a record
 * created here and carries its care home; without it the ring-time
 * placeholder name is used.
 */
async function locateRecord(env, instanceUrl, phone, mayCreate, names = null) {
  // With both record toggles off nothing is created, but callers already on
  // file are still found and still logged, so matching runs as for Leads.
  const configured = orgModel(env);
  const model = configured === "none" ? "lead" : configured;
  mayCreate = mayCreate && configured !== "none";
  const failed = { target: null, failed: true };

  // A create that matched an existing record (a race, or the unique key) is
  // not a creation. A record with no usable WhoId cannot be linked, so it is
  // treated as a failure and a tracked call is logged unlinked instead.
  const outcome = (result, toTarget) => {
    if (!result) return failed;
    if (result.record && result.record.IsConverted) return convertedLeadResult(result.record);
    const target = toTarget(result.record);
    if (!target || !target.whoId) return failed;
    return result.isNew ? { target, created: true } : { target };
  };

  if (model === "contact") {
    const existing = await findContactByPhone(env, instanceUrl, phone);
    if (existing.record) return { target: contactResult(existing.record) };
    if (existing.failed) return failed;
    if (!mayCreate) return { target: null };
    return outcome(await createRingTimeContact(env, instanceUrl, phone, names), contactResult);
  }

  // Person Accounts take priority in both remaining modes: a converted Lead
  // becomes a Person Account, and that's the record later calls belong on.
  const account = await findPersonAccountByPhone(env, instanceUrl, phone);
  if (account.record) return { target: personAccountResult(account.record, phone) };
  if (account.failed) return failed;

  if (model === "lead") {
    // An open Lead is still the right home until someone converts it.
    const lead = await findOpenLeadByPhone(env, instanceUrl, phone);
    if (lead.record) return { target: leadResult(lead.record, phone) };
    if (lead.failed) return failed;
  }

  // A professional who rings (a social worker, a hospital discharge team) is
  // often already a Contact under a business Account. Log against them
  // rather than raising an enquiry for someone already on file.
  const contact = await findBusinessContactByPhone(env, instanceUrl, phone);
  if (contact.record) return { target: contactResult(contact.record) };
  if (contact.failed) return failed;

  if (!mayCreate) {
    // Creating would find a converted Lead through its unique key. A call
    // that may not create (a missed or untracked leg) has to look for one
    // itself, or someone already converted is reported as unknown.
    if (model === "lead") {
      const converted = await findConvertedLeadByPhone(env, instanceUrl, phone);
      if (converted.record) return convertedLeadResult(converted.record);
      if (converted.failed) return failed;
    }
    return { target: null };
  }

  if (model === "lead") {
    return outcome(await createLeadDeduped(env, instanceUrl, phone, names), r => leadResult(r, phone));
  }
  return outcome(await createPersonAccountDeduped(env, instanceUrl, phone, names), r => personAccountResult(r, phone));
}

/**
 * A Lead that was converted but still holds the unique phone key. Its call
 * belongs on the record it became, which ConvertedContactId reaches: the
 * Person Account's backing contact, or the Contact of a business conversion.
 */
function convertedLeadResult(lead) {
  if (!lead.ConvertedContactId) return { target: null, failed: true };
  return {
    target: {
      objectType: "Contact",
      recordId: lead.ConvertedContactId,
      whoId: lead.ConvertedContactId,
      FirstName: lead.FirstName,
      LastName: lead.LastName,
      Phone: lead.Phone,
      Email: lead.Email
    }
  };
}

/** The most recently converted Lead for this number that became a record. */
async function findConvertedLeadByPhone(env, instanceUrl, phone) {
  const records = await sfQuery(env, instanceUrl,
    `SELECT Id, FirstName, LastName, Phone, Email, ConvertedContactId FROM Lead ` +
    `WHERE IsConverted = true AND ConvertedContactId != null AND (` +
    `${identityMatchClause(env, ["Phone", "MobilePhone"], phone)}) ORDER BY ConvertedDate DESC LIMIT 1`);

  if (records === null) return { record: null, failed: true };
  return { record: records[0] || null, failed: false };
}

/** A Contact under a business Account, never a Person Account's hidden one. */
async function findBusinessContactByPhone(env, instanceUrl, phone) {
  const records = await sfQuery(env, instanceUrl,
    `SELECT Id, FirstName, LastName, Phone, Email, Description FROM Contact WHERE IsPersonAccount = false AND (` +
    `${phoneMatchClause(["Phone", "MobilePhone"], phone)}) ORDER BY CreatedDate ASC, Id ASC LIMIT 1`);

  if (records === null) return { record: null, failed: true };
  return { record: records[0] || null, failed: false };
}

function contactResult(contact) {
  return {
    objectType: "Contact",
    recordId: contact.Id,
    whoId: contact.Id,
    FirstName: contact.FirstName,
    LastName: contact.LastName,
    Phone: contact.Phone,
    Email: contact.Email
  };
}

function personAccountResult(record, phone) {
  return {
    objectType: "Account",
    recordId: record.Id,
    // WhoId must be a Contact or Lead — for a Person Account that's the
    // hidden backing contact Salesforce maintains alongside the Account.
    whoId: record.PersonContactId,
    FirstName: record.FirstName,
    LastName: record.LastName,
    Phone: record.Phone || record.PersonMobilePhone || phone,
    Email: record.PersonEmail
  };
}

function leadResult(record, phone) {
  return {
    objectType: "Lead",
    recordId: record.Id,
    whoId: record.Id,
    FirstName: record.FirstName,
    LastName: record.LastName,
    Phone: record.Phone || record.MobilePhone || phone,
    Email: record.Email
  };
}

const PERSON_ACCOUNT_FIELDS =
  "Id, FirstName, LastName, Phone, PersonMobilePhone, PersonHomePhone, PersonOtherPhone, PersonEmail, Description, PersonContactId";

/**
 * Person Accounts carry the caller's number on any of four phone fields, so
 * all of them are matched. Business accounts are excluded — a call should
 * never attach itself to a company record.
 */
async function findPersonAccountByPhone(env, instanceUrl, phone) {
  const records = await sfQuery(env, instanceUrl,
    `SELECT ${PERSON_ACCOUNT_FIELDS} FROM Account WHERE IsPersonAccount = true AND (` +
    `${identityMatchClause(env, ["Phone", "PersonMobilePhone", "PersonHomePhone", "PersonOtherPhone"], phone)}) ` +
    `ORDER BY CreatedDate ASC, Id ASC`);

  if (records === null) return { record: null, failed: true };
  return { record: records[0] || null, failed: false };
}

const LEAD_FIELDS = "Id, FirstName, LastName, Phone, MobilePhone, Email, Description";

/**
 * Only unconverted Leads are matched. Once a Lead is converted its identity
 * lives on the resulting Person Account, which is checked first anyway.
 */
async function findOpenLeadByPhone(env, instanceUrl, phone) {
  const records = await sfQuery(env, instanceUrl,
    `SELECT ${LEAD_FIELDS} FROM Lead WHERE IsConverted = false AND (` +
    `${identityMatchClause(env, ["Phone", "MobilePhone"], phone)}) ` +
    `ORDER BY CreatedDate ASC, Id ASC`);

  if (records === null) return { record: null, failed: true };
  return { record: records[0] || null, failed: false };
}

async function createPersonAccountDeduped(env, instanceUrl, phone, names = null) {
  const recordTypeId = await getPersonAccountRecordTypeId(env, instanceUrl);
  if (!recordTypeId) return null;

  return createRecordDeduped(env, instanceUrl, "Account", {
    RecordTypeId: recordTypeId,
    FirstName: names ? names.firstName : DEFAULT_FIRST_NAME,
    LastName: names ? names.lastName : phone,
    Phone: phone,
    Description: names ? names.description : ringTimeDescription(),
    ...extraFields(env, "Account"),
    ...(names && names.fields)
  }, `SELECT ${PERSON_ACCOUNT_FIELDS} FROM Account WHERE IsPersonAccount = true AND (` +
     `${identityMatchClause(env, ["Phone", "PersonMobilePhone"], phone)}) ORDER BY CreatedDate ASC, Id ASC`, phone,
     names && names.notices);
}

async function createLeadDeduped(env, instanceUrl, phone, names = null) {
  // Company is deliberately omitted: with Person Accounts enabled, a Lead
  // whose Company is blank converts into a Person Account rather than a
  // business Account + Contact, which is the process we want.
  return createRecordDeduped(env, instanceUrl, "Lead", {
    FirstName: names ? names.firstName : DEFAULT_FIRST_NAME,
    LastName: names ? names.lastName : phone,
    Phone: phone,
    Description: names ? names.description : ringTimeDescription(),
    ...extraFields(env, "Lead"),
    ...(names && names.fields)
  }, `SELECT ${LEAD_FIELDS} FROM Lead WHERE IsConverted = false AND (` +
     `${identityMatchClause(env, ["Phone", "MobilePhone"], phone)}) ORDER BY CreatedDate ASC, Id ASC`, phone,
     names && names.notices);
}

/** Opening lines of a record created when the phone rang (templates older than v46). */
function ringTimeDescription() {
  return `Created when this number rang\n${ukDate()} at ${ukTime()}`;
}

/**
 * Name of a unique External ID field holding the caller's E.164 number
 * (e.g. "Phone_E164__c"), set as SALESFORCE_EXTERNAL_ID_FIELD.
 *
 * With it, record creation becomes a Salesforce upsert keyed on that field,
 * and duplicates are impossible at database level rather than merely
 * unlikely. Without it, the create-then-converge fallback below still
 * applies — it just cannot beat a true unique constraint.
 */
function externalIdField(env) {
  return externalIdDisabled ? "" : (env.SALESFORCE_EXTERNAL_ID_FIELD || "").trim();
}

/**
 * Match clause for "is this caller already on file", covering both ways a
 * record can carry the number.
 *
 * The two must agree. phoneMatchClause compares standard phone fields with
 * an exact-string SOQL IN over phoneVariants, so a number a human typed as
 * "07911 123 456" is not in the list and misses — while the same record's
 * External ID holds the canonical "+447911123456" and matches. Searching
 * only the phone fields therefore reports "no such caller" for a record the
 * writer is about to find, which is how a curated record gets overwritten.
 */
function identityMatchClause(env, fields, phone) {
  const field = externalIdField(env);
  const byPhone = phoneMatchClause(fields, phone);
  return field ? `${field} = '${phone}' OR ${byPhone}` : byPhone;
}

/**
 * Upsert keyed on the org's unique External ID field. Two simultaneous
 * calls from one number cannot both create a record: Salesforce enforces
 * uniqueness, so the second becomes an update of the first.
 *
 * Returns null if the upsert could not be performed (typically the field
 * does not exist or is not marked External ID), so the caller can fall back
 * to create-then-converge — a misconfigured field name must not stop
 * records being created at all.
 */
async function upsertByExternalId(env, instanceUrl, objectType, field, phone, body, convergeSoql, notices = null) {
  // Read the record's own fields back by key rather than through
  // convergeSoql, which matches on phone variants and can miss the very
  // record the key just found.
  //
  // A converted Lead keeps its key, so a Lead read also says whether it was
  // converted and what it became (see convertedLeadResult).
  const selected = ((convergeSoql.match(/^SELECT\s+([\s\S]*?)\s+FROM\s/i) || [])[1] || "Id") +
    (objectType === "Lead" ? ", IsConverted, ConvertedContactId" : "");
  const readByKey = () => sfQuery(env, instanceUrl,
    `SELECT ${selected} FROM ${objectType} WHERE ${field} = '${phone}' LIMIT 1`);

  // A record must never be handed back as a bare id. In personaccount mode the
  // caller needs PersonContactId, which no create response returns, and without
  // it the lookup yields nothing and the call goes unlogged. If the key read
  // comes up empty, read the row we just wrote by its own id instead.
  const readById = id => id
    ? sfQuery(env, instanceUrl, `SELECT ${selected} FROM ${objectType} WHERE Id = '${id}' LIMIT 1`)
    : Promise.resolve(null);

  // Look before writing.
  //
  // PATCHing the external-id endpoint is Salesforce's upsert, and on a match
  // it applies the WHOLE body. The body here is the ring-time placeholder:
  // FirstName "Unregistered Contact", LastName the number, and a two-line
  // Description. Applied to a record a human has since named, that erases
  // the name and every appended call block, then leaves the record looking
  // unregistered again so the reminder loop restarts. Salesforce keeps no
  // recoverable history for long text areas, so it is not undoable.
  //
  // The uniqueness guarantee comes from the field's own unique constraint
  // rejecting a second insert. It does not require PATCH.
  const keyUrl = `${instanceUrl}${SF_API_PATH}/sobjects/${objectType}/` +
                 `${encodeURIComponent(field)}/${encodeURIComponent(phone)}`;
  const existing = await sfFetch(env, keyUrl, { method: "GET" });

  if (existing.ok) {
    const records = await readByKey();
    const found = records && records[0];
    if (found) {
      console.log(`Matched existing ${objectType} ${found.Id} on ${field} — left untouched`);
      return { record: found, isNew: false };
    }
    // Readable by key but not by query: treat as unknown rather than
    // creating a second record that the unique constraint would reject.
    console.error(`${objectType} matched on ${field} but could not be re-read; not creating.`);
    return null;
  }

  if (existing.status !== 404) {
    console.error(`Lookup on ${objectType}.${field} failed (${existing.status}): ${await existing.text()}`);
    return null;
  }

  // Genuinely absent: insert, carrying the key.
  const { response: created, errorText } = await insertRecord(env, instanceUrl, objectType, { ...body, [field]: phone }, notices);

  if (created.ok) {
    const id = (await created.json().catch(() => ({}))).id || null;
    const byKey = await readByKey();
    const mine = (byKey && byKey[0]) || ((await readById(id)) || [])[0];
    if (mine) {
      console.log(`Created ${objectType} ${mine.Id} with ${field} ${maskPhone(phone)}`);
      emptySearchTerms.clear();
      return { record: mine, isNew: true };
    }
    // Written, but unreadable. Returning a bare id would strand the caller
    // without PersonContactId, so report failure and let the caller fall
    // back rather than hand back a half-formed record.
    // The usual cause is sharing: an assignment rule gave the new record to an
    // owner whose records the integration user cannot see.
    queueReport(env, instanceUrl,
      `Created ${objectType} ${id} but could not read it back, so its call is logged without it. If an assignment ` +
      `rule moves new ${objectType}s to other owners, the integration user needs View All and Modify All on ${objectType}.`);
    addNotice(notices,
      `A ${objectType} was created for this caller (${id}), but the phone integration's Salesforce user cannot see it, ` +
      `so the call could not be linked to it. Link the call log to that ${objectType} by hand, and ask your Salesforce ` +
      `admin to give the integration user View All and Modify All on ${objectType}s, since an assignment rule moves ` +
      `new ones to owners it cannot see.`);
    return null;
  }

  // A simultaneous call inserted first and the unique constraint refused
  // ours. That is the guarantee working: adopt the winner.
  if (/DUPLICATE_VALUE|duplicate value found/i.test(errorText)) {
    const records = await readByKey();
    const winner = records && records[0];
    if (winner) {
      console.log(`Race on ${field} ${maskPhone(phone)}: adopted existing ${objectType} ${winner.Id}`);
      return { record: winner, isNew: false };
    }
  }

  // A missing or hidden key field sets it aside, so the fallback insert
  // below goes ahead without it.
  externalIdUnusable(env, errorText);
  console.error(`Insert on ${objectType} with ${field} failed (${created.status}): ${errorText.slice(0, 500)}`);
  return null;
}

/**
 * Generic create-then-converge: create the record, then re-query and keep
 * only the oldest one for this number. If a simultaneous call won the race,
 * ours (which has no tasks attached yet) is deleted and the winner used.
 *
 * Used when no External ID field is configured. Convergence closes the race
 * after the fact; an External ID field prevents it happening at all.
 */
async function createRecordDeduped(env, instanceUrl, objectType, body, convergeSoql, phone, notices = null) {
  if (externalIdField(env) && phone) {
    const field = externalIdField(env);
    const upserted = await upsertByExternalId(
      env, instanceUrl, objectType, field, phone, { ...body, [field]: phone }, convergeSoql, notices);
    if (upserted) return upserted;
    console.error(`Falling back to create-then-converge for ${objectType}.`);
  }

  // Carry the External ID here as well, unless the upsert just found it
  // unusable. Salesforce excludes nulls from a unique constraint, so a
  // fallback row written without it sits outside the guarantee entirely.
  const field = externalIdField(env);
  const { response, errorText } = await insertRecord(env, instanceUrl, objectType,
    field && phone ? { ...body, [field]: phone } : body, notices);

  if (!response.ok) {
    console.error(`Failed to create Salesforce ${objectType}: ${response.status} - ${errorText.slice(0, 500)}`);

    // A duplicate rule that matched a record the phone lookup missed, or a
    // simultaneous call's record, blocks ours. If this number now has a
    // record, that is the one to use.
    if (/DUPLICATES_DETECTED|DUPLICATE_VALUE/i.test(errorText)) {
      const existing = await sfQuery(env, instanceUrl, convergeSoql);
      if (existing && existing.length > 0) {
        console.log(`${objectType} insert blocked as a duplicate: using existing ${existing[0].Id}`);
        return { record: existing[0], isNew: false };
      }
    }

    // Point at the two org-config causes that look identical from here.
    if (/REQUIRED_FIELD_MISSING/i.test(errorText)) {
      console.error(`${objectType} insert is missing a required field. If it is Company on a Lead, ` +
        `that field must be optional for Leads to convert into Person Accounts — check the org's ` +
        `field-level requirement, or supply a value via SALESFORCE_EXTRA_FIELDS.`);
    }
    if (/DUPLICATES_DETECTED|FIELD_CUSTOM_VALIDATION_EXCEPTION/i.test(errorText)) {
      console.error(`${objectType} insert was blocked by a duplicate or validation rule in this org.`);
    }
    return null;
  }

  const myId = (await response.json()).id;
  const records = await sfQuery(env, instanceUrl, convergeSoql);

  if (records && records.length > 1 && records[0].Id !== myId) {
    console.log(`Race detected: kept existing ${objectType} ${records[0].Id}, removing duplicate ${myId}`);
    const cleanup = await sfFetch(env, `${instanceUrl}${SF_API_PATH}/sobjects/${objectType}/${myId}`, { method: "DELETE" });
    if (!cleanup.ok) {
      console.error(`Could not remove duplicate ${objectType} ${myId}: ${cleanup.status}`);
    }
    return { record: records[0], isNew: false };
  }

  console.log(`Created ${objectType} ${myId} at ring time`);
  emptySearchTerms.clear();

  // Re-read so the caller gets server-populated fields such as
  // PersonContactId, which the create response doesn't return.
  if (records && records.length > 0) {
    const mine = records.find(r => r.Id === myId);
    if (mine) return { record: mine, isNew: true };
  }
  return { record: { Id: myId, ...body }, isNew: true };
}

/**
 * Ring-time find-or-create. The SOQL-first lookup also covers the window
 * where a just-created contact exists but hasn't reached the SOSL search
 * index yet (which is why the proxied Salesforce search came back empty).
 * Returns { record, isNew }, or null if the create failed.
 */
async function createRingTimeContact(env, instanceUrl, phone, names = null) {
  return createContactDeduped(env, instanceUrl, phone, {
    FirstName: names ? names.firstName : DEFAULT_FIRST_NAME,
    LastName: names ? names.lastName : phone,
    Phone: phone,
    Description: names ? names.description : ringTimeDescription(),
    ...(names && names.fields)
  }, names && names.notices);
}

/**
 * Forwards a search-as-you-type query and remembers terms that matched
 * nothing, so subsequent keystrokes extending them never reach Salesforce.
 */
async function handleTypeAheadQuery(env, targetUrl, forwardHeaders, typeAhead) {
  const response = await forwardWithAuthRetry(env, targetUrl, {
    method: "GET",
    headers: forwardHeaders
  });

  if (!response.ok) return response;

  const data = await response.json();
  if (Array.isArray(data.records) && data.records.length === 0) {
    rememberEmptySearch(typeAhead.shape, typeAhead.term);
  }
  return jsonResponse(data, response.status);
}

/**
 * Extracts phone / agent / direction / 3CX phonebook name from the task
 * description that 3CX composes.
 *
 * 3CX description format uses [Number] [Name] pairs — the name sits between phone and "to"
 * Inbound:     "incoming call from [Number] [Name] to [Agent] ([Duration])"
 * Outbound:    "outgoing call from [Agent] to [Number] [Name] ([Duration])"
 * Missed:      "Missed call from [Number] [Name] to [Agent]"
 * Unanswered:  "Unanswered outgoing call from [Agent] to [Number] [Name]"
 */
function parseCallDetails(description) {
  let agent = "Unknown";
  let phone = null;
  let direction = "Call";
  let threeCxName = ""; // Name from 3CX local phonebook (if agent saved it)

  // Only the header line is read. The rest is the transcript and summary,
  // and a caller saying "incoming call from ... to ..." must not decide which
  // extension the exclusion and confidentiality rules are applied to.
  const header = callHeaderLine(description);

  // Most specific first: "Unanswered outgoing call" also contains
  // "outgoing call", and a stamped name's brackets must not pass for a duration.
  const unansweredMatch = header.match(/Unanswered outgoing call from\s+(\S+)\s+to\s+(\S+)\s*(.*)$/i);
  const missedMatch = header.match(/Missed call from\s+(\S+)\s*(.*?)\s+to\s+(\S+)/i);
  const inboundMatch = header.match(/incoming call from\s+(\S+)\s*(.*?)\s+to\s+(\S+)(?:\s|$)/i);
  const outboundMatch = header.match(/outgoing call from\s+(\S+)\s+to\s+(\S+)\s*(.*?)\s*(?:\(\d{1,2}:\d{2}(?::\d{2})?\))?\s*$/i);

  if (unansweredMatch) {
    agent = unansweredMatch[1];
    phone = unansweredMatch[2];
    threeCxName = (unansweredMatch[3] || "").trim();
    direction = "Outbound Unanswered";
  } else if (missedMatch) {
    phone = missedMatch[1];
    threeCxName = (missedMatch[2] || "").trim();
    agent = missedMatch[3];
    direction = "Inbound Missed";
  } else if (inboundMatch) {
    phone = inboundMatch[1];
    threeCxName = (inboundMatch[2] || "").trim();
    agent = inboundMatch[3];
    direction = "Inbound";
  } else if (outboundMatch) {
    agent = outboundMatch[1];
    phone = outboundMatch[2];
    threeCxName = (outboundMatch[3] || "").trim();
    direction = "Outbound";
  }

  // Canonicalize to E.164 and strip anything that isn't part of a number so
  // the value is safe to embed in SOQL/SOSL queries.
  if (phone) {
    phone = normalizePhone(phone).replace(/[^0-9+]/g, "");
    if (!/[0-9]{4,}/.test(phone)) {
      phone = null;
    }
  }

  // Ignore names the Worker itself stamped on auto-created contacts — 3CX
  // echoes the matched contact's display name back into the description.
  if (threeCxName && /Unsaved Contact|Unregistered Contact|\(Unsaved|Unverified|\bEnquiry\s+[+\d][\d\s]*\(/i.test(threeCxName)) {
    threeCxName = "";
  }

  // 3CX opens the description with its own timestamp, e.g.
  // "09/03/2026 15:04: Answered incoming call from …". Prefer that over the
  // clock: a call is journaled when it *ends*, so using "now" labelled a ten
  // minute call as having happened ten minutes after it started, and the
  // header then disagreed with the line directly beneath it.
  //
  // Only the time is taken. The date part's field order varies with the
  // PBX's locale and is not worth guessing at.
  const stamped = header.match(/^\s*\S+\s+(\d{1,2}):(\d{2})/);
  const callTime = stamped
    ? `${stamped[1].padStart(2, "0")}:${stamped[2]}`
    : new Date().toLocaleTimeString("en-GB", {
        timeZone: "Europe/London",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      });

  // Trailing "(mm:ss)" or "(h:mm:ss)" that 3CX appends for answered calls.
  const durationMatch = header.match(/\((\d{1,2}:\d{2}(?::\d{2})?)\)\s*$/);
  const duration = durationMatch ? durationMatch[1] : "";

  return { phone, agent, direction, threeCxName, callTime, duration };
}

/**
 * Extensions that are call-routing furniture rather than people: digital
 * receptionists, ring groups, and the tracked queues themselves.
 *
 * Receptionists come from the template's Receptionist Extensions setting,
 * since whoever builds the call flows already knows those numbers. Tracked
 * queues are routing too, so they count automatically.
 *
 * 3CX journals per extension leg, so a call greeted by an auto attendant is
 * journaled against the attendant first and only later against whoever dealt
 * with it. That first leg is worth recording but must not name the record.
 */
function routingExtensionList(headers) {
  const read = (name) => (headers && headers.get ? headers.get(name) || "" : "");
  return `${read("X-Receptionist-Extensions")},${read("X-Tracked-Queues")}`
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);
}

/**
 * Entries are exact by default. A trailing "*" makes one a prefix, so
 * "GRP*" covers every ring group in one entry rather than listing twenty of
 * them and revisiting the list each time a home is added.
 *
 * The wildcard is deliberately explicit. Treating every entry as a prefix
 * would quietly make "10" swallow extension 1050.
 */
function matchesExtension(list, agent) {
  if (!agent || agent === "Unknown") return false;
  return list.some(entry =>
    entry.endsWith("*")
      ? agent.startsWith(entry.slice(0, -1))
      : agent === entry);
}

function isRoutingExtension(routing, agent) {
  return matchesExtension([...routing.queues, ...routing.menus], agent);
}

/** Tracked queues and receptionist menus, kept apart so a call's history can name each. */
function routingLists(headers) {
  const read = (name) => (headers && headers.get ? headers.get(name) || "" : "");
  return {
    queues: read("X-Tracked-Queues").split(",").map(v => v.trim()).filter(Boolean),
    menus: read("X-Receptionist-Extensions").split(",").map(v => v.trim()).filter(Boolean)
  };
}

/**
 * Extensions whose calls must never reach Salesforce at all: HR, payroll,
 * safeguarding, a director's desk. Checked before Tracked Queues and Always
 * Log, so an exclusion always wins. A queue can be excluded too, by its
 * extension, since a journaled leg names the queue it came through.
 *
 * Same comma-separated, "*"-for-prefix syntax.
 */
function isExcludedExtension(headers, ...extensions) {
  const csv = (headers && headers.get ? headers.get("X-Excluded-Extensions") : "") || "";
  const list = csv.split(",").map(v => v.trim()).filter(Boolean);
  return extensions.some(ext => matchesExtension(list, ext));
}

/**
 * An extension number from a template header, or "" when 3CX left the
 * placeholder unsubstituted (it then arrives literally, e.g. "[QueueExtension]").
 */
function extensionFromHeader(headers, name) {
  const raw = (headers && headers.get ? headers.get(name) : "") || "";
  const value = raw.trim();
  return /^[A-Za-z0-9]+$/.test(value) ? value : "";
}

// ── Homes, from 3CX departments ──────────────────────────────────────────
// Every home is a 3CX department named after it, so the department an
// extension or queue belongs to is the home that handled the call. 3CX gives
// CRM templates no department, so it is read from the 3CX Configuration API
// with THREECX_URL, THREECX_CLIENT_ID and THREECX_CLIENT_SECRET.

let homeDirectory = new Map();   // extension or queue number → home name
let homeDirectoryExpiry = 0;
const HOME_DIRECTORY_MS = 60 * 60_000;
const HOME_DIRECTORY_RETRY_MS = 5 * 60_000;

/**
 * Refreshes the extension → home map at most hourly, and no more than every
 * five minutes while 3CX is unreachable. A failed refresh keeps the last map,
 * so home names never vanish because the PBX was briefly unavailable.
 */
async function refreshHomeDirectory(env) {
  if (!env.THREECX_URL || !env.THREECX_CLIENT_ID || !env.THREECX_CLIENT_SECRET) return;
  if (Date.now() < homeDirectoryExpiry) return;
  homeDirectoryExpiry = Date.now() + HOME_DIRECTORY_RETRY_MS;

  try {
    const base = String(env.THREECX_URL).trim().replace(/\/+$/, "");
    const tokenResponse = await fetch(`${base}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.THREECX_CLIENT_ID,
        client_secret: env.THREECX_CLIENT_SECRET,
        grant_type: "client_credentials"
      }).toString()
    });
    if (!tokenResponse.ok) throw new Error(`token request failed (${tokenResponse.status})`);
    const { access_token } = await tokenResponse.json();

    // Tries each form of a request in turn: the API's navigation properties
    // are not all documented, so a rejected $expand falls back to $select.
    const read = async (...paths) => {
      let status = 0;
      for (const path of paths) {
        const response = await fetch(`${base}/xapi/v1/${path}`, { headers: { Authorization: `Bearer ${access_token}` } });
        if (response.ok) return (await response.json()).value || [];
        status = response.status;
      }
      throw new Error(`${paths[0].split("?")[0]} failed (${status})`);
    };

    const departments = await read("Groups?$select=Id,Name,IsDefault");
    const names = new Map(departments.filter(d => d.Name && !d.IsDefault).map(d => [d.Id, d.Name]));

    const directory = new Map();
    for (const collection of ["Users", "Queues"]) {
      const members = await read(`${collection}?$select=Number&$expand=Groups`, `${collection}?$select=Number,Groups`);
      for (const member of members) {
        const home = (member.Groups || []).map(g => names.get(g.GroupId)).find(Boolean);
        if (member.Number && home) directory.set(String(member.Number), home);
      }
    }

    homeDirectory = directory;
    homeDirectoryExpiry = Date.now() + HOME_DIRECTORY_MS;
    console.log(`Read ${directory.size} extensions and queues across ${names.size} 3CX departments.`);
  } catch (error) {
    console.error(`Could not read home names from 3CX, keeping the last known ones: ${error.message}`);
  }
}

/**
 * The home a call was handled through: the tracked queue's department first,
 * since that is the home the enquiry came in on, then the answering
 * extension's. " to " is taken out because 3CX echoes record names into later
 * call descriptions, and the parser reads " to " as the start of the extension.
 */
function homeForCall(env, call, queueExtension) {
  return departmentName(env, call, queueExtension).replace(/\s+to\s+/gi, " ").trim().slice(0, 40);
}

/** The 3CX department a call came through, exactly as 3CX names it. */
function departmentName(env, call, queueExtension) {
  return (departmentFor(env, queueExtension) || departmentFor(env, call.agent)).trim();
}

/**
 * Name for a record created for a tracked enquiry, home first so a list
 * sorted by name groups by home:
 *
 *   First name  Arbour Walk
 *   Last name   Enquiry +447700900321 (15 Sep 10:17)
 *
 * The number is E.164, exactly as stored in Phone and the External ID. The
 * home also goes into SALESFORCE_HOME_FIELD when one is set (see homeFields).
 *
 * Never a name taken from the call. isStillUnregistered recognises the last
 * name, so the reminder stays open until a person replaces it.
 */
function enquiryName(env, call, queueExtension, phone) {
  const home = homeForCall(env, call, queueExtension);
  const through = queueExtension ? (home ? `${home} (queue ${queueExtension})` : `queue ${queueExtension}`) : home;
  return {
    firstName: home || "Phone",
    lastName: `Enquiry ${phone} (${ukDate().replace(/ \d{4}$/, "")} ${call.callTime})`,
    description: /Missed/.test(call.direction || "")
      ? `Missed enquiry${through ? ` through ${through}` : ""}, nobody answered\n${ukDate()} at ${call.callTime}` +
        `\nWorth ringing back.`
      : `New enquiry${through ? ` through ${through}` : ""}\n${ukDate()} at ${call.callTime}`,
    fields: homeFields(env, departmentName(env, call, queueExtension)),
    // Anything staff need to finish by hand, raised as a Task once the call is logged.
    notices: []
  };
}

/** A call described for an alert staff read: the caller's number, and when and where it came in. */
function callSummary(env, call, queueExtension = "") {
  const home = homeForCall(env, call, queueExtension);
  const through = queueExtension ? `${home ? `${home} ` : ""}queue ${queueExtension}, ` : (home ? `${home}, ` : "");
  const who = call.agent && call.agent !== "Unknown" ? `ext ${call.agent}` : "unknown extension";
  return `Caller: ${call.phone || "number not known"}\n` +
    `Call: ${ukDate()} ${call.callTime}, ${directionLabel(call.direction)}, ${through}${who}`;
}

/**
 * Friendly name for the home or team an extension belongs to: the 3CX
 * department when THREECX_URL is configured, otherwise the
 * EXTENSION_DEPARTMENTS variable:
 *
 *   {"0311":"Arbour Walk","03":"Arbour Walk","04":"Bath House"}
 *
 * Exact extension wins, then the longest matching prefix, so a whole range
 * can be mapped in one entry with individual exceptions above it.
 */
function departmentFor(env, agent) {
  if (!agent || agent === "Unknown") return "";
  if (homeDirectory.has(agent)) return homeDirectory.get(agent);
  if (!env.EXTENSION_DEPARTMENTS) return "";

  let map;
  try {
    map = JSON.parse(env.EXTENSION_DEPARTMENTS || "{}");
  } catch (e) {
    console.error("EXTENSION_DEPARTMENTS is not valid JSON — ignoring:", e.message);
    return "";
  }

  if (map[agent]) return String(map[agent]);

  let best = "";
  for (const prefix of Object.keys(map)) {
    if (agent.startsWith(prefix) && prefix.length > best.length) best = prefix;
  }
  return best ? String(map[best]) : "";
}

/**
 * Builds the record's name and any unverified name hint.
 *
 * Names are deliberately NEVER taken from a call. A mis-heard transcription
 * or a stale 3CX phonebook entry produces a record that looks verified but
 * isn't, and nobody re-checks a record that already has a name — whereas
 * "Unregistered Contact +447…" is self-evidently incomplete and invites
 * correction. Any name we spot travels as a hint on the reminder instead,
 * so a human still gets the head start.
 */
function resolveContactName(call, description, env) {
  // Only scan the transcription section, not the summary/sentiment blocks
  const transcription = splitCallSections(description).transcription;
  const transcriptionName = extractNameFromTranscription(transcription || description);

  const hintName = call.threeCxName || transcriptionName || null;
  const hintSource = call.threeCxName ? "3CX phonebook" : (transcriptionName ? "call transcription" : null);

  // Direction/time tag shown in the record name, e.g. "Arbour Walk, Inbound
  // 15:04, Ext 0316". The site comes first because it is what tells a human
  // scanning a list which home the caller reached, which the extension alone
  // does not.
  //
  // Deliberately avoids the word "to": 3CX echoes the display name back into
  // later call descriptions, and a name containing "to Ext 102" would
  // corrupt the description parser.
  const site = departmentFor(env || {}, call.agent);
  const directionTag = `${site ? `${site}, ` : ""}${call.direction} ${call.callTime}, Ext ${call.agent}`;

  return {
    firstName: DEFAULT_FIRST_NAME,
    lastName: `${call.phone} (${directionTag})`,
    hintName,
    hintSource,
    hintLine: hintName ? `Possible caller name mentioned: "${hintName}" (unverified, from ${hintSource})` : null
  };
}

/**
 * A contact still counts as "unregistered" while it carries the markers the
 * worker stamps on auto-created records. Once a human cleans the name up,
 * the markers disappear and reminder maintenance stops.
 */
function isStillUnregistered(contact) {
  const first = contact.FirstName || "";
  const last = contact.LastName || "";
  if (first === DEFAULT_FIRST_NAME) return true;
  if (last.includes("Unsaved")) return true;
  // The name a tracked enquiry is created with: "Enquiry +447700900321 (15 Sep 10:17)".
  if (/^Enquiry\s+[+\d][\d\s]*\(/.test(last)) return true;
  // Older stamps, with or without a site first: "+447… (Arbour Walk, Inbound 15:04, Ext 102)".
  return /\((?:[^()]*,\s*)?(?:Inbound|Outbound)\b/.test(last);
}

/**
 * Resolves the record 3CX journaled against into the object we should
 * actually maintain. A Lead is itself; a Contact id may be the backing
 * contact of a Person Account, in which case the Account is the real record.
 *
 * Returns { objectType, record } or null when nothing usable was found.
 */
async function resolveJournaledRecord(env, instanceUrl, whoId) {
  // sfQuery returns null for a failed query and [] for a genuine miss. The
  // two must not be conflated here: a miss means the record was deleted and
  // there is nothing to maintain, while a failure means maintenance silently
  // did not happen and somebody needs to know.
  const requireQuery = async (soql) => {
    const records = await sfQuery(env, instanceUrl, soql);
    if (records === null) {
      throw new Error(`Salesforce query failed while resolving record ${whoId}`);
    }
    return records;
  };

  if (whoId.startsWith(PREFIX_LEAD)) {
    const records = await requireQuery(`SELECT ${LEAD_FIELDS} FROM Lead WHERE Id = '${whoId}'`);
    return records[0] ? { objectType: "Lead", record: records[0] } : null;
  }

  if (orgModel(env) !== "contact") {
    // Person Accounts are reached through their backing contact id.
    const accounts = await sfQuery(env, instanceUrl,
      `SELECT ${PERSON_ACCOUNT_FIELDS} FROM Account WHERE PersonContactId = '${whoId}'`);
    if (accounts && accounts.length > 0) {
      return { objectType: "Account", record: accounts[0] };
    }

    // Fallback: some orgs reject PersonContactId as a filter. Walk the
    // backing contact's AccountId instead, so a rejected query degrades to a
    // second round trip rather than silently skipping all maintenance.
    const viaContact = await sfQuery(env, instanceUrl,
      `SELECT Id, AccountId, IsPersonAccount FROM Contact WHERE Id = '${whoId}'`);
    const personContact = viaContact && viaContact[0];
    if (personContact && personContact.IsPersonAccount && personContact.AccountId) {
      const byId = await sfQuery(env, instanceUrl,
        `SELECT ${PERSON_ACCOUNT_FIELDS} FROM Account WHERE Id = '${personContact.AccountId}'`);
      if (byId && byId.length > 0) {
        return { objectType: "Account", record: byId[0] };
      }
    }
  }

  const records = await requireQuery(
    `SELECT Id, FirstName, LastName, Phone, Description FROM Contact WHERE Id = '${whoId}'`);
  return records[0] ? { objectType: "Contact", record: records[0] } : null;
}

/**
 * Finds an existing contact for this number. SOQL exact match first
 * (transactionally consistent — no search-index lag), then SOSL as a
 * fallback for manually created contacts with formatted numbers.
 *
 * Returns { record, failed }. failed=true means Salesforce could not be
 * queried reliably, so "not found" cannot be trusted.
 */
async function findContactByPhone(env, instanceUrl, phone) {
  const records = await sfQuery(env, instanceUrl,
    `SELECT Id, FirstName, LastName, Phone, Email, Description FROM Contact WHERE (` +
    `${identityMatchClause(env, ["Phone", "MobilePhone"], phone)}) ` +
    `ORDER BY CreatedDate ASC, Id ASC`);

  if (records && records.length > 0) {
    return { record: records[0], failed: false };
  }

  const soslUrl = `${instanceUrl}${SF_API_PATH}/search/?${new URLSearchParams({
    q: `FIND {${soslPhoneTerm(phone)}} IN PHONE FIELDS RETURNING Contact(Id, FirstName, LastName, Phone, Description)`
  })}`;
  const response = await sfFetch(env, soslUrl);

  if (!response.ok) {
    console.error(`SOSL contact search failed (${response.status}): ${await response.text()}`);
    return { record: null, failed: records === null };
  }

  const data = await response.json();
  if (data.searchRecords && data.searchRecords.length > 0) {
    return { record: data.searchRecords[0], failed: false };
  }

  return { record: null, failed: records === null };
}

/**
 * Creates the contact, then re-queries and keeps only the oldest record for
 * this number. If a concurrent call won the create race, our fresh record
 * (which has no tasks attached yet) is deleted and the winner is used.
 */
async function createContactDeduped(env, instanceUrl, phone, contactBody, notices = null) {
  return createRecordDeduped(env, instanceUrl, "Contact", { ...contactBody, ...extraFields(env, "Contact") },
    `SELECT Id, FirstName, LastName, Phone, Email, Description FROM Contact WHERE (` +
    `${identityMatchClause(env, ["Phone", "MobilePhone"], phone)}) ` +
    `ORDER BY CreatedDate ASC, Id ASC`, phone, notices);
}

/**
 * Consolidation window in minutes. A transferred call reaches Salesforce as
 * several journaling events, one per extension leg, because 3CX records and
 * journals per extension rather than per conversation. Without this, one
 * caller experience becomes three activity records.
 *
 * 3CX exposes no call identifier to CRM templates, so legs can only be
 * correlated by caller plus timing. Set CALL_MERGE_WINDOW_MINUTES to 0 to
 * turn consolidation off and log every leg separately.
 */
function callMergeWindow(env) {
  const minutes = Number(env.CALL_MERGE_WINDOW_MINUTES ?? "5");
  return isNaN(minutes) || minutes < 0 ? 5 : minutes;
}

/**
 * Finds a call log for this caller recent enough to be the same
 * conversation. Deliberately biased towards merging: a wrongly merged pair
 * still shows both legs clearly separated in one record, whereas a wrongly
 * split conversation scatters the history across several.
 *
 * 3CX journals a leg when that leg *ends*, so the gap between the two task
 * creation times is the length of the second leg plus the handover. A ten
 * minute conversation after transfer would therefore fall outside a five
 * minute window and split in two. The incoming leg's own duration is added
 * to the window so it measures the handover gap, not the conversation.
 */
async function findRecentCallTask(env, instanceUrl, whoId, windowMinutes, legSeconds = 0) {
  const spanMs = windowMinutes * 60_000 + Math.max(0, legSeconds) * 1000;
  const since = new Date(Date.now() - spanMs).toISOString();
  // Measured from the last leg merged in (LastModifiedDate), not the first
  // leg's creation, so a third leg still joins a call whose middle leg ran
  // long. Only call logs the Worker created: a call someone logged by hand
  // is theirs, and must not be rewritten with a 3CX leg.
  const records = await sfQuery(env, instanceUrl,
    `SELECT Id, Subject, Description, CallDurationInSeconds FROM Task ` +
    `WHERE WhoId = '${whoId}' AND TaskSubtype = 'Call'${createdByWorker()} AND LastModifiedDate >= ${since} ` +
    `ORDER BY LastModifiedDate DESC LIMIT 1`);
  return records && records.length > 0 ? records[0] : null;
}

/** SOQL condition limiting a Task query to ones the integration user created, when its id is known. */
function createdByWorker() {
  return cachedUserId ? ` AND CreatedById = '${cachedUserId}'` : "";
}

/**
 * Appends this leg to the existing call log instead of creating a second
 * one. Returns the task id it merged into, or null if there was nothing to
 * merge with.
 */
async function mergeIntoRecentCallTask(env, instanceUrl, whoId, taskBody, call) {
  const windowMinutes = callMergeWindow(env);
  if (windowMinutes === 0) return null;

  const legSeconds = Number(taskBody.CallDurationInSeconds || 0) || 0;
  const prior = await findRecentCallTask(env, instanceUrl, whoId, windowMinutes, legSeconds);
  if (!prior) return null;

  const home = departmentFor(env, call.agent);
  const who = call.agent && call.agent !== "Unknown" ? `ext ${call.agent}${home ? `, ${home}` : ""}` : "another extension";
  const legDuration = formatDuration(durationSeconds(call.duration));

  const update = {
    Description: truncateForSalesforce(
      `${prior.Description || ""}\n\nThen ${who} at ${call.callTime}${legDuration ? `, ${legDuration}` : ""}\n${taskBody.Description || ""}`),
    CallDurationInSeconds:
      Number(prior.CallDurationInSeconds || 0) + Number(taskBody.CallDurationInSeconds || 0)
  };

  const response = await sfFetch(env, `${instanceUrl}${SF_API_PATH}/sobjects/Task/${prior.Id}`, {
    method: "PATCH",
    body: JSON.stringify(update)
  });

  if (!response.ok) {
    console.error(`Could not merge call leg into task ${prior.Id}: ${response.status}`);
    return null;
  }

  console.log(`Merged transferred leg into existing call log ${prior.Id}`);
  return prior.Id;
}

/**
 * Makes a failure visible to Cedar Care's own staff, as a high priority
 * Salesforce Task for whoever took the call (or the fallback owner): on the
 * caller's record when there is one, or on its own when the problem is that
 * there is no record to put it on.
 *
 * `alert` shapes it: `subject`, `guidance` (what to do about it), `detail`
 * (what happened, for the Task; defaults to the error message) and
 * `unlinked` (raise it even with no record).
 *
 * ALERT_WEBHOOK_URL, when set, also gets the error message. It is optional,
 * for whoever maintains the integration, and the only signal left when
 * Salesforce itself is down. Both are best-effort: an alert that throws must
 * never mask the original error.
 */
async function reportMaintenanceFailure(env, instanceUrl, whoId, error, ownerId = null, alert = {}) {
  const subject = alert.subject || FAILURE_SUBJECT;
  const stamp = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
  const detail = `${stamp} (UK Time), Salesforce record ${whoId || "(unlinked)"}: ${error.message || error}`;

  if (env.ALERT_WEBHOOK_URL) {
    try {
      await fetch(env.ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `${subject} — ${detail}`, whoId, error: `${error.message || error}` })
      });
    } catch (e) {
      console.error("Alert webhook failed:", e.message);
    }
  }

  if (!whoId && !alert.unlinked) return;

  try {
    const guidance = alert.guidance ||
      `The call log itself was saved, with what was said on it. What may be missing is ` +
      `this call in the record's call history, the caller reminder, or both. Check the ` +
      `call activity for this number and follow it up by hand.`;
    const taskDetail = `${stamp} (UK Time)\n${alert.detail || (error.message || error)}`;

    // One open alert of each kind per record. Repeated failures on the same
    // caller are added to the existing alert rather than stacking a queue of
    // identical ones, so every affected call can still be traced.
    if (whoId) {
      const open = await sfQuery(env, instanceUrl,
        `SELECT Id, Description FROM Task WHERE WhoId = '${whoId}' AND IsClosed = false ` +
        `AND Subject = '${subject.replace(/'/g, "\\'")}' LIMIT 1`);
      if (open && open.length > 0) {
        await sfFetch(env, `${instanceUrl}${SF_API_PATH}/sobjects/Task/${open[0].Id}`, {
          method: "PATCH",
          body: JSON.stringify({ Description: truncateForSalesforce(`${open[0].Description || guidance}\n\nAlso: ${taskDetail}`) })
        });
        return;
      }
    }

    const task = {
      Subject: subject,
      Description: truncateForSalesforce(`${taskDetail}\n\n${guidance}`),
      Status: "Not Started",
      Priority: "High",
      TaskSubtype: "Task",
      ActivityDate: ukToday()
    };
    if (whoId) task.WhoId = whoId;
    // With the person who took the call, not the integration user nobody reads.
    if (ownerId) task.OwnerId = ownerId;

    const raised = await insertTask(env, instanceUrl, task);

    // During a full Salesforce outage this attempt fails too. Say so, so the
    // logs don't imply an alert is waiting for someone when none exists.
    if (!raised.ok) {
      console.error(`Could not raise the Salesforce alert task (${raised.status}). ` +
        `This failure is visible only in these logs${env.ALERT_WEBHOOK_URL ? " and the webhook" : ""}.`);
    }
  } catch (e) {
    console.error("Could not raise a Salesforce alert for the failure:", e.message);
  }
}

/**
 * Who owns a call log, and the reminder or error alert that follows it, when
 * 3CX found no active Salesforce user with the answering extension's email.
 * Left alone they belong to the integration user, where they appear in nobody's
 * task list.
 *
 * SALESFORCE_FALLBACK_OWNER is a User Id or username, or a queue Id or API
 * name for a queue that supports Tasks. It is checked against Salesforce at
 * most hourly, so an owner who is deactivated, or a queue that stops taking
 * Tasks, is set aside rather than failing every call log.
 */
async function fallbackOwnerId(env, instanceUrl) {
  const setting = String(env.SALESFORCE_FALLBACK_OWNER || "").trim();
  if (!setting) return null;
  const now = Date.now();
  if (fallbackOwnerCache.setting === setting && now < fallbackOwnerCache.expiry) return fallbackOwnerCache.id;

  // A Standard user: an active Chatter Free or portal user cannot own Tasks.
  let soql = null;
  if (/^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(setting)) {
    soql = `SELECT Id FROM User WHERE Id = '${setting}' AND IsActive = true AND UserType = 'Standard' LIMIT 1`;
  } else if (/^00G[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(setting)) {
    soql = `SELECT QueueId FROM QueueSobject WHERE QueueId = '${setting}' AND SobjectType = 'Task' LIMIT 1`;
  } else if (/^[^\s'\\@]+@[^\s'\\@]+$/.test(setting)) {
    soql = `SELECT Id FROM User WHERE Username = '${setting}' AND IsActive = true AND UserType = 'Standard' LIMIT 1`;
  } else if (/^[A-Za-z][A-Za-z0-9_]*$/.test(setting)) {
    soql = `SELECT QueueId FROM QueueSobject WHERE Queue.DeveloperName = '${setting}' AND SobjectType = 'Task' LIMIT 1`;
  }

  if (!soql) {
    console.error("SALESFORCE_FALLBACK_OWNER must be a User Id, a username, or a queue Id or API name. Ignoring it.");
    fallbackOwnerCache = { setting, id: null, expiry: now + FALLBACK_OWNER_MS };
    return null;
  }

  const records = await sfQuery(env, instanceUrl, soql);
  if (records === null) {
    // Not refused, just unknown for now. Keep whatever was last confirmed.
    const known = fallbackOwnerCache.setting === setting ? fallbackOwnerCache.id : null;
    fallbackOwnerCache = { setting, id: known, expiry: now + FALLBACK_OWNER_RETRY_MS };
    return known;
  }

  const id = records[0] ? (records[0].Id || records[0].QueueId) : null;
  if (!id) {
    console.error(`SALESFORCE_FALLBACK_OWNER "${setting}" is not an active user or a queue that takes Tasks, ` +
      `so call logs with no matching user stay with the integration user.`);
  }
  fallbackOwnerCache = { setting, id, expiry: now + FALLBACK_OWNER_MS };
  return id;
}

/**
 * Sets aside a fallback owner Salesforce refused on a Task, for as long as a
 * confirmed one is trusted. Its check can pass while the insert still fails
 * (a Task validation rule on the owner, say), and re-checking would only
 * repeat the refusal on every call.
 */
function setAsideFallbackOwner(env, instanceUrl, refusedId, reason) {
  if (!refusedId || fallbackOwnerCache.id !== refusedId) return;
  fallbackOwnerCache = { ...fallbackOwnerCache, id: null, expiry: Date.now() + FALLBACK_OWNER_MS };
  queueReport(env, instanceUrl,
    `Salesforce refused SALESFORCE_FALLBACK_OWNER ${refusedId} as a Task owner, so it is set aside for an hour: ${reason.slice(0, 300)}`);
}

/** True when Salesforce refused a Task insert because of its owner. */
function isOwnerRefusal(status, errorText) {
  return status === 400 && /OwnerId|INACTIVE_OWNER_OR_USER/.test(errorText);
}

/**
 * Inserts a reminder or error alert. An owner Salesforce will not take (one
 * deactivated since, a licence that cannot own Tasks) costs the owner, not
 * the Task: it is saved again with the integration user.
 */
async function insertTask(env, instanceUrl, body) {
  const url = `${instanceUrl}${SF_API_PATH}/sobjects/Task`;
  const response = await sfFetch(env, url, { method: "POST", body: JSON.stringify(body) });
  if (response.ok || !body.OwnerId) return response;

  const errorText = await response.clone().text();
  if (!isOwnerRefusal(response.status, errorText)) return response;

  console.error(`Salesforce refused owner ${body.OwnerId} on a Task, so it is saved with the integration user: ${errorText.slice(0, 300)}`);
  setAsideFallbackOwner(env, instanceUrl, body.OwnerId, errorText);
  const { OwnerId, ...withoutOwner } = body;
  return sfFetch(env, url, { method: "POST", body: JSON.stringify(withoutOwner) });
}

// Bounds how many reminders one call closes, so a record carrying a pile of
// old ones cannot exhaust the Worker's time or subrequests.
const MAX_REMINDERS_CLOSED = 20;

async function findOpenAlertTasks(env, instanceUrl, contactId) {
  // Only reminders the Worker raised: a task a person or a Flow created with
  // the same "Action Required:" wording is left alone.
  return sfQuery(env, instanceUrl,
    `SELECT Id, Description FROM Task WHERE WhoId = '${contactId}' AND Status <> 'Completed'${createdByWorker()} ` +
    `AND Subject LIKE '${ALERT_SUBJECT_PREFIX}%' ORDER BY CreatedDate ASC, Id ASC`);
}

async function closeOpenReminders(env, instanceUrl, contactId) {
  const openAlerts = await findOpenAlertTasks(env, instanceUrl, contactId);
  for (const alert of (openAlerts || []).slice(0, MAX_REMINDERS_CLOSED)) {
    await sfWrite(env, `${instanceUrl}${SF_API_PATH}/sobjects/Task/${alert.Id}`, {
      method: "PATCH",
      body: JSON.stringify({ Status: "Completed" })
    });
  }
}

// ── Record call history ──────────────────────────────────────────────────
// A record's Description carries its calls, newest first, between two marker
// lines. Only that section is ever rewritten, so anything a person types
// elsewhere in the Description stays as they left it, and when the field
// fills up the oldest calls are dropped rather than their notes.
//
// The history says when, which way, how long, who took the call and where the
// recording is. What was said (transcript, summary, sentiment) and any name
// heard on the call stay on the call log, a Task. An org that deletes call
// logs after a retention period then deletes the words with them, instead of
// a copy living on in the record for as long as the record does.

const HISTORY_START = "--- 3CX call history, newest first ---";
const HISTORY_END = "--- end of call history ---";
const HISTORY_HEADLINE = /^\d{1,2} [A-Z][a-z]{2} \d{4} \d{1,2}:\d{2} · /;
// The one content line an entry keeps: "Recording: …", or
// "Recording (ext 102): …" once a transferred call has two.
const HISTORY_RECORDING = /^Recording(?: \([^)]*\))?: \S+$/;

/** "00:09:42", "9:42" or "1:02:03" as seconds, or null when there is no duration. */
function durationSeconds(text) {
  const parts = String(text || "").trim().split(":");
  if (parts.length < 2 || parts.some(p => !/^\d+$/.test(p))) return null;
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

/** Seconds as "9:42", or "1:02:03" once past the hour. */
function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function directionLabel(direction) {
  return { "Inbound Missed": "Missed", "Outbound Unanswered": "Unanswered outbound" }[direction] || direction || "Call";
}

/**
 * One leg of a call, ready to start a history entry or join the latest one:
 * where it went, how long it took, and its recording link.
 *
 * 3CX's raw line is deliberately not used. It repeats the number and then the
 * matched record's display name, so a caller's own name would be nested in
 * their own history. Everything worth keeping is parsed out instead, and
 * empty sections are dropped.
 */
function callLeg(env, routing, call, description) {
  const home = departmentFor(env, call.agent);
  const known = Boolean(call.agent) && call.agent !== "Unknown";
  const kind = matchesExtension(routing.queues, call.agent) ? "queue"
    : matchesExtension(routing.menus, call.agent) ? "menu" : "person";

  const short = !known ? "3CX"
    : kind === "person" ? `ext ${call.agent}`
    : `${home ? `${home} ` : ""}${kind} ${call.agent}`;

  const verb = {
    Inbound: "Answered by", "Inbound Missed": "Missed at", Outbound: "Made by", "Outbound Unanswered": "Made by"
  }[call.direction] || "Handled by";

  const seconds = durationSeconds(call.duration);
  // A link is one line. Anything longer under the heading is not a link.
  const recording = splitCallSections(description).recording;
  const content = /^\S+$/.test(recording) ? [["Recording", recording]] : [];

  return {
    home,
    short,
    seconds,
    headline: `${ukDate()} ${call.callTime} · ${directionLabel(call.direction)}` +
      (seconds !== null ? ` · ${formatDuration(seconds)}` : ""),
    route: kind === "person" && known ? `${verb} ${short}${home ? `, ${home}` : ""}` : short,
    content
  };
}

function entryLines(leg) {
  const lines = [leg.headline, leg.route];
  for (const [label, text] of leg.content) lines.push(`${label}: ${text}`);
  return lines;
}

/**
 * Folds a transferred leg into the latest entry: the durations add up, the
 * route gains ", then …", and the recording link is added, labelled with the
 * extension once the entry already holds another leg's.
 */
function joinLeg(lines, leg) {
  const segments = lines[0].split(" · ");
  const soFar = segments.length > 2 ? durationSeconds(segments[segments.length - 1]) : null;
  if (soFar !== null) segments.pop();
  if (soFar !== null || leg.seconds !== null) segments.push(formatDuration((soFar || 0) + (leg.seconds || 0)));
  lines[0] = segments.join(" · ");

  let route = lines[1] || "";
  if (!route.includes(", then ") && soFar !== null) route += ` (${formatDuration(soFar)})`;
  const where = leg.short.startsWith("ext ") && leg.home && !route.includes(leg.home) ? `, ${leg.home}` : "";
  route += `, then ${leg.short}${where}${leg.seconds !== null ? ` (${formatDuration(leg.seconds)})` : ""}`;
  lines[1] = route;

  const hasContent = lines.length > 2;
  for (const [label, text] of leg.content) {
    lines.push(hasContent ? `${label} (${leg.short}): ${text}` : `${label}: ${text}`);
  }
}

/**
 * A Description split around its call history: the text before and after
 * the marker lines, and the entries between them, each cut back to what the
 * history keeps. `trimmed` says whether anything had to be cut, which only
 * happens to entries written while the history still held what was said.
 */
function readCallHistory(existing) {
  const text = String(existing || "");
  const start = text.indexOf(HISTORY_START);
  const end = start === -1 ? -1 : text.indexOf(HISTORY_END, start);
  let before, body = "", after;

  if (start !== -1 && end !== -1) {
    before = text.slice(0, start);
    body = text.slice(start + HISTORY_START.length, end);
    after = text.slice(end + HISTORY_END.length);
  } else if (/^(New enquiry|Created when this number rang|Auto-created from the 3CX phone system)/.test(text)) {
    // The opening lines stay above the history, and older text below it.
    const gap = text.indexOf("\n\n");
    before = gap === -1 ? `${text}\n\n` : text.slice(0, gap + 2);
    after = gap === -1 ? "" : `\n\n${text.slice(gap + 2)}`;
  } else {
    before = "";
    after = text.trim() ? `\n\n${text}` : "";
  }

  // Line endings are evened out first: a Description saved through a tool
  // that writes CRLF would otherwise fail every line test below.
  const entries = [];
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (HISTORY_HEADLINE.test(line)) entries.push([line]);
    else if (entries.length > 0) entries[entries.length - 1].push(line);
  }

  let trimmed = false;
  for (const [i, entry] of entries.entries()) {
    const kept = entry.filter((line, n) => n < 2 || HISTORY_RECORDING.test(line));
    while (kept.length > 1 && !kept[kept.length - 1].trim()) kept.pop();
    if (entry.some((line, n) => n >= 2 && line.trim() && !HISTORY_RECORDING.test(line))) trimmed = true;
    entries[i] = kept;
  }

  return { found: start !== -1 && end !== -1, before, after, entries, trimmed };
}

/** The Description rebuilt from readCallHistory's parts, dropping the oldest calls to fit. */
function buildCallHistory({ before, after, entries }) {
  const build = () =>
    `${before}${HISTORY_START}\n\n${entries.map(e => e.join("\n")).join("\n\n")}\n\n${HISTORY_END}${after}`;
  let result = build();
  while (result.length > SF_TEXT_LIMIT && entries.length > 1) {
    entries.pop();
    result = build();
  }
  return result.length > SF_TEXT_LIMIT ? truncateForSalesforce(result) : result;
}

/**
 * The record's Description with this leg written into its call history.
 * A leg merged into the latest call log joins the latest entry, provided that
 * entry is from today; anything else starts a new entry at the top.
 */
function writeCallHistory(existing, leg, continuation) {
  const history = readCallHistory(existing);
  const { entries } = history;

  if (continuation && entries.length > 0 && entries[0][0].startsWith(`${ukDate()} `)) {
    joinLeg(entries[0], leg);
  } else {
    entries.unshift(entryLines(leg));
  }
  return buildCallHistory(history);
}

/**
 * The Description with its call history cut back to headline, route and
 * recording, or null when there was nothing to cut. Applied to a record
 * someone has already named, which no longer gets new entries, so a
 * transcript written into its history by an earlier version does not stay on
 * it for as long as the record exists.
 */
function trimmedCallHistory(existing) {
  const history = readCallHistory(existing);
  return history.found && history.trimmed ? buildCallHistory(history) : null;
}

async function appendCallToRecord(env, routing, instanceUrl, objectType, record, call, description, continuation = false) {
  const leg = callLeg(env, routing, call, description);
  await sfWrite(env, `${instanceUrl}${SF_API_PATH}/sobjects/${objectType}/${record.Id}`, {
    method: "PATCH",
    body: JSON.stringify({ Description: writeCallHistory(record.Description, leg, continuation) })
  });
}

/** The caller's number, wherever this object type keeps it. */
function recordPhone(record) {
  return (record.Phone || record.PersonMobilePhone || record.MobilePhone ||
          record.PersonHomePhone || record.PersonOtherPhone || "").replace(/[^0-9+]/g, "");
}

/**
 * Post-journaling maintenance for tasks 3CX linked to a real record (the
 * normal path now that records are created at ring time). Runs via
 * ctx.waitUntil so 3CX isn't kept waiting.
 *  - Registered caller  → auto-complete leftover reminder tasks.
 *  - Still unregistered → stamp the name, add the call to the record's
 *    history, and upsert the open reminder (which carries any name heard)
 *    instead of stacking a new one.
 *
 * `whoId` is what the task was linked to (a Lead, or a Person Account's
 * backing contact); `record` is the object we actually update, which for a
 * Person Account is the Account itself.
 */
async function maintainJournaledRecord(env, routing, instanceUrl, whoId, taskBody, agent = "", continuation = false) {
  try {
    const resolved = await resolveJournaledRecord(env, instanceUrl, whoId);
    if (!resolved) return;

    const { objectType, record } = resolved;

    if (!isStillUnregistered(record)) {
      console.log(`${objectType} ${record.Id} already has real details — closing any open reminders.`);
      await closeOpenReminders(env, instanceUrl, whoId);
      const trimmed = trimmedCallHistory(record.Description);
      if (trimmed !== null) {
        await sfWrite(env, `${instanceUrl}${SF_API_PATH}/sobjects/${objectType}/${record.Id}`, {
          method: "PATCH",
          body: JSON.stringify({ Description: trimmed })
        });
      }
      return;
    }

    console.log(`Maintaining ${objectType} ${record.Id}: appending call and upserting reminder.`);

    const description = taskBody.Description || "";
    const call = parseCallDetails(description);
    if (agent) call.agent = agent;
    if (!call.phone) {
      call.phone = recordPhone(record);
    }

    const nameInfo = resolveContactName(call, description, env);
    const recordUrl = `${instanceUrl}${SF_API_PATH}/sobjects/${objectType}/${record.Id}`;

    // Ring-time records are created before the direction/extension are
    // known. Stamp the first completed call's details onto the name, e.g.
    // "+447700900654 (Arbour Walk, Inbound 15:04, Ext 102)". Names are never
    // taken from the call itself — see resolveContactName.
    //
    // Routing legs are skipped. A call greeted by an auto attendant journals
    // that leg first, so stamping it would label the record with the menu
    // rather than whoever dealt with the caller. Leaving the name as the
    // bare number keeps the record eligible, and the next leg — the human
    // one — stamps it instead.
    // The three writes are independent. A rename Salesforce refuses must not
    // stop the transcript reaching the record or the reminder being raised,
    // so each is attempted and every failure is reported together.
    const failures = [];
    const attempt = async (step) => {
      try { await step(); } catch (error) { failures.push(error.message || String(error)); }
    };

    if (record.FirstName === DEFAULT_FIRST_NAME &&
        !isRoutingExtension(routing, call.agent) &&
        (record.LastName === call.phone || record.LastName === recordPhone(record))) {
      await attempt(() => sfWrite(env, recordUrl, {
        method: "PATCH",
        body: JSON.stringify({ LastName: nameInfo.lastName })
      }));
    }

    if (keepsHistory(env, objectType)) {
      await attempt(() => appendCallToRecord(env, routing, instanceUrl, objectType, record, call, description, continuation));
    } else {
      console.log(`Call history is switched off for ${objectType}s in the 3CX template, so the call log alone records this call.`);
    }
    await attempt(() => upsertAlertTask(env, instanceUrl, whoId, record, objectType, call, nameInfo, taskBody.OwnerId, routing, continuation));

    if (failures.length > 0) throw new Error(failures.join("; "));
  } catch (error) {
    console.error("Record/alert maintenance failed:", error);
    await reportMaintenanceFailure(env, instanceUrl, whoId, error, taskBody.OwnerId);
  }
}

/** Adds a call to the top of a reminder's "Calls:" list, starting one on an older reminder. */
function addReminderCall(description, callLine, joinAs = null) {
  const text = description || "";
  const marker = "\nCalls:\n";
  const at = text.indexOf(marker);
  if (at === -1) return `${text}\n\nCalls:\n${callLine}`;

  // A transferred leg extends today's top line instead of listing the same
  // call twice.
  const listStart = at + marker.length;
  const lineEnd = text.indexOf("\n", listStart);
  const top = text.slice(listStart, lineEnd === -1 ? text.length : lineEnd);
  if (joinAs && top.startsWith(`${ukDate()} `)) {
    const hint = callLine.includes("\n") ? callLine.slice(callLine.indexOf("\n")) : "";
    return `${text.slice(0, listStart)}${top}, then ${joinAs}${hint}${lineEnd === -1 ? "" : text.slice(lineEnd)}`;
  }
  return `${text.slice(0, listStart)}${callLine}\n${text.slice(listStart)}`;
}

/**
 * Creates or updates the single open "Action Required" reminder for a
 * caller. `whoId` is what the reminder links to (Lead, or a Person
 * Account's backing contact); `record`/`objectType` describe what a human
 * needs to go and fix.
 */
async function upsertAlertTask(env, instanceUrl, whoId, record, objectType, call, nameInfo, ownerId,
                               routing = { queues: [], menus: [] }, continuation = false) {
  if (remindersOff(env)) return;

  // A menu or queue leg is not a call anyone took: the person who answers
  // next raises or updates the reminder. A missed call is the exception, and
  // the case that most needs one: it is journaled against the queue precisely
  // because nobody picked it up, and somebody should ring back.
  if (isRoutingExtension(routing, call.agent) && !/Missed/.test(call.direction || "")) return;

  const today = ukToday();
  const home = departmentFor(env, call.agent);
  const callLine = `${ukDate()} ${call.callTime} · ${directionLabel(call.direction)} · ext ${call.agent}${home ? `, ${home}` : ""}` +
    (nameInfo.hintLine ? `\n${nameInfo.hintLine}` : "");
  const openAlerts = await findOpenAlertTasks(env, instanceUrl, whoId);
  const noun = objectType === "Lead" ? "Lead" : "Contact";

  // Query failed — creating blindly could stack duplicates, so skip.
  if (openAlerts === null) return;

  if (openAlerts.length > 0) {
    // Update the existing reminder instead of stacking a new one.
    const alert = openAlerts[0];
    const update = {
      Description: truncateForSalesforce(addReminderCall(alert.Description, callLine,
        continuation ? `ext ${call.agent}${home ? `, ${home}` : ""}` : null)),
      ActivityDate: today,
      Priority: "High"
    };
    await sfWrite(env, `${instanceUrl}${SF_API_PATH}/sobjects/Task/${alert.Id}`, {
      method: "PATCH",
      body: JSON.stringify(update)
    });

    // Self-heal: complete any extra reminders left over from older versions.
    for (const extra of openAlerts.slice(1, 1 + MAX_REMINDERS_CLOSED)) {
      await sfWrite(env, `${instanceUrl}${SF_API_PATH}/sobjects/Task/${extra.Id}`, {
        method: "PATCH",
        body: JSON.stringify({ Status: "Completed" })
      });
    }
    return;
  }

  // No open reminder — create one.
  const nextStep = objectType === "Lead"
    ? `Please review the call transcription in the Lead's activity history, fill in their real name and details, and convert the Lead once qualified.`
    : `Please review the call transcription in the record's activity history, fill in their real name, and complete the remaining details.`;

  const alertBody = {
    WhoId: whoId,
    Subject: `${ALERT_SUBJECT_PREFIX} Fill in details for Unregistered ${noun} ${call.phone}`,
    Description: `Caller: ${call.phone}\n` +
      `Record: ${`${record.FirstName || ""} ${record.LastName || ""}`.trim()}\n\n` +
      `${nextStep}` +
      (nameInfo.hintLine ? ` Any name mentioned on a call is unverified, so please confirm it with the caller.` : "") +
      `\n\nCalls:\n${callLine}`,
    Status: "Not Started", // Open
    Priority: "High",      // High priority alert
    TaskSubtype: "Task",
    ActivityDate: today
  };

  if (ownerId) {
    alertBody.OwnerId = ownerId;
  }

  const created = await insertTask(env, instanceUrl, alertBody);
  if (!created.ok) {
    throw new Error(`POST /sobjects/Task failed (${created.status}): ${(await created.text()).slice(0, 300)}`);
  }

  const alertId = (await created.json()).id;

  // Convergence: two simultaneous calls can both create a reminder before
  // either query sees the other's. Keep the oldest, delete ours.
  const nowOpen = await findOpenAlertTasks(env, instanceUrl, whoId);
  if (nowOpen && nowOpen.length > 1 && nowOpen[0].Id !== alertId) {
    await sfFetch(env, `${instanceUrl}${SF_API_PATH}/sobjects/Task/${alertId}`, { method: "DELETE" });
  }
}

/**
 * Applies Tracked Queues to a journaled call. Returns { drop, reason }, and
 * points taskBody.WhoId at the real record when one is found or created.
 *
 * An unknown caller arrives with the stand-in id from the lookup. A record is
 * created for them only when a person answered through a tracked queue; any
 * other route drops the call, since there is nobody in Salesforce to log it
 * against. Salesforce failing on a tracked call logs it unlinked instead, so
 * an enquiry is never lost to an outage.
 */
async function applyTrackedQueueGate(env, instanceUrl, taskBody, call, gate) {
  if (!isPendingCallerId(taskBody.WhoId)) {
    return keepExistingRecordCall(env, instanceUrl, taskBody, gate, "existing record");
  }

  const digits = taskBody.WhoId.slice(PENDING_PREFIX.length);
  delete taskBody.WhoId;
  const phone = normalizePhone(digits || call.phone || "").replace(/[^0-9+]/g, "");
  if (!/[0-9]{4,}/.test(phone)) {
    return { drop: true, reason: "stand-in with no usable number, dropped" };
  }

  const names = enquiryName(env, call, gate.queue, phone);
  const { target, failed, created } = await locateRecord(env, instanceUrl, phone, gate.create, names);

  if (target && target.whoId) {
    taskBody.WhoId = target.whoId;
    if (created) return { reason: `created ${target.objectType} ${target.recordId}`, notices: names.notices };
    // A record appeared since the phone rang: an earlier leg of this call
    // created it, or someone entered it. Either way it is now existing.
    return keepExistingRecordCall(env, instanceUrl, taskBody, gate, "record found at journaling");
  }

  if (failed && gate.viaQueue) {
    return {
      reason: "Salesforce failed on a tracked call, logging it unlinked",
      alert: {
        // The webhook gets a masked number; the Task, inside Salesforce, the whole one.
        message: `An enquiry from ${maskPhone(phone)} through queue ${gate.queue || call.agent} at ${call.callTime} could not be ` +
          `given a Salesforce record, so its call log was saved without one. The Worker logs give Salesforce's reason.`,
        detail: [callSummary(env, { ...call, phone }, gate.queue), ...names.notices].join("\n\n"),
        guidance: `This enquiry's call log is saved in Salesforce, but not linked to anyone, because no record could be ` +
          `found or created for the caller. Search for the number above, find or create their record, and link the ` +
          `call log to it. If this keeps happening, tell your Salesforce admin.`
      }
    };
  }
  return {
    drop: true,
    reason: failed
      ? "Salesforce failed and the call was not through a tracked queue, dropped"
      : "unknown caller not answered through a tracked queue, dropped"
  };
}

/**
 * Whether a call for someone who already has a record is logged.
 *
 * Always Log Existing Records on (the default) logs it whatever the route.
 * Off, only calls through a tracked queue are logged, plus a later leg of a
 * call that was: a transfer out of the enquiries queue arrives without the
 * queue, but the first leg's log from the last few minutes marks it as the
 * same conversation, and the merge then folds it in.
 */
async function keepExistingRecordCall(env, instanceUrl, taskBody, gate, what) {
  if (gate.logExisting) return { reason: `${what}, always logged` };
  if (gate.viaQueue) return { reason: `${what}, through a tracked queue` };

  const windowMinutes = callMergeWindow(env);
  const whoId = taskBody.WhoId || "";
  if (windowMinutes > 0 && whoId) {
    const legSeconds = Number(taskBody.CallDurationInSeconds || 0) || 0;
    const prior = await findRecentCallTask(env, instanceUrl, whoId, windowMinutes, legSeconds);
    if (prior) return { reason: `${what}, continuing a tracked call` };
  }
  return { drop: true, reason: `${what}, not through a tracked queue, dropped` };
}

/**
 * Proxies task creation (call journaling).
 *
 * 3CX journals against the id the lookup returned: a real record, or with
 * Tracked Queues set, a stand-in for an unknown caller that is resolved here
 * (see applyTrackedQueueGate). The task is forwarded and record maintenance
 * (call history, reminder upsert) runs in the background.
 */
async function handleTaskProxy(env, ctx, targetUrl, forwardHeaders, request) {
  const requestBodyText = await request.text();
  let taskBody;

  try {
    taskBody = JSON.parse(requestBodyText);
  } catch (e) {
    // The template always sends JSON. Anything else cannot be filtered or
    // redacted, so it is refused rather than forwarded as it is.
    console.error("Refused a call log that was not JSON.");
    return jsonResponse({ error: "Bad Request", message: "Call log body must be JSON." }, 400);
  }

  const forwardTask = () => forwardWithAuthRetry(env, targetUrl, {
    method: "POST",
    headers: forwardHeaders,
    body: JSON.stringify(taskBody)
  });

  const instanceUrl = new URL(targetUrl).origin;
  await refreshHomeDirectory(env);

  const call = parseCallDetails(taskBody.Description || "");
  // [Agent] is documented for call journaling, so it is preferred to the
  // extension read from the description whenever 3CX supplies it.
  const headerAgent = extensionFromHeader(request.headers, "X-Agent-Extension");
  if (headerAgent) call.agent = headerAgent;

  // ── Call filtering ───────────────────────────────────────────────────
  // The ring-time lookup already suppresses journaling for filtered
  // numbers (3CX skips CreateCallActivity when nothing matched), but a
  // number already saved in Salesforce — a sister site's DDI, say —
  // matches legitimately and still arrives here. Dropping the task returns
  // a success shape so 3CX doesn't treat it as an error or retry.
  if (!shouldJournalDirection(call.direction, request.headers)) {
    console.log(`Journaling disabled for ${call.direction} — call log dropped.`);
    return jsonResponse({ success: true, errors: [], filtered: "direction" }, 201);
  }

  if (call.phone && isFilteredNumber(call.phone, request.headers)) {
    console.log(`Filtered number ${maskPhone(call.phone)} — call log dropped.`);
    return jsonResponse({ success: true, errors: [], filtered: "number" }, 201);
  }

  if (tooShortToLog(request.headers, call, taskBody)) {
    console.log(`Call from ${maskPhone(call.phone || "")} was shorter than the template's minimum — call log dropped.`);
    return jsonResponse({ success: true, errors: [], filtered: "duration" }, 201);
  }

  // Before Tracked Queues, so an excluded extension never creates a record
  // either. The lookup has no extension to check, so this is the only point
  // an exclusion can apply.
  const queueExtension = extensionFromHeader(request.headers, "X-Queue-Extension");
  diag(env, templateSettings(env, request.headers));
  diag(env, `call log: ${maskPhone(call.phone || "unknown")} ${call.direction}, queue ${queueExtension || "none"}, ` +
    `agent ${call.agent}, duration ${call.duration || "none"}, ` +
    // The stand-in id carries the caller's number, so it is never printed raw.
    `linked to ${isPendingCallerId(taskBody.WhoId) ? "a new caller stand-in" : (taskBody.WhoId || "nothing")}`);
  if (isExcludedExtension(request.headers, call.agent, queueExtension)) {
    console.log(`Extension ${call.agent} (queue ${queueExtension || "none"}) is excluded — call log dropped.`);
    return jsonResponse({ success: true, errors: [], filtered: "extension" }, 201);
  }

  // Redact before anything is stored or mined for names: if the transcript
  // is withheld by policy, it must not reach the contact record either.
  if (taskBody.Description) {
    taskBody.Description = applyTranscriptPolicy(taskBody.Description, call.direction, request.headers);

    // Per-extension confidentiality is stricter than the global policy and
    // is applied after it, so whichever removes more content wins.
    if (isConfidentialExtension(request.headers, call.agent)) {
      console.log(`Extension ${call.agent} is confidential — logging the call without its content.`);
      taskBody.Description = redactCallContent(taskBody.Description);
    }

    if (/^false$/i.test((request.headers.get("X-Store-Recording") || "True").trim())) {
      taskBody.Description = withoutRecording(taskBody.Description);
    }

    taskBody.Description = truncateCallLog(taskBody.Description);
  }

  // Tracked queues: keep the call only if it qualifies, and create the
  // record for an unknown caller now that the queue is known. Runs after
  // redaction so nothing withheld can reach a record it creates.
  const gate = trackedQueueGate(request.headers, call);
  let enquiryAlert = null;
  let enquiryNotices = [];
  if (gate.active) {
    const decision = await applyTrackedQueueGate(env, instanceUrl, taskBody, call, gate);
    console.log(`Tracked queues (queue ${gate.queue || "none"}, extension ${call.agent}): ${decision.reason}`);
    diag(env, `decision: ${decision.reason}`);
    // Raised once the call log is saved, since they say it was, and so they
    // can go to whoever ends up owning it.
    enquiryAlert = decision.alert || null;
    enquiryNotices = decision.notices || [];
    if (decision.drop) {
      return jsonResponse({ success: true, errors: [], filtered: "queue" }, 201);
    }
  } else if (isPendingCallerId(taskBody.WhoId)) {
    // A stand-in is not a valid Salesforce id. Without the gate's headers
    // there is nothing to resolve it with, so keep the call log unlinked
    // rather than letting the insert fail.
    console.warn("Task arrived with a stand-in id and no Tracked Queues header; forwarding the call log unlinked.");
    delete taskBody.WhoId;
  }

  // The owner 3CX found from the agent's email, or the fallback owner when it
  // found nobody. The reminder and any error alert follow the call log's owner.
  let ownerIsFallback = false;
  if (!String(taskBody.OwnerId || "").trim()) {
    delete taskBody.OwnerId;
    const fallback = await fallbackOwnerId(env, instanceUrl);
    if (fallback) {
      taskBody.OwnerId = fallback;
      ownerIsFallback = true;
    }
  }

  {
    const whoId = taskBody.WhoId || "";
    const isPersonRecord = new RegExp(`^(${PREFIX_CONTACT}|${PREFIX_LEAD})[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$`).test(whoId);

    // Read once here, because the background maintenance runs after the
    // response and no longer has the request to read headers from.
    const routing = routingLists(request.headers);

    // A transferred call journals once per extension leg. Fold the later
    // legs into the first call log so one conversation stays one activity.
    // Consolidation is a convenience; losing the call log is not acceptable,
    // so any failure here falls through to logging this leg on its own.
    if (isPersonRecord && taskBody.TaskSubtype === "Call") {
      try {
        const mergedId = await mergeIntoRecentCallTask(env, instanceUrl, whoId, taskBody, call);
        if (mergedId) {
          ctx.waitUntil(maintainJournaledRecord(env, routing, instanceUrl, whoId, taskBody, headerAgent, true));
          return jsonResponse({ id: mergedId, success: true, errors: [], merged: true }, 201);
        }
      } catch (error) {
        console.error("Call consolidation check failed, logging this leg separately:", error.message);
      }
    }

    // Otherwise forward first so journaling is never delayed, then run
    // maintenance when the task targets a Contact or Lead.
    let response = await forwardTask();

    // An owner Salesforce will not take must not cost the call log. 3CX's
    // user can be one whose licence cannot own Tasks, and a fallback owner can
    // be refused since it was checked. The fallback is tried in place of 3CX's
    // user, then the call log goes to the integration user. The reminder and
    // any alert follow whichever owner the call log ends up with.
    for (let tries = 0; tries < 2 && taskBody.OwnerId && response.status === 400; tries++) {
      const ownerError = await response.clone().text();
      if (!isOwnerRefusal(response.status, ownerError)) break;

      const refused = taskBody.OwnerId;
      let next = null;
      if (ownerIsFallback) {
        setAsideFallbackOwner(env, instanceUrl, refused, ownerError);
      } else {
        next = await fallbackOwnerId(env, instanceUrl);
      }
      if (next && next !== refused) {
        taskBody.OwnerId = next;
        ownerIsFallback = true;
      } else {
        delete taskBody.OwnerId;
        ownerIsFallback = false;
      }
      console.error(`Salesforce refused owner ${refused} on the call log, so it goes to ` +
        `${taskBody.OwnerId || "the integration user"}: ${ownerError.slice(0, 300)}`);
      response = await forwardTask();
    }

    if (response.ok) {
      if (isPersonRecord) {
        ctx.waitUntil(maintainJournaledRecord(env, routing, instanceUrl, whoId, taskBody, headerAgent));
      }
      if (enquiryAlert) {
        ctx.waitUntil(reportMaintenanceFailure(env, instanceUrl, null, new Error(enquiryAlert.message), taskBody.OwnerId, {
          subject: UNLINKED_ENQUIRY_SUBJECT, detail: enquiryAlert.detail, guidance: enquiryAlert.guidance, unlinked: true
        }));
      }
      if (enquiryNotices.length > 0 && whoId) {
        ctx.waitUntil(reportMaintenanceFailure(env, instanceUrl, whoId,
          new Error(`new record ${whoId} created without some details: ${enquiryNotices.join(" ")}`), taskBody.OwnerId, {
            subject: MISSING_DETAILS_SUBJECT,
            detail: enquiryNotices.join("\n\n"),
            guidance: `This record was created from a phone enquiry, and its call is logged as normal. Only the details above are missing.`
          }));
      }
      return response;
    }

    // Salesforce refused the call log. The usual cause is the link: a record
    // merged or deleted since the phone rang. The call is still worth
    // keeping, so it is tried once without the link, and either way someone
    // is told.
    const errorText = await response.text();
    console.error(`Salesforce rejected the call log (${response.status}): ${errorText.slice(0, 500)}`);

    const notSaved = (status, text) => reportMaintenanceFailure(env, instanceUrl, null,
      new Error(`call log not saved (${status}): ${text.slice(0, 300)}`), taskBody.OwnerId, {
        subject: NOT_SAVED_SUBJECT,
        unlinked: true,
        detail: `${callSummary(env, call, queueExtension)}\n\nSalesforce said: ${text.slice(0, 300)}`,
        guidance: `Salesforce refused this call's log, so the call is not recorded in Salesforce. If the caller needs ` +
          `following up, add a note to their record by hand. If this keeps happening, tell your Salesforce admin.`
      });

    if (whoId && response.status === 400) {
      delete taskBody.WhoId;
      const unlinked = await forwardTask();
      if (unlinked.ok) {
        ctx.waitUntil(reportMaintenanceFailure(env, instanceUrl, null,
          new Error(`call log saved without its link to ${whoId}: ${errorText.slice(0, 300)}`), taskBody.OwnerId, {
            subject: UNLINKED_CALL_SUBJECT,
            unlinked: true,
            detail: `${callSummary(env, call, queueExtension)}\n\nThe call was for record ${whoId}. Salesforce said: ${errorText.slice(0, 300)}`,
            guidance: `This call's log is saved in Salesforce, but not linked to the caller, because Salesforce would not ` +
              `accept the record it was for. That record may have been merged or deleted since the phone rang. Find ` +
              `the caller's current record and link the call log to it.`
          }));
        return unlinked;
      }
      const retryText = await unlinked.text();
      ctx.waitUntil(notSaved(unlinked.status, retryText));
      return new Response(retryText, { status: unlinked.status, headers: { "Content-Type": "application/json" } });
    }

    ctx.waitUntil(notSaved(response.status, errorText));
    return new Response(errorText, { status: response.status, headers: { "Content-Type": "application/json" } });
  }
}
