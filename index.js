// index.js — systemic link fidelity fix + skip liveness for trusted domains

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { OpenAI } = require('openai');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());

/* ---------------- DB & OpenAI ---------------- */
const dbConfig = {
  user: process.env.PGUSER || process.env.POSTGRES_USER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE || process.env.POSTGRES_DB,
  password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
  port: process.env.PGPORT || 5432,
  ssl: { rejectUnauthorized: false },
};

const pool = new Pool(dbConfig);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------------- URL POLICY ---------------- */
const APPROVED = new Set([
  "https://www.dal.ca/campus_life/health-and-wellness.html",
  "https://www.chairs-chaires.gc.ca/chairholders-titulaires/index-eng.aspx",
  "https://www.mcgill.ca/research/research/human/reb/forms-and-guidelines",
  "https://fundingopps-osr.research.mcgill.ca",

  // Interagency canonical links
  "https://science.gc.ca/site/science/en/interagency-research-funding/policies-and-guidelines/selecting-appropriate-federal-granting-agency",
  "https://science.gc.ca/site/science/en/interagency-research-funding/policies-and-guidelines/open-access",
  "https://science.gc.ca/site/science/en/interagency-research-funding/policies-and-guidelines/research-data-management",
  "https://ccv-cvc.ca"
]);

const WHITELIST_HOSTS = new Set([
  "dal.ca","cdn.dal.ca","libraries.dal.ca","medicine.dal.ca","ukings.ca",
  "mcgill.ca","mcgilllibrary.ca","fundingopps-osr.research.mcgill.ca",
  "canada.ca","servicecanada.gc.ca","esdc.gc.ca",
  "nserc-crsng.gc.ca","sshrc-crsh.gc.ca","sshrc-crsh.canada.ca","cihr-irsc.gc.ca","science.gc.ca",
  "researchnet-recherchenet.ca","innovation.ca","mitacs.ca","genomecanada.ca",
  "cfref-apogee.gc.ca","researchns.ca","springboardatlantic.ca","u15.ca",
  "crdcn.ca","alliancecan.ca","crkn-rcdr.ca",
  "flybermudair.com","help.flybermudair.com","flightstatus.flybermudair.com",
  "bermudair.inkcloud.io","storage.aerocrs.com","a-us.storyblok.com",
  "bermudaholidays.com","bermudair.bamboohr.com","dsu.ca", 
]);

const DOMAIN_FALLBACKS = {
  "servicecanada.gc.ca": "https://www.canada.ca/en/services/benefits.html",
  "canada.ca": "https://www.canada.ca",
  "esdc.gc.ca": "https://www.canada.ca/en/employment-social-development.html",
  "science.gc.ca": "https://science.gc.ca/site/science/en/interagency-research-funding/policies-and-guidelines",
  "sshrc-crsh.gc.ca": "https://www.sshrc-crsh.gc.ca",
  "sshrc-crsh.canada.ca": "https://sshrc-crsh.canada.ca/en",
  "dal.ca": "https://www.dal.ca",
  "cdn.dal.ca": "https://www.dal.ca",
  "libraries.dal.ca": "https://libraries.dal.ca",
  "ukings.ca": "https://ukings.ca",
  "dsu.ca": "https://www.dsu.ca",

  // ✅ New systemic redirect for McGill academic lifecycle (sabbaticals, tenure, promotion)
  "apo.mcgill.ca": "https://www.mcgill.ca/apo/",

  // ✅ Default McGill fallback remains the Research portal
  "mcgill.ca": "https://www.mcgill.ca/research/",
  "mcgilllibrary.ca": "https://www.mcgill.ca/library",

  // BermudAir
  "flybermudair.com": "https://www.flybermudair.com/",
  "help.flybermudair.com": "https://help.flybermudair.com/kb/en",
  "flightstatus.flybermudair.com": "https://www.flybermudair.com/",
  "bermudair.inkcloud.io": "https://www.flybermudair.com/",
  "storage.aerocrs.com": "https://www.flybermudair.com/pages/policies-legal-information",
  "a-us.storyblok.com": "https://www.flybermudair.com/pages/policies-legal-information",
  "bermudaholidays.com": "https://www.flybermudair.com/pages/holidays",
  "bermudair.bamboohr.com": "https://www.flybermudair.com/",
};

