/**
 * 3CX Salesforce Integration Proxy with Client Credentials Flow
 *
 * Intercepts lookups and call journaling from 3CX to Salesforce.
 * Authenticates with Salesforce using OAuth 2.0 Client Credentials Flow.
 * Features customizable business-hours gating, AI name extraction and
 * duplicate-free auto-creation of "Unregistered Contact" records.
 *
 * Ring-time contact creation:
 *  - When an unknown number calls (or is called) and the auto-create policy
 *    allows it, the worker creates the REAL Salesforce contact during the
 *    lookup and returns it to 3CX. The agent therefore sees a genuine CRM
 *    match whose (CRM) link opens the actual record, editable mid-call.
 *  - At call end, 3CX journals the task against that real contact id. The
 *    worker then enriches the contact in the background: appends the call
 *    description/transcription, upgrades the name if the caller introduced
 *    themselves, and upserts the "Action Required" reminder task.
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
const PLACEHOLDER_ID = "UNSAVED_CONTACT_PLACEHOLDER";
const ALERT_SUBJECT_PREFIX = "Action Required:";
// Deliberately a different prefix from the caller reminders above, so the
// reminder upsert never overwrites an error alert and the auto-close never
// silently clears one.
const FAILURE_SUBJECT = "3CX Integration Error: call details could not be saved automatically";
const SF_TEXT_LIMIT = 30000; // Description fields hard-cap at 32,000 chars
const DEFAULT_FIRST_NAME = "Unregistered Contact";

// Salesforce key prefixes — the first three characters of every record id
const PREFIX_CONTACT = "003";
const PREFIX_LEAD = "00Q";

// Memory cache for Salesforce credentials
let cachedToken = null;
let cachedInstanceUrl = null;
let tokenExpiry = 0;

// Memory cache for the org's person-account record type
let cachedPersonRecordTypeId = null;

// Negative cache for 3CX's search-as-you-type. Keyed by search term, valued
// by expiry. See isKnownEmptySearch for why this is safe.
const emptySearchTerms = new Map();
const NEGATIVE_CACHE_MS = 60_000;
const NEGATIVE_CACHE_MAX = 500;

/**
 * True when this search is guaranteed to return nothing because a SHORTER
 * term already did.
 *
 * 3CX searches with LIKE '%term%'. If nothing contains "101", then nothing
 * can contain "1015" either — any record matching the longer term would
 * necessarily match the shorter one. So once a term comes back empty, every
 * term that extends it can be answered locally without asking Salesforce.
 *
 * Entries expire quickly so a record created moments ago is still found.
 */
function isKnownEmptySearch(term) {
  const now = Date.now();
  for (const [cached, expiry] of emptySearchTerms) {
    if (expiry < now) {
      emptySearchTerms.delete(cached);
      continue;
    }
    if (term.includes(cached)) return true;
  }
  return false;
}

