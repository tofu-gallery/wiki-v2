// Tofu (2026-10-25): this file is Tofu's addition; it is not part of upstream Wiki.js.

/* global WIKI */

// Wiki.js's own tables: the ones its migrations make (server/db/migrations), knex's record of those migrations, and
// the two the PostgreSQL search engine makes when an admin turns it on (server/modules/search/postgres/engine.js).
// Their names are plain identifiers, which is what makes the array literal below safe.
const TABLES = [
  'analytics', 'apiKeys', 'assetData', 'assetFolders', 'assets', 'authentication', 'commentProviders', 'comments',
  'editors', 'groups', 'locales', 'loggers', 'navigation', 'pageHistory', 'pageHistoryTags', 'pageLinks', 'pageTags',
  'pageTree', 'pages', 'renderers', 'searchEngines', 'settings', 'storage', 'tags', 'userAvatars', 'userGroups',
  'userKeys', 'users', 'migrations', 'migrations_lock', 'pagesVector', 'pagesWords'
]

/**
 * Turns on row-level security for Wiki.js's own tables in its schema of a Supabase database: one that has the roles
 * Supabase's Data API uses, anon or authenticated. On a database whose default privileges still give every new table
 * in public to those roles, Wiki.js's tables would otherwise be readable and writable through the Data API by anyone
 * holding the project's public key, `users` with its password hashes and `settings` with the key that signs sign-ins
 * among them. With row-level security on and no policy, those roles see no row, while Wiki.js's own connection, which
 * owns the tables, is not limited by it.
 *
 * It only ever turns row-level security on: a table that already has it, a table Wiki.js's role does not own, and any
 * table that is not one of Wiki.js's own are left as they are. On any other PostgreSQL it does nothing. A failure is
 * logged, and Wiki.js starts anyway.
 */
module.exports = async function closeToDataApi (knex) {
  if (WIKI.config.db.type !== 'postgres') {
    return
  }
  try {
    const roles = await knex.raw(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) AS found`)
    if (!roles.rows[0].found) {
      return
    }
    const schema = WIKI.config.db.schema || 'public'
    const open = await knex.raw(`
      SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ?
        AND c.relkind IN ('r', 'p')
        AND NOT c.relrowsecurity
        AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        AND c.relname = ANY(?::text[])
      ORDER BY c.relname`, [schema, `{${TABLES.join(',')}}`])
    for (const row of open.rows) {
      await knex.raw('ALTER TABLE ??.?? ENABLE ROW LEVEL SECURITY', [schema, row.name])
    }
    if (open.rows.length > 0) {
      WIKI.logger.info(`Enabled row-level security on ${open.rows.length} of Wiki.js's tables for Supabase's Data API: [ OK ]`)
    }
  } catch (err) {
    WIKI.logger.warn(`Could not enable row-level security on Wiki.js's tables for Supabase's Data API: ${err.message}`)
  }
}
