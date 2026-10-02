const { pool, queryPage } = require('../db');
const { NotFound } = require('../errors');

const CENTRE_COLUMNS = 'id, name, address, city, is_active';

// Escape LIKE wildcards so a search for "100%" or "_" matches literally
// instead of matching every row. Postgres uses backslash as the default escape.
const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

async function createTest({ name, description }) {
  const { rows } = await pool.query(
    'INSERT INTO diagnostic_tests (name, description) VALUES ($1, $2) RETURNING id, name, description',
    [name, description ?? null],
  );
  return rows[0];
}

function listTests({ search, limit, offset }) {
  return queryPage({
    columns: 'id, name, description',
    from: 'diagnostic_tests',
    conditions: search ? ['name ILIKE $1'] : [],
    params: search ? [`%${escapeLike(search)}%`] : [],
    orderBy: 'name',
    limit,
    offset,
  });
}

async function createCentre({ name, address, city }) {
  const { rows } = await pool.query(
    `INSERT INTO diagnostic_centres (name, address, city) VALUES ($1, $2, $3) RETURNING ${CENTRE_COLUMNS}`,
    [name, address, city],
  );
  return rows[0];
}

function listCentres({ city, test_id, include_inactive, limit, offset }) {
  const conditions = [];
  const params = [];
  if (!include_inactive) conditions.push('c.is_active');
  if (city) {
    params.push(city.toLowerCase());
    conditions.push(`lower(c.city) = $${params.length}`);
  }
  if (test_id) {
    params.push(test_id);
    conditions.push(
      `EXISTS (SELECT 1 FROM centre_tests ct WHERE ct.centre_id = c.id AND ct.test_id = $${params.length} AND ct.is_available)`,
    );
  }
  return queryPage({
    columns: 'c.id, c.name, c.address, c.city, c.is_active',
    from: 'diagnostic_centres c',
    conditions,
    params,
    orderBy: 'c.id',
    limit,
    offset,
  });
}

async function listOfferings(centreId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.description, ct.price, ct.is_available
     FROM centre_tests ct JOIN diagnostic_tests t ON t.id = ct.test_id
     WHERE ct.centre_id = $1 ORDER BY t.name`,
    [centreId],
  );
  return rows.map((r) => ({
    test: { id: r.id, name: r.name, description: r.description },
    price: r.price,
    is_available: r.is_available,
  }));
}

/** Fetch a centre or throw 404. */
async function requireCentre(centreId) {
  const { rows } = await pool.query(
    `SELECT ${CENTRE_COLUMNS} FROM diagnostic_centres WHERE id = $1`,
    [centreId],
  );
  if (!rows[0]) throw NotFound('Diagnostic centre not found');
  return rows[0];
}

async function getCentre(centreId) {
  const centre = await requireCentre(centreId);
  return { ...centre, offerings: await listOfferings(centreId) };
}

async function updateCentre(centreId, fields) {
  await requireCentre(centreId);
  const keys = Object.keys(fields); // already whitelisted by the zod schema
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const { rows } = await pool.query(
    `UPDATE diagnostic_centres SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${CENTRE_COLUMNS}`,
    [centreId, ...keys.map((k) => fields[k])],
  );
  return rows[0];
}

/** Add a test to a centre, or update its price/availability. Existing bookings keep their price. */
async function upsertOffering(centreId, { test_id, price, is_available }) {
  await requireCentre(centreId);
  const test = await pool.query('SELECT id, name, description FROM diagnostic_tests WHERE id = $1', [test_id]);
  if (!test.rows[0]) throw NotFound('Diagnostic test not found');
  const { rows } = await pool.query(
    `INSERT INTO centre_tests (centre_id, test_id, price, is_available) VALUES ($1, $2, $3, $4)
     ON CONFLICT (centre_id, test_id)
     DO UPDATE SET price = EXCLUDED.price, is_available = EXCLUDED.is_available, updated_at = now()
     RETURNING price, is_available`,
    [centreId, test_id, price, is_available],
  );
  return { test: test.rows[0], ...rows[0] };
}

module.exports = {
  createTest,
  listTests,
  createCentre,
  listCentres,
  getCentre,
  listOfferings,
  updateCentre,
  upsertOffering,
};
