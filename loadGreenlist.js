// loadGreenlist.js
// Script to generate and store embeddings for the DAL AI Greenlist
// Run manually from terminal to populate the database.
//
// Usage: node loadGreenlist.js

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { OpenAI } = require('openai');

// ---------- CONFIG ----------
const dbConfig = {
  user: process.env.PGUSER || process.env.POSTGRES_USER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE || process.env.POSTGRES_DB,
  password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
  port: process.env.PGPORT || 5432,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }, // <-- FIXED
};

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

  // Flatten nested structure (if any categories like "general", "studentServices", etc.)
  greenlist = Object.values(parsed).flat();

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

      // Generate embedding
      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-large',
        input: url,
      });

      const embedding = embeddingResponse.data[0].embedding;

      // Insert into database with duplicate protection
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
