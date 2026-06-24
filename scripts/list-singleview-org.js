/**
 * Read-only inspector: prints any SingleView-shaped org_contexts rows in the
 * local sessions.db (or any DB given via --db <path>).
 *
 * Usage:
 *   node scripts/list-singleview-org.js
 *   node scripts/list-singleview-org.js --db /path/to/sessions.db
 *   node scripts/list-singleview-org.js --json     # raw JSON
 */
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
let dbPath = path.join(__dirname, '..', 'sessions.db');
let asJson = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--db')   dbPath = args[++i];
  if (args[i] === '--json') asJson = true;
}

if (!fs.existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

const rows = db.prepare(`
  SELECT *
  FROM org_contexts
  WHERE
    LOWER(name_en)   LIKE '%singleview%' OR
    LOWER(name_en)   LIKE '%single view%' OR
    name_ar          LIKE '%سنجل%' OR
    notes            LIKE '%SingleView%' OR
    sector           = 'banking'
  ORDER BY datetime(updated_at) DESC
`).all();

const safeJson = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
const formatted = rows.map(r => ({
  id: r.id,
  name_en: r.name_en,
  name_ar: r.name_ar,
  sector: r.sector,
  size: r.size,
  compliance_maturity: r.compliance_maturity,
  is_active: r.is_active,
  regulatory_mandates: safeJson(r.regulatory_mandates, []),
  obligatory_frameworks: safeJson(r.obligatory_frameworks, []),
  strategic_objectives: safeJson(r.strategic_objectives, []),
  tracking_metrics: safeJson(r.tracking_metrics, []),
  risk_scenarios: safeJson(r.risk_scenarios, []),
  governance_structure: r.governance_structure,
  data_classification: r.data_classification,
  geographic_scope: r.geographic_scope,
  it_infrastructure: r.it_infrastructure,
  notes: r.notes,
  created_at: r.created_at,
  updated_at: r.updated_at,
}));

if (asJson) {
  process.stdout.write(JSON.stringify(formatted, null, 2) + '\n');
  process.exit(0);
}

console.log(`DB: ${dbPath}`);
console.log(`Match count: ${formatted.length}\n`);
if (!formatted.length) {
  console.log('No SingleView-shaped org_contexts row found.');
  console.log('Run scripts/add-singleview-org.js (or your remote seed script) first.');
  process.exit(0);
}
formatted.forEach((o, i) => {
  console.log(`── #${i + 1} ──────────────────────────────────────────────`);
  console.log(`id          : ${o.id}`);
  console.log(`name_en     : ${o.name_en}`);
  console.log(`name_ar     : ${o.name_ar}`);
  console.log(`sector      : ${o.sector}`);
  console.log(`size        : ${o.size}`);
  console.log(`maturity    : ${o.compliance_maturity}`);
  console.log(`is_active   : ${o.is_active}`);
  console.log(`mandates    : ${o.regulatory_mandates.join(', ')}`);
  console.log(`frameworks  : ${o.obligatory_frameworks.join(', ')}`);
  console.log(`objectives  : ${o.strategic_objectives.length} item(s)`);
  o.strategic_objectives.forEach(s => console.log(`              - ${s}`));
  console.log(`metrics     : ${o.tracking_metrics.length} item(s)`);
  o.tracking_metrics.forEach(m => console.log(`              - ${m.name || m}`));
  console.log(`risks       : ${o.risk_scenarios.length} item(s)`);
  o.risk_scenarios.forEach(r => console.log(`              - ${r.name || r}`));
  console.log(`governance  : ${o.governance_structure}`);
  console.log(`data class. : ${o.data_classification}`);
  console.log(`geo scope   : ${o.geographic_scope}`);
  console.log(`infra       : ${o.it_infrastructure}`);
  console.log(`notes       : ${o.notes}`);
  console.log(`created_at  : ${o.created_at}`);
  console.log(`updated_at  : ${o.updated_at}`);
  console.log('');
});
