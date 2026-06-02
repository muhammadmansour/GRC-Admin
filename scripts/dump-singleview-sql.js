/**
 * Dump the SingleView org_contexts row (from local sessions.db) as
 * idempotent SQL you can paste into the remote SQLite shell.
 *
 * Usage:
 *   node scripts/dump-singleview-sql.js                 # SQLite (default)
 *   node scripts/dump-singleview-sql.js --pg            # PostgreSQL flavour
 *   node scripts/dump-singleview-sql.js --id <uuid>     # pin a specific id
 *   node scripts/dump-singleview-sql.js --db <path>     # read a different sqlite file
 *   node scripts/dump-singleview-sql.js --out seed.sql  # write directly (avoids
 *                                                        PowerShell adding a BOM
 *                                                        when you use `>` to redirect)
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
let outPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--db') dbPath = args[++i];
  else if (args[i] === '--id') pinId = args[++i];
  else if (args[i] === '--pg') pg = true;
  else if (args[i] === '--out') outPath = args[++i];
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

let sqlOut = banner.join('\n');
if (pg) {
  // PostgreSQL flavour: ON CONFLICT (id) DO UPDATE
  sqlOut += 'BEGIN;\n';
  sqlOut += `INSERT INTO org_contexts (\n  ${cols.join(', ')}\n) VALUES (\n  ${vals.join(', ')}\n)\n`;
  sqlOut += 'ON CONFLICT (id) DO UPDATE SET\n';
  const updateCols = cols.filter(c => c !== 'id' && c !== 'created_at');
  sqlOut += updateCols.map(c => `  ${c} = EXCLUDED.${c}`).join(',\n');
  sqlOut += ';\nCOMMIT;\n';
} else {
  // SQLite flavour: INSERT OR REPLACE
  sqlOut += 'BEGIN TRANSACTION;\n';
  sqlOut += `INSERT OR REPLACE INTO org_contexts (\n  ${cols.join(', ')}\n) VALUES (\n  ${vals.join(', ')}\n);\n`;
  sqlOut += 'COMMIT;\n';
}

if (outPath) {
  /* Write through Node's fs so we get plain UTF-8 with no BOM regardless of
     the parent shell — PowerShell's `>` redirect adds a UTF-16 BOM that
     SQLite can't parse, which is exactly what we're avoiding here. */
  fs.writeFileSync(outPath, sqlOut, { encoding: 'utf8' });
  console.error(`\nWrote ${outPath} (${Buffer.byteLength(sqlOut, 'utf8')} bytes, plain UTF-8, no BOM).`);
} else {
  process.stdout.write(sqlOut);
}

console.error(`\n✅ Emitted ${pg ? 'PostgreSQL' : 'SQLite'} SQL for SingleView (id=${row.id}).`);
if (!outPath) {
  console.error('Tip: use --out FILE to avoid shell encoding issues:');
  console.error('     node scripts/dump-singleview-sql.js --out seed.sql');
}