function rememberEmptySearch(term) {
  // Bound memory — the isolate is long-lived and terms are unbounded.
  if (emptySearchTerms.size >= NEGATIVE_CACHE_MAX) emptySearchTerms.clear();
  emptySearchTerms.set(term, Date.now() + NEGATIVE_CACHE_MS);
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
  return ["contact", "personaccount", "lead"].includes(model) ? model : "contact";
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
    const requestUrl = new URL(request.url);
    const path = requestUrl.pathname;

    // ── ContactUrl Redirect (Browser Traffic) ────────────────────────────
    // Browsers don't send the X-Proxy-API-Key header when a user clicks the
    // link in 3CX. We intercept it here, before API key verification, and
    // redirect the user's browser to the Salesforce URL.
    const bareIdMatch = path.match(/^\/([a-zA-Z0-9_]{15,30})$/);
    if (bareIdMatch && request.method === "GET") {
      const salesforceId = bareIdMatch[1];

      // If it's the dummy contact, redirect to the Salesforce Contact Home page
      let redirectUrl = `${env.SALESFORCE_LOGIN_URL}/lightning/o/Contact/home`;

      // If it's a real Salesforce ID, redirect to that specific record
      if (salesforceId !== PLACEHOLDER_ID) {
        redirectUrl = `${env.SALESFORCE_LOGIN_URL}/${salesforceId}`;
      }
      return Response.redirect(redirectUrl, 302);
    }

    // 1. Verify API Key from 3CX
    const apiKey = request.headers.get("X-Proxy-API-Key");
    if (!apiKey || apiKey !== env.PROXY_API_KEY) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    setHomeCountry(env);

    try {
      // 2. Obtain Salesforce access token & instance URL (stateless client credentials flow)
      const { accessToken, instanceUrl } = await getSalesforceToken(env);

      // Set when this request is a 3CX search-as-you-type query, so the
      // result can be learned from once Salesforce answers.
      let typeAheadTerm = null;

      // The dummy contact has no AccountId, so 3CX's follow-up GetAccountName
      // query would hit Salesforce with WHERE Id = '' and fail. Answer it
      // locally with an empty result set instead.
      if (path.includes("/query/")) {
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
          typeAheadTerm = likeMatch[1];
          let minLength = Number(env.MIN_SEARCH_LENGTH || "3");
          if (isNaN(minLength) || minLength < 0) minLength = 3;

          if (typeAheadTerm.length < minLength || isKnownEmptySearch(typeAheadTerm)) {
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
      if (path.includes("/search")) {
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

      // Construct target URL in Salesforce
      const targetUrl = new URL(path + searchParams, instanceUrl).toString();

      // Prepare headers to forward to Salesforce
      const forwardHeaders = new Headers();
      for (const [key, value] of request.headers.entries()) {
        const lowerKey = key.toLowerCase();
        // Skip proxy-specific headers and standard hop-by-hop headers
        if (
          lowerKey !== "x-proxy-api-key" &&
          lowerKey !== "host" &&
          !lowerKey.startsWith("cf-")
        ) {
          forwardHeaders.set(key, value);
        }
      }

      // Attach the Salesforce Bearer access token
      forwardHeaders.set("Authorization", `Bearer ${accessToken}`);

      // 3. Intercept Contact Lookup (Search requests)
      if (path.includes("/services/data/") && path.includes("/search") && request.method === "GET") {
        return await handleLookupProxy(env, targetUrl, forwardHeaders, request.headers);
      }

      // 4. Intercept Call Journaling (Task creation)
      if (path.includes("/services/data/") && path.includes("/sobjects/task") && request.method === "POST") {
        return await handleTaskProxy(env, ctx, targetUrl, forwardHeaders, request);
      }

      // 4b. Type-ahead search: forward, but learn from an empty result so
      //     every longer term is answered locally from here on.
      if (typeAheadTerm) {
        return await handleTypeAheadQuery(env, targetUrl, forwardHeaders, typeAheadTerm);
      }

      // 5. Default: Pass-through proxy for all other requests
      const body = request.method !== "GET" && request.method !== "HEAD" ? await request.arrayBuffer() : null;
      return await forwardWithAuthRetry(env, targetUrl, {
        method: request.method,
        headers: forwardHeaders,
        body: body
      });

    } catch (error) {
      console.error("Proxy error:", error);
      return jsonResponse({ error: "Proxy Error", message: error.message }, 502);
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

  const tokenUrl = `${env.SALESFORCE_LOGIN_URL || "https://login.salesforce.com"}/services/oauth2/token`;
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

  // Salesforce access tokens typically expire in 2 hours. We cache for 1 hour
  // 55 minutes; orgs with a shorter session timeout are covered by the
  // automatic 401-retry in forwardWithAuthRetry / sfFetch.
  tokenExpiry = now + 115 * 60 * 1000;

  return { accessToken: cachedToken, instanceUrl: cachedInstanceUrl };
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
 * Runs a SOQL query. Returns the records array, or null if the query failed
 * (callers treat null as "unknown" rather than "not found" to avoid
 * creating duplicates on transient errors).
 */
async function sfQuery(env, instanceUrl, soql) {
  const url = `${instanceUrl}${SF_API_PATH}/query/?${new URLSearchParams({ q: soql })}`;
  const response = await sfFetch(env, url);
  if (!response.ok) {
    console.error(`SOQL query failed (${response.status}): ${await response.text()}`);
    return null;
  }
  const data = await response.json();
  return data.records || [];
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

function truncateForSalesforce(text) {
  if (text.length <= SF_TEXT_LIMIT) return text;
  return `[Earlier history truncated]\n...${text.slice(-(SF_TEXT_LIMIT - 40))}`;
}

/**
 * Helper to determine if we should auto-create contacts based on the policy dropdown.
 *
 * Policy values (from the 3CX dropdown):
 *   "Always On"       → always auto-create, ignore schedule fields entirely
 *   "After-Hours Only" → only auto-create outside business hours (uses schedule fields)
 *   "Disabled"         → never auto-create, ignore schedule fields entirely
 */
function shouldAutoCreate(headers) {
  const policy = (headers.get("X-Auto-Create-Policy") || "Always On").trim();

  // Disabled — never auto-create, ignore everything else
  if (policy === "Disabled") return false;

  // Always On — always auto-create, completely ignore schedule fields
  if (policy === "Always On") return true;

  // After-Hours Only — check the schedule
  // Only now do we read the business hours fields
  const startStr = headers.get("X-Business-Hours-Start") || "09:00";
  const endStr = headers.get("X-Business-Hours-End") || "17:00";

  // Parse start/end hours and minutes with NaN safety
  let [startHour, startMin] = startStr.split(":").map(Number);
  let [endHour, endMin] = endStr.split(":").map(Number);

  // If admin entered invalid times (e.g. "abc"), fall back to safe defaults
  if (isNaN(startHour) || isNaN(startMin)) { startHour = 9; startMin = 0; }
  if (isNaN(endHour) || isNaN(endMin)) { endHour = 17; endMin = 0; }

  // Cloudflare Workers use UTC. Convert to London local time.
  const ukDateString = new Date().toLocaleString("en-US", { timeZone: "Europe/London" });
  const ukDate = new Date(ukDateString);
  const day = ukDate.getDay(); // 0 is Sunday, 6 is Saturday
  const hour = ukDate.getHours();
  const minute = ukDate.getMinutes();

  // 1. Weekend is after-hours
  if (day === 0 || day === 6) {
    return true;
  }

  // 2. Weekdays: Check if current time is outside business hours
  const currentMin = hour * 60 + minute;
  const businessStartMin = startHour * 60 + startMin;
  const businessEndMin = endHour * 60 + endMin;

  if (currentMin < businessStartMin || currentMin >= businessEndMin) {
    return true;
  }

  return false;
}

/**
 * Splits a 3CX call description into its header line and the AI sections
 * (transcription / summary / sentiment / recording). 3CX composes these from
 * the template's [Transcription], [Summary], [Sentiment] and [RecordingUrl]
 * placeholders, each on its own labelled line.
 */
function splitCallSections(description) {
  // [ \t]* rather than \s* after the label, deliberately. A greedy \s* eats
  // the newline that the terminator needs, so on an *empty* section the lazy
  // body runs past the next heading and captures it instead: an empty
  // "Transcription:" came back as "Summary:". Sections with content matched
  // correctly, which is why it went unnoticed until a call arrived with no
  // transcript at all.
  const section = label => {
    const match = description.match(
      new RegExp(`${label}:[ \\t]*([\\s\\S]*?)(?:\\n\\s*(?:Transcription|Summary|Sentiment|Recording):|$)`, "i"));
    return match ? match[1].trim() : "";
  };

  const firstLabel = description.search(/\n\s*(?:Transcription|Summary|Sentiment|Recording):/i);
  return {
    header: (firstLabel === -1 ? description : description.slice(0, firstLabel)).trim(),
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

  const sections = splitCallSections(description);
  let redacted = `${sections.header}\n\n[Transcription withheld by CRM policy]`;
  if (sections.summary) redacted += `\n\nSummary: ${sections.summary}`;
  if (sections.sentiment) redacted += `\n\nSentiment: ${sections.sentiment}`;
  return redacted;
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
    "somebody", "someone", "nobody", "anybody", "everyone", "speaking"
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

  if (!response.ok) {
    return response;
  }

  const data = await response.json();

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
        console.log(`Filtered number ${phone} — no record created, journaling suppressed.`);
        return jsonResponse(data, response.status);
      }

      if (/[0-9]{4,}/.test(phone)) {
        const instanceUrl = new URL(targetUrl).origin;

        // Finding an existing record is always worth doing: Salesforce's own
        // SOSL misses records stored in national format, and whether we may
        // CREATE a record is a separate question from whether one exists.
        const target = await findOrCreateRingTimeRecord(
          env, instanceUrl, phone, shouldAutoCreate(requestHeaders));

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
                FirstName: target.FirstName || DEFAULT_FIRST_NAME,
                LastName: target.LastName || phone,
                Phone: target.Phone || phone,
                Email: target.Email || ""
              }
            ]
          }, 200, { "Cache-Control": "no-store" });
        }
      }
    }
  }

  // Otherwise, return original Salesforce results (which will be empty, skipping call logging)
  return jsonResponse(data, response.status);
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
 * Returns null if Salesforce cannot be queried reliably — the lookup then
 * stays empty and nothing is created, rather than risking a duplicate.
 */
