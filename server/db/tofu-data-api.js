// Tofu (2026-10-25): this file is Tofu's addition; it is not part of upstream Wiki.js.
// Tofu (2026-10-26): the schema lock and the tables of the server's own stores are new, and row-level security covers
// every table Wiki.js's role owns in its schema, in one round trip.

/* global WIKI */

// The key of the advisory lock every start of Wiki.js takes before it touches the schema (server/core/db.js), and the
// PostgreSQL search engine before it makes its index tables (server/modules/search/postgres/engine.js). Any fixed
// number does, as long as every server of the same wiki uses it.
const SCHEMA_LOCK = 7207262610

// How long a start waits for another start's schema work before it gives up, which fails that start.
const SCHEMA_LOCK_WAIT = '180s'

/**
 * Takes Wiki.js's schema lock in `trx`, a transaction, before anything else in it: pg_advisory_xact_lock, which
 * PostgreSQL holds until that transaction ends. Through a transaction pooler (Tofu's DATABASE_URL, port 6543) one
 * transaction runs on one server connection from its BEGIN to its COMMIT, so the lock holds for exactly as long as the
 * work it guards. A session lock (pg_advisory_lock) would stay with a server connection the pooler hands to other
 * clients between transactions. The wait is bounded by lock_timeout, for this transaction only (SET LOCAL); a start
 * that waited finds the schema as the start before it left it, because everything after the lock reads it afresh.
 */
async function lockSchema (trx) {
  await trx.raw(`SET LOCAL lock_timeout = '${SCHEMA_LOCK_WAIT}'; SELECT pg_advisory_xact_lock(${SCHEMA_LOCK})`)
}

// The key of the lock under which the page tree is replaced (server/jobs/rebuild-tree.js), which every start does.
const PAGE_TREE_LOCK = 7207262611

/**
 * Takes the page tree's lock in `trx`, a transaction, the same way as lockSchema: the rebuilds of several servers that
 * start at once then replace the tree one after the other instead of inserting the same rows at the same moment.
 */
async function lockPageTree (trx) {
  await trx.raw(`SET LOCAL lock_timeout = '${SCHEMA_LOCK_WAIT}'; SELECT pg_advisory_xact_lock(${PAGE_TREE_LOCK})`)
}

// The tables Wiki.js's server makes for itself when it starts past the setup: `sessions`, connect-session-knex
// 2.0.0's (server/master.js), and `brute`, the sign-in lockout's (server/controllers/auth.js,
// server/helpers/brute-knex.js). This is the SQL knex 0.21 writes for them. Made in the locked step, the stores find
// them and make nothing, so no two servers make them at the same moment.
const STORE_TABLES = `
CREATE TABLE IF NOT EXISTS "sessions" ("sid" varchar(255), "sess" json NOT NULL, "expired" timestamptz NOT NULL, CONSTRAINT "sessions_pkey" PRIMARY KEY ("sid"));
CREATE INDEX IF NOT EXISTS "sessions_expired_index" ON "sessions" ("expired");
CREATE TABLE IF NOT EXISTS "brute" ("key" varchar(255), "firstRequest" bigint NULL, "lastRequest" bigint NULL, "lifetime" bigint NULL, "count" integer);
`

/**
 * Row-level security, with no policy, on every table of Wiki.js's schema that Wiki.js's role owns and that does not
 * have it yet, on a database with the roles Supabase's Data API uses (anon, authenticated): the tables its migrations
 * make, knex's `migrations` and `migrations_lock`, `sessions` and `brute`, and `pagesVector` and `pagesWords` once the
 * PostgreSQL search engine makes them. On a database whose default privileges still give every new table in its schema
 * to those roles, anyone holding the project's public key could otherwise read and change them through the Data API:
 * `users` with its password hashes, `settings` with the key that signs sign-ins, `sessions` with sign-in state and
 * `brute` with the counters that lock out password guessing among them. Those roles then see no row, while Wiki.js's
 * own connection, which owns the tables, is not limited by it. It only ever turns row-level security on, and on any
 * other PostgreSQL it does nothing. One round trip: the count of the tables it closes, then a DO block that closes them.
 */
function rowLevelSecurity (schema) {
  const name = `'${schema.replace(/'/g, "''")}'`
  const open = `
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${name} AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
      AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))`
  return `
SELECT count(*)::int AS open ${open};
DO $tofu$
DECLARE t record;
BEGIN
  FOR t IN SELECT n.nspname, c.relname ${open} LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.nspname, t.relname);
  END LOOP;
END
$tofu$;
`
}

async function run (knex, sql) {
  const results = await knex.raw(sql)
  const counted = (Array.isArray(results) ? results : [results]).find(r => r && r.rows && r.rows[0] && 'open' in r.rows[0])
  const closed = counted ? counted.rows[0].open : 0
  if (closed > 0) {
    WIKI.logger.info(`Enabled row-level security on ${closed} of Wiki.js's tables for Supabase's Data API: [ OK ]`)
  }
  return closed
}

/**
 * The end of a start's locked schema step (server/core/db.js), after the migrations: the stores' tables, then
 * row-level security, in one round trip.
 */
async function afterMigrations (trx) {
  return run(trx, STORE_TABLES + rowLevelSecurity(WIKI.config.db.schema || 'public'))
}

/**
 * Row-level security alone (see rowLevelSecurity), for tables made later: the PostgreSQL search engine's.
 */
async function closeToDataApi (knex) {
  if (WIKI.config.db.type !== 'postgres') {
    return 0
  }
  return run(knex, rowLevelSecurity(WIKI.config.db.schema || 'public'))
}

/**
 * Whether `err` is PostgreSQL saying that an object a start meant to make is already there (duplicate table, object,
 * schema or function, or the catalog's unique index on type names that CREATE TABLE meets). The locked step is tried
 * once more after one of these.
 */
function isDuplicate (err) {
  return Boolean(err) && ['42P07', '42710', '42P06', '42723', '23505'].includes(err.code)
}

module.exports = { lockSchema, lockPageTree, afterMigrations, closeToDataApi, isDuplicate }
