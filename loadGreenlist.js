// loadGreenlist.js
// Script to generate and store embeddings for the DAL AI Greenlist
// Usage: node loadGreenlist.js

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { OpenAI } = require('openai');

// ---------- CONFIG ----------
const isInternalHost = /\.railway\.internal$/i.test(String(process.env.PGHOST || ''));
const dbConfig = {
  user: process.env.PGUSER || process.env.POSTGRES_USER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE || process.env.POSTGRES_DB,
  password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
  port: process.env.PGPORT || 5432,
  // 🔧 Key change: internal host → no SSL, otherwise SSL on
  ssl: isInternalHost ? false : { rejectUnauthorized: false },
};

console.log(
  `PGCONNECT host=${process.env.PGHOST} port=${process.env.PGPORT} db=${process.env.PGDATABASE || process.env.POSTGRES_DB} ssl=${isInternalHost ? 'disabled' : 'enabled'}`
);

const pool = new Pool(dbConfig);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- STEP 1: Load URLs ----------
const urlsPath = path.join(__dirname, 'urls.json');

if (!fs.existsSync(urlsPath)) {
  console.error('❌ ERROR: urls.json file not found in current directory.');
  process.exit(1);
}

let greenlist;
try {
  const rawData = fs.readFileSync(urlsPath, 'utf8');
  const parsed = JSON.parse(rawData);
  greenlist = Array.isArray(parsed) ? parsed : Object.values(parsed).flat();
  if (!Array.isArray(greenlist) || greenlist.length === 0) {
    throw new Error('urls.json must contain a non-empty array of URLs.');
  }
  console.log(`✅ Loaded ${greenlist.length} total Greenlist URLs.`);
  console.log('🔹 First 5 URLs:', greenlist.slice(0, 5));
} catch (err) {
  console.error('❌ ERROR: Failed to parse urls.json →', err.message);
  process.exit(1);
}

// ---------- STEP 2: Create Table if Needed ----------
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS greenlist_embeddings (
      id SERIAL PRIMARY KEY,
      content TEXT UNIQUE NOT NULL,
      embedding VECTOR(1536)
    );
  `);
  console.log('✅ Verified that greenlist_embeddings table exists.');
}

// ---------- STEP 3: Generate and Insert Embeddings ----------
async function generateAndInsertEmbeddings() {
  await ensureTable();

  for (const url of greenlist) {
    try {
      console.log(`🔹 Processing URL: ${url}`);

      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-large',
        input: url,
      });

      const embedding = embeddingResponse.data[0].embedding;

      await pool.query(
        `INSERT INTO greenlist_embeddings (content, embedding)
         VALUES ($1, $2)
         ON CONFLICT (content) DO NOTHING`,
        [url, embedding]
      );

      console.log(`✅ Inserted successfully: ${url}`);
    } catch (err) {
      console.error(`❌ Failed to process ${url}:`, err.message);
    }
  }

  console.log('🎉 Greenlist embedding population complete!');
  await pool.end();
}

// ---------- RUN ----------
generateAndInsertEmbeddings().catch(err => {
  console.error('❌ Fatal Error:', err.message);
  process.exit(1);
});