async function findOrCreateRingTimeRecord(env, instanceUrl, phone, mayCreate) {
  const model = orgModel(env);

  if (model === "contact") {
    const contact = await findOrCreateRingTimeContact(env, instanceUrl, phone, mayCreate);
    return contact && {
      objectType: "Contact",
      recordId: contact.Id,
      whoId: contact.Id,
      FirstName: contact.FirstName,
      LastName: contact.LastName,
      Phone: contact.Phone,
      Email: contact.Email
    };
  }

  // Person Accounts take priority in both remaining modes: a converted Lead
  // becomes a Person Account, and that's the record later calls belong on.
  const account = await findPersonAccountByPhone(env, instanceUrl, phone);
  if (account.record) return personAccountResult(account.record, phone);
  if (account.failed) return null;

  if (model === "lead") {
    // An open Lead is still the right home until someone converts it.
    const lead = await findOpenLeadByPhone(env, instanceUrl, phone);
    if (lead.record) return leadResult(lead.record, phone);
    if (lead.failed) return null;

    if (!mayCreate) return null;
    const createdLead = await createLeadDeduped(env, instanceUrl, phone);
    return createdLead && leadResult(createdLead.record, phone);
  }

  if (!mayCreate) return null;
  const createdAccount = await createPersonAccountDeduped(env, instanceUrl, phone);
  return createdAccount && personAccountResult(createdAccount.record, phone);
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
    `${phoneMatchClause(["Phone", "PersonMobilePhone", "PersonHomePhone", "PersonOtherPhone"], phone)}) ` +
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
    `${phoneMatchClause(["Phone", "MobilePhone"], phone)}) ` +
    `ORDER BY CreatedDate ASC, Id ASC`);

  if (records === null) return { record: null, failed: true };
  return { record: records[0] || null, failed: false };
}

