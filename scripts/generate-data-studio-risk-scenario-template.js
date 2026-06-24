/**
 * Generates templates/data-studio-risk-scenarios-import-template.xlsx
 * Scenarios sheet columns map to POST /api/risk-scenarios/ JSON (risk_assessment is optional if set in Data Studio Step 3).
 * Run: npm run generate:risk-scenario-import-template
 */
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

/** Minimal: name required; assessment UUID usually from Step 3 field. Column risk_assessment overrides per row if needed. */
const headers = ['name', 'description', 'ref_id'];

const rows = [
  ['Loss of SaaS payroll availability', 'Cloud vendor outage cascades to HR operations.', 'RS-OPS-001'],
  ['Privileged account misuse', 'Insider threat on shared admin workstations.', 'RS-IAM-002'],
];

const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
ws['!cols'] = [{ wch: 44 }, { wch: 58 }, { wch: 16 }];

const instructions = [
  ['Data Studio · Risk scenario import — POST /api/risk-scenarios/'],
  [''],
  ['What is imported'],
  ['Each row becomes one POST to GRC. Headers must match writable field names from OpenAPI (see GET /api/schema/).'],
  ['risk_assessment is usually taken from Step 3 in the wizard; add column risk_assessment to override some rows only.'],
  ['Only the first worksheet (Scenarios) is read.'],
  [''],
  ['Suggested columns'],
  ['name · Required.', ''],
  ['description · Optional.', ''],
  ['ref_id · Optional.', ''],
  ['observation · Optional (add column with exact API name).', ''],
];

const wsHelp = XLSX.utils.aoa_to_sheet(instructions);
wsHelp['!cols'] = [{ wch: 78 }, { wch: 8 }];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Scenarios');
XLSX.utils.book_append_sheet(wb, wsHelp, 'Instructions');

const outDir = path.join(__dirname, '..', 'templates');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'data-studio-risk-scenarios-import-template.xlsx');
XLSX.writeFile(wb, outFile);
console.log('Wrote', path.resolve(outFile));