/* ---------------- Helpers ---------------- */
function extractUrls(text){
  return [...new Set((text.match(/https?:\/\/[^\s)\]]+/gi) || []))];
}
function normUrl(u){
  try{
    const x = new URL(u);
    x.hash=""; x.search="";
    return x.toString().replace(/\/$/,"").toLowerCase();
  } catch { return null; }
}
function hostOf(u){ try { return new URL(u).hostname.replace(/^www\./,""); } catch { return ""; } }
function base2(h){ const p=h.split("."); return p.slice(-2).join("."); }
function base3(h){ const p=h.split("."); return p.slice(-3).join("."); }

function hasFallback(h){
  return DOMAIN_FALLBACKS[h] || DOMAIN_FALLBACKS[base2(h)] || DOMAIN_FALLBACKS[base3(h)] || "";
}
function isAllowed(norm){
  if (!norm) return false;
  if (APPROVED.has(norm)) return true;
  const h = hostOf(norm);
  return WHITELIST_HOSTS.has(h) || WHITELIST_HOSTS.has(base2(h)) || WHITELIST_HOSTS.has(base3(h));
}
function fixMalformedEmails(text){
  return text.replace(/\b([A-Za-z0-9._%+-]+)@https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?:\/[^\s)\]]*)?/gi,"$1@$2");
}

/* ---------------- Liveness Skips ---------------- */
// ✅ Domains we will NEVER run liveness checks on
const SKIP_LIVENESS = new Set(["mcgill.ca", "dal.ca", "ukings.ca"]);

/* ---------------- LIVE LINK GUARD ---------------- */
const SOFT_OK = new Set([401,403,405,406,429]); 
const LIVE_CACHE = new Map();
const LIVE_TTL_MS = 1000 * 60 * 30;

function okStatus(s){ return (s >= 200 && s < 400) || SOFT_OK.has(s); }

async function isLiveUrl(url){
  const hname = hostOf(url);
  if (SKIP_LIVENESS.has(hname) || SKIP_LIVENESS.has(base2(hname))) {
    // ✅ Treat as always live
    return true;
  }

  const now = Date.now();
  const cached = LIVE_CACHE.get(url);
  if (cached && (now - cached.ts) < LIVE_TTL_MS) return cached.ok;

  const client = axios.create({ timeout: 8000, maxRedirects: 5, validateStatus: () => true });
  const headers = { 'User-Agent': 'LinkHealth/1.1', 'Accept': 'text/html,application/pdf;q=0.9,*/*;q=0.8' };

  let ok = false;

  try {
    const r = await client.head(url, { headers });
    ok = okStatus(Number(r.status) || 0);
    if (!ok) {
      const g = await client.get(url, { headers });
      ok = okStatus(Number(g.status) || 0);
    }
  } catch (err) {
    console.error(`❌ Liveness check failed for ${url}: ${err.message}`);
    ok = false;
  }

  LIVE_CACHE.set(url, { ok, ts: now });
  return ok;
}

/* ---------------- Sanitizer ---------------- */
async function sanitize(markdown){
  try {
    let out = fixMalformedEmails(markdown);
    const found = extractUrls(out);

    const debug = process.env.LINK_DEBUG === '1';
    const replacements = [];

    for (const raw of found) {
      const norm = normUrl(raw);
      const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(esc, "g");

      if (!norm) {
        out = out.replace(re, "");
        if (debug) replacements.push({ raw, action: "strip-invalid" });
        continue;
      }

      const h = hostOf(norm);

      if (!isAllowed(norm)) {
        const fb = hasFallback(h);
        out = fb ? out.replace(re, fb) : out.replace(re, "");
        if (debug) replacements.push({ raw, action: fb ? "fallback-domain" : "strip-disallowed", to: fb || "" });
        continue;
      }

      let live = await isLiveUrl(norm);
      if (!live) {
        const fb = hasFallback(h) || `https://${h}`;
        out = fb ? out.replace(re, fb) : out.replace(re, "");
        if (debug) replacements.push({ raw, action: fb ? "fallback-liveness" : "strip-dead", to: fb || "" });
      }
    }

    if (debug && replacements.length) {
      console.log("🔗 link-fixes:", replacements.slice(0, 50));
    }

    return out;
  } catch {
    return markdown;
  }
}