async function createPersonAccountDeduped(env, instanceUrl, phone) {
  const recordTypeId = await getPersonAccountRecordTypeId(env, instanceUrl);
  if (!recordTypeId) return null;

  return createRecordDeduped(env, instanceUrl, "Account", {
    RecordTypeId: recordTypeId,
    FirstName: DEFAULT_FIRST_NAME,
    LastName: phone,
    Phone: phone,
    Description: ringTimeDescription(),
    ...extraFields(env, "Account")
  }, `SELECT ${PERSON_ACCOUNT_FIELDS} FROM Account WHERE IsPersonAccount = true AND (` +
     `${phoneMatchClause(["Phone", "PersonMobilePhone"], phone)}) ORDER BY CreatedDate ASC, Id ASC`, phone);
}

async function createLeadDeduped(env, instanceUrl, phone) {
  // Company is deliberately omitted: with Person Accounts enabled, a Lead
  // whose Company is blank converts into a Person Account rather than a
  // business Account + Contact, which is the process we want.
  return createRecordDeduped(env, instanceUrl, "Lead", {
    FirstName: DEFAULT_FIRST_NAME,
    LastName: phone,
    Phone: phone,
    Description: ringTimeDescription(),
    ...extraFields(env, "Lead")
  }, `SELECT ${LEAD_FIELDS} FROM Lead WHERE IsConverted = false AND (` +
     `${phoneMatchClause(["Phone", "MobilePhone"], phone)}) ORDER BY CreatedDate ASC, Id ASC`, phone);
}

