// index.js — systemic link fidelity fix + PGVector integration + skip liveness for trusted domains

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { OpenAI } = require('openai');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());

/* ---------------- GitHub URL Sanitizer ---------------- */
// ✅ Replace ANY GitHub-related link with a safe fallback
function sanitizeGitHubLinks(text) {
  const fallbackUrl = "https://rppa-appr.ca/en/summary"; // safe canonical APPR summary URL
  return text.replace(/https?:\/\/[^\s]*github[^\s)]+/gi, fallbackUrl);
}

/* ---------------- DB & OpenAI ---------------- */
// ✅ Updated to completely disable SSL to fix connection issue
const dbConfig = {
  user: process.env.PGUSER || process.env.POSTGRES_USER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE || process.env.POSTGRES_DB,
  password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
  port: process.env.PGPORT || 5432,
  ssl: false  // Force SSL to be completely disabled
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
  const candidates = text.match(/https?:\/\/\S+/gi) || [];
  const cleaned = candidates.map(u => u.replace(/[)\]\.,;:!?"'<>]+$/g, ''));
  return [...new Set(cleaned)];
}
function normUrl(u){
  try{
    const cleaned = String(u).trim().replace(/[)\]\.,;:!?"'<>]+$/g, '');
    const x = new URL(cleaned);
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
const SKIP_LIVENESS = new Set(["mcgill.ca", "dal.ca", "ukings.ca"]);

/* ---------------- LIVE LINK GUARD ---------------- */
const SOFT_OK = new Set([401,403,405,406,429]); 
const LIVE_CACHE = new Map();
const LIVE_TTL_MS = 1000 * 60 * 30;

function okStatus(s){ return (s >= 200 && s < 400) || SOFT_OK.has(s); }

async function isLiveUrl(url){
  const hname = hostOf(url);
  if (SKIP_LIVENESS.has(hname) || SKIP_LIVENESS.has(base2(hname))) {
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

/* ---------------- PGVECTOR Integration ---------------- */
async function fetchTopMatches(userQuery, topN = 10) {  // increased from 2 → 10
  console.log("🔍 [DEBUG] Fetching top matches for query:", userQuery);
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-large", // must match DB schema (vector(3072))
    input: userQuery,
  });
  const embedding = embeddingResponse.data[0].embedding;
  console.log("🧮 [DEBUG] Embedding length:", embedding.length);

  if (embedding.length !== 3072) {
    console.error("❌ [DEBUG] Embedding dimension mismatch. Expected 3072, got:", embedding.length);
    throw new Error(`Embedding dimension mismatch: expected 3072, got ${embedding.length}`);
  }

  const vectorString = `[${embedding.join(',')}]`;

  const result = await pool.query(
    `SELECT content, embedding <=> $1 AS distance
     FROM greenlist_embeddings
     ORDER BY distance ASC
     LIMIT $2`,
    [vectorString, topN]
  );

  console.log("📊 [DEBUG] DB returned rows:", result.rows.length);
  return result.rows;
}

/* ---------------- Sanitizer ---------------- */
async function sanitize(markdown){
  try {
    markdown = sanitizeGitHubLinks(markdown);

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

/* ---------------- /test ---------------- */
app.get('/test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      message: 'Backend and database are connected!',
      time: result.rows[0].now,
    });
  } catch (err) {
    console.error('❌ /test error:', err.message);
    res.status(500).json({ error: 'Database connection failed', details: err.message });
  }
});

/* ---------------- /ask ---------------- */
app.post('/ask', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  try {
    console.log("📥 [DEBUG] Incoming /ask request body:", req.body);

    let payload;
    if (typeof req.body === 'string') {
      try { payload = JSON.parse(req.body); }
      catch { payload = { messages: [{ role: 'user', content: req.body }] }; }
    } else { payload = req.body || {}; }

    const userMessage = payload.messages?.find(m => m.role === 'user')?.content || '';
    console.log("💬 [DEBUG] User message:", userMessage);

    const topMatches = await fetchTopMatches(userMessage, 10); // now capped at 10
    console.log("🔗 [DEBUG] Top matches received:", topMatches);

    // ✅ Deduplicate and cap context to avoid token overload
    const uniqueUrls = [...new Set(topMatches.map(m => m.content.trim()))].slice(0, 8);
    const contextBlock = uniqueUrls.map(url => `URL: ${url}\n`).join('\n');

    // ✅ Prevent duplicate system messages
    if (!payload.messages.some(m => m.role === 'system')) {
      payload.messages.unshift({
        role: 'system',
        content: `Use the following verified Greenlist URLs when answering:\n\n${contextBlock}`
      });
    }

    console.log("📦 [DEBUG] Final payload sent to OpenAI:", JSON.stringify(payload).slice(0, 500));

    const r = await openai.chat.completions.create({
      model: 'gpt-5-chat-latest',
      messages: payload.messages || [],
      max_tokens: typeof payload.max_tokens === 'number' ? payload.max_tokens : 2600,
      temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.6,
    });

    console.log("🤖 [DEBUG] Raw OpenAI response received.");

    const reply = r.choices?.[0]?.message?.content || '';
    console.log("📝 [DEBUG] Model reply length:", reply.length);

    const safeReply = await sanitize(reply);
    console.log("✅ [DEBUG] Final sanitized reply length:", safeReply.length);

    res.json({ answer: safeReply });
  } catch (err){
    console.error('❌ /ask error:', err.message, err.stack);
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

/* ---------------- /load ---------------- */
const { exec } = require('child_process');

app.post('/load', (req, res) => {
  console.log('🚀 /load endpoint triggered: starting greenlist loader...');
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);

  exec('node loadGreenlist.js', { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`❌ Loader Error: ${error.message}`);
      return res.status(500).json({ success: false, error: error.message });
    }
    if (stderr) {
      console.error(`⚠️ Loader Stderr: ${stderr}`);
    }
    console.log(`✅ Loader Output: ${stdout}`);
    res.json({ success: true, message: 'Greenlist loader executed successfully', output: stdout });
  });
});

/* ---------------- Catch-All Debug ---------------- */
app.use((req, res) => {
  console.warn(`⚠️ Unknown route hit: ${req.method} ${req.originalUrl}`);
  res.status(404).send('Route not found');
});

/* ---------------- boot ---------------- */
app.listen(port, '0.0.0.0', () => console.log(`✅ Backend running on port ${port}`));