/* ---------------- /ask ---------------- */
app.post('/ask', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  try {
    let payload;
    if (typeof req.body === 'string') {
      try { payload = JSON.parse(req.body); }
      catch { payload = { messages: [{ role: 'user', content: req.body }] }; }
    } else { payload = req.body || {}; }

    /* === NEW: log only the student's or research question (strip scaffolding) === */
    try {
      const msgs = Array.isArray(payload.messages) ? payload.messages : [];
      const lastUserMsg = [...msgs].reverse().find(m => m && m.role === 'user');

      const toText = (c) => {
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map(p => (typeof p?.text === 'string' ? p.text : '')).join(' ');
        if (c && typeof c === 'object' && typeof c.text === 'string') return c.text;
        return '';
      };

      const raw = toText(lastUserMsg?.content || '');
      const normalized = raw
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\r/g, '')
        .trim();

      // ✅ UPDATED REGEX to handle DAL AI, DAL RA, SC, and BA
      const markerRe = /(here\s+is\s+(?:the\s+)?student'?s\s+question|here\s+is\s+(?:the\s+)?research\s+question|here\s+is\s+(?:the\s+)?user'?s\s+question|^(?:student'?s|research|user'?s)\s+question)\s*[:\-–—]\s*/im;
      let question = normalized;
      const m = markerRe.exec(normalized);
      if (m) {
        question = normalized.slice(m.index + m[0].length);
      }

      const firstLine = question.split('\n')[0].trim();
      const snippet = firstLine.slice(0, 240);

      if (snippet) console.log('user_input:', snippet);
    } catch (_) {
      // never break the request on logging failure
    }
    /* === END NEW BLOCK === */

    console.log('📥 /ask payload (first 300):', JSON.stringify(payload).slice(0, 300));

    const r = await openai.chat.completions.create({
      model: 'gpt-5',
      messages: payload.messages || [],
      max_completion_tokens: typeof payload.max_completion_tokens === 'number'
        ? payload.max_completion_tokens
        : 4000,
      temperature: 1
    });

    const reply = r.choices?.[0]?.message?.content || '';
    const safeReply = await sanitize(reply);
    res.json({ answer: safeReply });
  } catch (err){
    console.error('❌ /ask error:', err.message);
    res.status(500).json({ error: 'Failed to process request.' });
  }
});

/* ---------------- /log ---------------- */
app.post('/log', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { timestamp, user_input, answer } = req.body || {};
    if (!user_input || typeof user_input !== 'string') {
      return res.status(400).json({ ok: false, error: 'missing-user_input' });
    }

    const clean = s => typeof s === 'string'
      ? s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
          .replace(/\u2028|\u2029/g, ' ')
      : null;

    const result = await pool.query(
      `INSERT INTO log (input,response,timestamp)
       VALUES ($1,$2,to_timestamp($3/1000.0)) RETURNING id`,
      [clean(user_input), clean(answer), Number.isFinite(timestamp) ? timestamp : Date.now()]
    );

    console.log('📝 Logged question ID:', result.rows[0]?.id);
    res.status(201).json({ ok: true, id: result.rows[0]?.id });
  } catch (err){
    console.error('❌ /log insert error:', err.message);
    res.status(500).json({ ok: false, error: 'db-insert-failed' });
  }
});

/* ---------------- boot ---------------- */
app.listen(port, '0.0.0.0', () => console.log(`✅ Backend running on port ${port}`));