function ringTimeDescription() {
  const stamp = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
  return `Auto-created from the 3CX phone system when this number called at ${stamp} (UK Time).\n` +
         `Call details and the transcription are appended when the call completes.`;
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
  return (env.SALESFORCE_EXTERNAL_ID_FIELD || "").trim();
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
async function upsertByExternalId(env, instanceUrl, objectType, field, phone, body, convergeSoql) {
  const url = `${instanceUrl}${SF_API_PATH}/sobjects/${objectType}/` +
              `${encodeURIComponent(field)}/${encodeURIComponent(phone)}`;

  // The key field is carried in the URL; repeating it in the body is
  // rejected by some API versions.
  const payload = { ...body };
  delete payload[field];

  const response = await sfFetch(env, url, { method: "PATCH", body: JSON.stringify(payload) });

  if (!response.ok) {
    console.error(`Upsert on ${objectType}.${field} failed (${response.status}): ${await response.text()}`);
    return null;
  }

  // 201 = created, 200 = matched an existing record. 204 carries no body,
  // so the id comes from the re-query below either way.
  let id = null;
  let isNew = response.status === 201;
  if (response.status !== 204) {
    const result = await response.json().catch(() => ({}));
    id = result.id || null;
    if (typeof result.created === "boolean") isNew = result.created;
  }

  // Re-read for server-populated fields such as PersonContactId.
  const records = await sfQuery(env, instanceUrl, convergeSoql);
  const mine = records && (records.find(r => r.Id === id) || records[0]);
  if (mine) {
    console.log(`Upserted ${objectType} ${mine.Id} on ${field} (${isNew ? "created" : "matched existing"})`);
    return { record: mine, isNew };
  }

  return id ? { record: { Id: id, ...body }, isNew } : null;
}

/**
 * Generic create-then-converge: create the record, then re-query and keep
 * only the oldest one for this number. If a simultaneous call won the race,
 * ours (which has no tasks attached yet) is deleted and the winner used.
 *
 * Used when no External ID field is configured. Convergence closes the race
 * after the fact; an External ID field prevents it happening at all.
 */
async function createRecordDeduped(env, instanceUrl, objectType, body, convergeSoql, phone) {
  const field = externalIdField(env);
  if (field && phone) {
    const upserted = await upsertByExternalId(
      env, instanceUrl, objectType, field, phone, { ...body, [field]: phone }, convergeSoql);
    if (upserted) return upserted;
    console.error(`Falling back to create-then-converge for ${objectType}.`);
  }

  const response = await sfFetch(env, `${instanceUrl}${SF_API_PATH}/sobjects/${objectType}`, {
    method: "POST",
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Failed to create Salesforce ${objectType}: ${response.status} - ${errorText}`);

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
 * Returns null if Salesforce cannot be queried reliably — in that case the
 * lookup stays empty and nothing is created.
 */
async function findOrCreateRingTimeContact(env, instanceUrl, phone, mayCreate) {
  const existing = await findContactByPhone(env, instanceUrl, phone);
  if (existing.record) return existing.record;
  if (existing.failed || !mayCreate) return null;

  const stamp = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
  const created = await createContactDeduped(env, instanceUrl, phone, {
    FirstName: DEFAULT_FIRST_NAME,
    LastName: phone,
    Phone: phone,
    Description: `Auto-created from the 3CX phone system when this number called at ${stamp} (UK Time).\n` +
                 `Call details and the transcription are appended when the call completes.`
  });
  return created ? created.record : null;
}

/**
 * Forwards a search-as-you-type query and remembers terms that matched
 * nothing, so subsequent keystrokes extending them never reach Salesforce.
 */
async function handleTypeAheadQuery(env, targetUrl, forwardHeaders, term) {
  const response = await forwardWithAuthRetry(env, targetUrl, {
    method: "GET",
    headers: forwardHeaders
  });

  if (!response.ok) return response;

  const data = await response.json();
  if (Array.isArray(data.records) && data.records.length === 0) {
    rememberEmptySearch(term);
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

  const inboundMatch = description.match(/incoming call from\s+(\S+)\s*(.*?)\s+to\s+(\S+)\s/i);
  const outboundMatch = description.match(/outgoing call from\s+(\S+)\s+to\s+(\S+)\s*(.*?)\s*\(/i);
  const missedMatch = description.match(/Missed call from\s+(\S+)\s*(.*?)\s+to\s+(\S+)/i);
  const unansweredMatch = description.match(/Unanswered outgoing call from\s+(\S+)\s+to\s+(\S+)\s*(.*?)$/im);

  if (inboundMatch) {
    phone = inboundMatch[1];
    threeCxName = (inboundMatch[2] || "").trim();
    agent = inboundMatch[3];
    direction = "Inbound";
  } else if (outboundMatch) {
    agent = outboundMatch[1];
    phone = outboundMatch[2];
    threeCxName = (outboundMatch[3] || "").trim();
    direction = "Outbound";
  } else if (missedMatch) {
    phone = missedMatch[1];
    threeCxName = (missedMatch[2] || "").trim();
    agent = missedMatch[3];
    direction = "Inbound Missed";
  } else if (unansweredMatch) {
    agent = unansweredMatch[1];
    phone = unansweredMatch[2];
    threeCxName = (unansweredMatch[3] || "").trim();
    direction = "Outbound Unanswered";
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
  if (threeCxName && /Unsaved Contact|Unregistered Contact|\(Unsaved|Unverified/i.test(threeCxName)) {
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
  const stamped = description.match(/^\s*\S+\s+(\d{1,2}):(\d{2})/);
  const callTime = stamped
    ? `${stamped[1].padStart(2, "0")}:${stamped[2]}`
    : new Date().toLocaleTimeString("en-GB", {
        timeZone: "Europe/London",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      });

  // Trailing "(mm:ss)" or "(h:mm:ss)" that 3CX appends for answered calls.
  const durationMatch = description.match(/\((\d{1,2}:\d{2}(?::\d{2})?)\)\s*(?:\n|$)/);
  const duration = durationMatch ? durationMatch[1] : "";

  return { phone, agent, direction, threeCxName, callTime, duration };
}

/**
 * True for extensions that are pieces of call-routing furniture rather than
 * people: digital receptionists, queues, ring groups, voicemail boxes. Set
 * SYSTEM_EXTENSIONS to a comma-separated list, e.g. "1001,1002,8001".
 *
 * 3CX journals per extension leg, so a call that greets the caller with an
 * auto attendant before reaching a human is journaled twice: once against
 * the attendant, once against the person. The attendant leg is real history
 * worth keeping, but stamping it onto the record's name tells nobody
 * anything, and it is the leg that arrives first.
 */
function isSystemExtension(env, agent) {
  if (!agent || agent === "Unknown") return false;
  return (env.SYSTEM_EXTENSIONS || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean)
    .includes(agent);
}

/**
 * Friendly name for the site or team an extension belongs to, from the
 * EXTENSION_DEPARTMENTS variable:
 *
 *   {"0311":"Arbour Walk","03":"Arbour Walk","04":"Bath House"}
 *
 * Exact extension wins, then the longest matching prefix, so a whole range
 * can be mapped in one entry with individual exceptions above it.
 *
 * 3CX exposes no department to CRM templates — only the extension — so this
 * mapping is the only way to get the site onto the record.
 */
function departmentFor(env, agent) {
  if (!agent || agent === "Unknown") return "";

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
 * correction. Any name we spot travels as a hint on the description and
 * reminder instead, so a human still gets the head start.
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
    hintLine: hintName ? `Possible caller name mentioned: "${hintName}" (unverified — from ${hintSource})` : null
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
  return /\((Inbound|Outbound)/.test(last);
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
    `SELECT Id, FirstName, LastName, Phone, Email, Description FROM Contact WHERE ` +
    `${phoneMatchClause(["Phone", "MobilePhone", "HomePhone", "OtherPhone"], phone)} ` +
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
async function createContactDeduped(env, instanceUrl, phone, contactBody) {
  return createRecordDeduped(env, instanceUrl, "Contact", { ...contactBody, ...extraFields(env, "Contact") },
    `SELECT Id, FirstName, LastName, Phone, Email, Description FROM Contact WHERE ` +
    `${phoneMatchClause(["Phone", "MobilePhone", "HomePhone", "OtherPhone"], phone)} ` +
    `ORDER BY CreatedDate ASC, Id ASC`, phone);
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
  const records = await sfQuery(env, instanceUrl,
    `SELECT Id, Subject, Description, CallDurationInSeconds FROM Task ` +
    `WHERE WhoId = '${whoId}' AND TaskSubtype = 'Call' AND CreatedDate >= ${since} ` +
    `ORDER BY CreatedDate DESC LIMIT 1`);
  return records && records.length > 0 ? records[0] : null;
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

  const legHeader = call.agent && call.agent !== "Unknown"
    ? `Call continued on extension ${call.agent} at ${call.callTime} (UK Time)`
    : `Call continued at ${call.callTime} (UK Time)`;

  const update = {
    Description: truncateForSalesforce(
      `${prior.Description || ""}\n\n===== ${legHeader} =====\n${taskBody.Description || ""}`),
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
 * Makes a background failure visible to a human.
 *
 * Post-journaling maintenance runs after the call log is already safe, so
 * when it fails the transcript quietly never reaches the record and nobody
 * finds out unless `wrangler tail` happened to be open at that moment.
 *
 * Two independent signals, because they fail for different reasons: a
 * webhook reaches someone even when Salesforce itself is what broke, and a
 * Salesforce task lands in the same work queue as the caller reminders when
 * the cause was a single bad field. Both are best-effort — an alert that
 * throws must never mask the original error.
 */
async function reportMaintenanceFailure(env, instanceUrl, whoId, error) {
  const detail = `Salesforce record ${whoId || "(unlinked)"}: ${error.message || error}`;

  if (env.ALERT_WEBHOOK_URL) {
    try {
      await fetch(env.ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `${FAILURE_SUBJECT} — ${detail}`, whoId, error: `${error.message || error}` })
      });
    } catch (e) {
      console.error("Alert webhook failed:", e.message);
    }
  }

  if (!whoId) return;

  try {
    // One open error task per record. Repeated failures on the same caller
    // update the existing alert rather than stacking a queue of identical
    // ones, matching how the caller reminders behave.
    const open = await sfQuery(env, instanceUrl,
      `SELECT Id FROM Task WHERE WhoId = '${whoId}' AND IsClosed = false ` +
      `AND Subject = '${FAILURE_SUBJECT.replace(/'/g, "\\'")}' LIMIT 1`);

    const description =
      `${detail}\n\n` +
      `The call log itself was saved. What may be missing from the record is the ` +
      `appended transcription, the caller reminder, or both. Check the call activity ` +
      `for this number and copy anything missing across by hand.`;

    if (open && open.length > 0) {
      await sfFetch(env, `${instanceUrl}${SF_API_PATH}/sobjects/Task/${open[0].Id}`, {
        method: "PATCH",
        body: JSON.stringify({ Description: truncateForSalesforce(description) })
      });
      return;
    }

    const raised = await sfFetch(env, `${instanceUrl}${SF_API_PATH}/sobjects/Task`, {
      method: "POST",
      body: JSON.stringify({
        Subject: FAILURE_SUBJECT,
        Description: truncateForSalesforce(description),
        Status: "Not Started",
        Priority: "High",
        TaskSubtype: "Task",
        ActivityDate: new Date().toISOString().split("T")[0],
        WhoId: whoId
      })
    });

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

async function findOpenAlertTasks(env, instanceUrl, contactId) {
  return sfQuery(env, instanceUrl,
    `SELECT Id, Description FROM Task WHERE WhoId = '${contactId}' AND Status <> 'Completed' AND Subject LIKE '${ALERT_SUBJECT_PREFIX}%' ORDER BY CreatedDate ASC, Id ASC`);
}

async function closeOpenReminders(env, instanceUrl, contactId) {
  const openAlerts = await findOpenAlertTasks(env, instanceUrl, contactId);
  for (const alert of openAlerts || []) {
    await sfFetch(env, `${instanceUrl}${SF_API_PATH}/sobjects/Task/${alert.Id}`, {
      method: "PATCH",
      body: JSON.stringify({ Status: "Completed" })
    });
  }
}

/**
 * Appends this call (with its transcription) to the caller's record so the
 * full history lives there as well as in its linked tasks.
 */
/**
 * Renders one call as a readable block for the record's Description.
 *
 * 3CX's raw line is deliberately not pasted in. It repeats the number, then
 * repeats the matched record's *display name* — which itself contains the
 * number and the direction stamp — so an auto-created caller ends up with
 * their own name nested inside their own call history, twice. It also emits
 * "Transcription:", "Summary:", "Sentiment:" and "Recording:" whether or not
 * any of them have content, which on a call with no transcript is four empty
 * headings and nothing else.
 *
 * Everything worth keeping is already parsed, so the block is composed from
 * that instead and empty sections are dropped.
 */
function renderCallBlock(env, call, description, hintLine) {
  const site = departmentFor(env, call.agent);
  const sections = splitCallSections(description);
  const body = [];
  if (hintLine) body.push(hintLine);
  if (sections.transcription) body.push(`Transcription: ${sections.transcription}`);
  if (sections.summary) body.push(`Summary: ${sections.summary}`);
  if (sections.sentiment) body.push(`Sentiment: ${sections.sentiment}`);
  if (sections.recording) body.push(`Recording: ${sections.recording}`);

  // A leg that ended on an auto attendant or in a queue is routing, not a
  // conversation. Given a full block it dominates the history: a caller held
  // for half an hour contributes a long duration and nothing said, burying
  // the leg where somebody actually spoke. One line instead, because the
  // wait itself is worth knowing even though nothing was discussed.
  if (isSystemExtension(env, call.agent) && body.length === 0) {
    const label = site ? `${site} (${call.agent})` : `extension ${call.agent}`;
    return `\n\nRouted via ${label} at ${call.callTime}` +
           (call.duration ? `, held ${call.duration}` : "") + ".";
  }

  const who = isSystemExtension(env, call.agent)
    ? (site ? `${site} (${call.agent})` : `Extension ${call.agent}`)
    : (site ? `Ext ${call.agent} (${site})` : `Ext ${call.agent}`);
  const parts = [call.direction, call.callTime, who];
  if (call.duration) parts.push(call.duration);

  if (body.length === 0) body.push("No transcription or recording available for this call.");

  return `\n\n===== ${parts.join(" · ")} =====\n${body.join("\n\n")}`;
}

async function appendCallToRecord(env, instanceUrl, objectType, record, call, description, hintLine) {
  const appendix = renderCallBlock(env, call, description, hintLine);
  await sfFetch(env, `${instanceUrl}${SF_API_PATH}/sobjects/${objectType}/${record.Id}`, {
    method: "PATCH",
    body: JSON.stringify({
      Description: truncateForSalesforce((record.Description || "") + appendix)
    })
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
 *  - Still unregistered → upgrade the name if the caller introduced
 *    themselves, append the call to the record, and upsert the open reminder
 *    instead of stacking a new one.
 *
 * `whoId` is what the task was linked to (a Lead, or a Person Account's
 * backing contact); `record` is the object we actually update, which for a
 * Person Account is the Account itself.
 */
async function maintainJournaledRecord(env, instanceUrl, whoId, taskBody) {
  try {
    const resolved = await resolveJournaledRecord(env, instanceUrl, whoId);
    if (!resolved) return;

    const { objectType, record } = resolved;

    if (!isStillUnregistered(record)) {
      console.log(`${objectType} ${record.Id} already has real details — closing any open reminders.`);
      await closeOpenReminders(env, instanceUrl, whoId);
      return;
    }

    console.log(`Maintaining ${objectType} ${record.Id}: appending call and upserting reminder.`);

    const description = taskBody.Description || "";
    const call = parseCallDetails(description);
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
    if (record.FirstName === DEFAULT_FIRST_NAME &&
        !isSystemExtension(env, call.agent) &&
        (record.LastName === call.phone || record.LastName === recordPhone(record))) {
      await sfFetch(env, recordUrl, {
        method: "PATCH",
        body: JSON.stringify({ LastName: nameInfo.lastName })
      });
    }

    await appendCallToRecord(env, instanceUrl, objectType, record, call, description, nameInfo.hintLine);
    await upsertAlertTask(env, instanceUrl, whoId, record, objectType, call, nameInfo, taskBody.OwnerId);
  } catch (error) {
    console.error("Record/alert maintenance failed:", error);
    await reportMaintenanceFailure(env, instanceUrl, whoId, error);
  }
}

/**
 * Creates or updates the single open "Action Required" reminder for a
 * caller. `whoId` is what the reminder links to (Lead, or a Person
 * Account's backing contact); `record`/`objectType` describe what a human
 * needs to go and fix.
 */
async function upsertAlertTask(env, instanceUrl, whoId, record, objectType, call, nameInfo, ownerId) {
  const today = new Date().toISOString().split("T")[0];
  const openAlerts = await findOpenAlertTasks(env, instanceUrl, whoId);
  const noun = objectType === "Lead" ? "Lead" : "Contact";

  // Query failed — creating blindly could stack duplicates, so skip.
  if (openAlerts === null) return;

  if (openAlerts.length > 0) {
    // Update the existing reminder instead of stacking a new one.
    const alert = openAlerts[0];
    const update = {
      Description: truncateForSalesforce(
        `${alert.Description || ""}\n\nRepeat call: ${call.phone} at ${call.callTime} (${call.direction}), ` +
        `handled by extension ${call.agent}. Details still need to be filled in.` +
        (nameInfo.hintLine ? `\n${nameInfo.hintLine}` : "")
      ),
      ActivityDate: today,
      Priority: "High"
    };
    await sfFetch(env, `${instanceUrl}${SF_API_PATH}/sobjects/Task/${alert.Id}`, {
      method: "PATCH",
      body: JSON.stringify(update)
    });

    // Self-heal: complete any extra reminders left over from older versions.
    for (const extra of openAlerts.slice(1)) {
      await sfFetch(env, `${instanceUrl}${SF_API_PATH}/sobjects/Task/${extra.Id}`, {
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
    Description: `An unsaved call was handled from ${call.phone} at ${call.callTime} by 3CX extension ${call.agent}.\n\n` +
      `A ${objectType === "Account" ? "Person Account" : objectType} record exists for this caller: ` +
      `"${record.FirstName || ""} ${record.LastName || ""}".\n\n` +
      (nameInfo.hintLine ? `${nameInfo.hintLine}\nPlease confirm this with the caller before relying on it.\n\n` : "") +
      nextStep,
    Status: "Not Started", // Open
    Priority: "High",      // High priority alert
    TaskSubtype: "Task",
    ActivityDate: today
  };

  if (ownerId) {
    alertBody.OwnerId = ownerId;
  }

  const created = await sfFetch(env, `${instanceUrl}${SF_API_PATH}/sobjects/task`, {
    method: "POST",
    body: JSON.stringify(alertBody)
  });

  if (!created.ok) {
    console.error(`Failed to create alert task: ${created.status} - ${await created.text()}`);
    return;
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
 * Proxies task creation (call journaling).
 *
 * Normal path: 3CX journals against a real contact id (created at ring
 * time). The task is forwarded untouched and contact maintenance —
 * transcription append, name upgrade, reminder upsert — runs in the
 * background.
 *
 * Legacy path: tasks that still carry the placeholder id (calls looked up
 * before this version deployed) get the find-or-create treatment first.
 */
async function handleTaskProxy(env, ctx, targetUrl, forwardHeaders, request) {
  const requestBodyText = await request.text();
  let taskBody;

  try {
    taskBody = JSON.parse(requestBodyText);
  } catch (e) {
    // Not valid JSON, just pass through
    return forwardWithAuthRetry(env, targetUrl, {
      method: "POST",
      headers: forwardHeaders,
      body: requestBodyText
    });
  }

  const forwardTask = () => forwardWithAuthRetry(env, targetUrl, {
    method: "POST",
    headers: forwardHeaders,
    body: JSON.stringify(taskBody)
  });

  const instanceUrl = new URL(targetUrl).origin;
  const call = parseCallDetails(taskBody.Description || "");

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
    console.log(`Filtered number ${call.phone} — call log dropped.`);
    return jsonResponse({ success: true, errors: [], filtered: "number" }, 201);
  }

  // Redact before anything is stored or mined for names: if the transcript
  // is withheld by policy, it must not reach the contact record either.
  if (taskBody.Description) {
    taskBody.Description = applyTranscriptPolicy(taskBody.Description, call.direction, request.headers);
  }

  // Records are created at ring time now, so a task should always arrive
  // with a real id. A 3CX lookup cached before that change could still send
  // the old placeholder, which is not a valid Salesforce id — strip it and
  // keep the call log unlinked rather than letting the insert fail.
  if (taskBody.WhoId === PLACEHOLDER_ID) {
    console.warn("Task arrived with the legacy placeholder id; forwarding the call log unlinked.");
    delete taskBody.WhoId;
  }

  {
    const whoId = taskBody.WhoId || "";
    const isPersonRecord = new RegExp(`^(${PREFIX_CONTACT}|${PREFIX_LEAD})[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$`).test(whoId);

    // A transferred call journals once per extension leg. Fold the later
    // legs into the first call log so one conversation stays one activity.
    // Consolidation is a convenience; losing the call log is not acceptable,
    // so any failure here falls through to logging this leg on its own.
    if (isPersonRecord && taskBody.TaskSubtype === "Call") {
      try {
        const mergedId = await mergeIntoRecentCallTask(env, instanceUrl, whoId, taskBody, call);
        if (mergedId) {
          ctx.waitUntil(maintainJournaledRecord(env, instanceUrl, whoId, taskBody));
          return jsonResponse({ id: mergedId, success: true, errors: [], merged: true }, 201);
        }
      } catch (error) {
        console.error("Call consolidation check failed, logging this leg separately:", error.message);
      }
    }

    // Otherwise forward first so journaling is never delayed, then run
    // maintenance when the task targets a Contact or Lead.
    const response = await forwardTask();
    if (response.ok && isPersonRecord) {
      ctx.waitUntil(maintainJournaledRecord(env, instanceUrl, whoId, taskBody));
    }
    return response;
  }
}
