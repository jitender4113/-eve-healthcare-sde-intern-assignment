const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({ connectionString: config.databaseUrl });

/**
 * Run `fn(client)` inside a transaction. Commits if it resolves, rolls back
 * if it throws. Every multi-step write goes through here.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * One page of a list query plus the total number of matching rows, in the
 * response shape every list endpoint shares: { items, total, limit, offset }.
 *
 * `columns`, `from`, `conditions` and `orderBy` are SQL fragments written by
 * the calling service, never user input. Anything user-supplied must go
 * through `params` and be referenced as $1..$n inside `conditions`.
 */
async function queryPage({ columns, from, conditions = [], params = [], orderBy, limit, offset }) {
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [items, count] = await Promise.all([
    pool.query(
      `SELECT ${columns} FROM ${from} ${where} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    pool.query(`SELECT count(*)::int AS n FROM ${from} ${where}`, params),
  ]);
  return { items: items.rows, total: count.rows[0].n, limit, offset };
}

module.exports = { pool, withTransaction, queryPage };
