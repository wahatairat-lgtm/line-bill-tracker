const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && /render\.com|sslmode=require/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined,
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_data (
      user_id       TEXT PRIMARY KEY,
      bills         JSONB NOT NULL DEFAULT '[]'::jsonb,
      known_persons JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      user_id    TEXT PRIMARY KEY,
      state      TEXT NOT NULL DEFAULT 'idle',
      data       JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getUserData(userId) {
  const { rows } = await pool.query(
    'SELECT bills, known_persons FROM user_data WHERE user_id=$1',
    [userId]
  );
  if (!rows.length) return { bills: [], knownPersons: [] };
  return { bills: rows[0].bills, knownPersons: rows[0].known_persons };
}

async function getAllUserData() {
  const { rows } = await pool.query('SELECT user_id, bills FROM user_data');
  return rows.map(r => ({ userId: r.user_id, bills: r.bills || [] }));
}

async function saveUserData(userId, bills, knownPersons) {
  await pool.query(
    `INSERT INTO user_data (user_id, bills, known_persons, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE
       SET bills=$2, known_persons=$3, updated_at=now()`,
    [userId, JSON.stringify(bills || []), JSON.stringify(knownPersons || [])]
  );
}

async function getSession(userId) {
  const { rows } = await pool.query(
    'SELECT state, data FROM user_sessions WHERE user_id=$1',
    [userId]
  );
  if (!rows.length) return { state: 'idle', data: {} };
  return { state: rows[0].state, data: rows[0].data };
}

async function setSession(userId, state, data) {
  await pool.query(
    `INSERT INTO user_sessions (user_id, state, data, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE
       SET state=$2, data=$3, updated_at=now()`,
    [userId, state, JSON.stringify(data || {})]
  );
}

async function clearSession(userId) {
  await pool.query('DELETE FROM user_sessions WHERE user_id=$1', [userId]);
}

module.exports = {
  pool,
  ensureSchema,
  getUserData,
  getAllUserData,
  saveUserData,
  getSession,
  setSession,
  clearSession,
};
