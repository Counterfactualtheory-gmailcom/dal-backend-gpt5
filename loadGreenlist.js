// loadGreenlist.js
// Script to generate and store embeddings for the DAL AI Greenlist
// Run manually from terminal to populate the database.

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
  ssl: { rejectUnauthorized: false },
};

const pool = new Pool(dbConfig);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- STEP 1: Load URLs ----------
const urlsPath = path.join(__dirname, 'urls.json');
if (!fs.existsSync(urlsPath)) {
  console.error('❌ ERROR: urls.json file not found.');
  process.exit(1);
}

const greenlist = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
if (!Array.isArray(greenlist) || greenlist.length === 0) {
  console.error('❌ ERROR: urls.json must contain a non-empty array.');
  process.exit(1);
}

console.log(`✅ Loaded ${greenlist.length} Greenlist URLs.`);

// ---------- STEP 2: Insert Embeddings ----------
async function generateAndInsertEmbeddings() {
  for (const url of greenlist) {
    try {
      console.log(`🔹 Processing: ${url}`);

      // Generate embedding using OpenAI
      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-large',
        input: url,
      });

      const embedding = embeddingResponse.data[0].embedding;

      // Insert into database
      await pool.query(
        `INSERT INTO greenlist_embeddings (content, embedding)
         VALUES ($1, $2)`,
        [url, embedding]
      );

      console.log(`✅ Inserted: ${url}`);
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
