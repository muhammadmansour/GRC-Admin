/**
 * Dump the SingleView org_contexts row (from local sessions.db) as
 * idempotent SQL you can paste into the remote SQLite shell.
 *
 * Usage:
 *   node scripts/dump-singleview-sql.js                 # SQLite (default)
 *   node scripts/dump-singleview-sql.js --pg            # PostgreSQL flavour
 *   node scripts/dump-singleview-sql.js --id <uuid>     # pin a specific id
 *   node scripts/dump-singleview-sql.js --db <path>     # read a different sqlite file
 *
 * Apply on remote:
 *   sqlite3 /path/to/sessions.db < seed.sql
 *   psql "$DATABASE_URL" -f seed.sql                    # if --pg was used
 */
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
let dbPath = path.join(__dirname, '..', 'sessions.db');
let pinId = null;
let pg = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--db') dbPath = args[++i];
  else if (args[i] === '--id') pinId = args[++i];
  else if (args[i] === '--pg') pg = true;
}
if (!fs.existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const row = pinId
  ? db.prepare(`SELECT * FROM org_contexts WHERE id = ?`).get(pinId)
  : db.prepare(`
      SELECT * FROM org_contexts
      WHERE LOWER(name_en) LIKE '%singleview%' OR LOWER(name_en) LIKE '%single view%'
      ORDER BY datetime(updated_at) DESC
      LIMIT 1
    `).get();
if (!row) {
  console.error('No SingleView row found in local DB. Pass --id <uuid> or run the seed script first.');
  process.exit(1);
}

const q = (v) => v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;

const cols = [
  'id', 'name_en', 'name_ar', 'sector', 'sector_custom', 'size', 'compliance_maturity',
  'regulatory_mandates', 'governance_structure', 'data_classification',
  'geographic_scope', 'it_infrastructure', 'strategic_objectives',
  'obligatory_frameworks', 'policies', 'tracking_metrics', 'risk_scenarios',
  'objective_framework_map', 'notes', 'is_active', 'store_id', 'created_at', 'updated_at',
];
const vals = cols.map(c => {
  const v = row[c];
  if (v == null) return 'NULL';
  if (c === 'compliance_maturity' || c === 'is_active') return Number(v);
  return q(v);
});

const banner = [
  '-- ─── SingleView seed for org_contexts ──────────────────────────────────',
  `-- Source DB : ${path.resolve(dbPath)}`,
  `-- Source id : ${row.id}`,
  `-- Generated : ${new Date().toISOString()}`,
  '-- Idempotent: re-running the file replaces the row if the id already exists',
  '-- ────────────────────────────────────────────────────────────────────────',
  '',
];

if (pg) {
  // PostgreSQL flavour: ON CONFLICT (id) DO UPDATE
  process.stdout.write(banner.join('\n'));
  process.stdout.write('BEGIN;\n');
  process.stdout.write(`INSERT INTO org_contexts (\n  ${cols.join(', ')}\n) VALUES (\n  ${vals.join(', ')}\n)\n`);
  process.stdout.write('ON CONFLICT (id) DO UPDATE SET\n');
  const updateCols = cols.filter(c => c !== 'id' && c !== 'created_at');
  process.stdout.write(updateCols.map(c => `  ${c} = EXCLUDED.${c}`).join(',\n'));
  process.stdout.write(';\nCOMMIT;\n');
} else {
  // SQLite flavour: INSERT OR REPLACE
  process.stdout.write(banner.join('\n'));
  process.stdout.write('BEGIN TRANSACTION;\n');
  process.stdout.write(`INSERT OR REPLACE INTO org_contexts (\n  ${cols.join(', ')}\n) VALUES (\n  ${vals.join(', ')}\n);\n`);
  process.stdout.write('COMMIT;\n');
}

console.error(`\n✅ Emitted ${pg ? 'PostgreSQL' : 'SQLite'} SQL for SingleView (id=${row.id}).`);
console.error('Pipe stdout to a file:  node scripts/dump-singleview-sql.js > seed.sql');
