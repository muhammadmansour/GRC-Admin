/**
 * Generates templates/data-studio-policies-import-template.xlsx
 * Policies sheet = only columns that map to POST /api/policies/ JSON (excluding folder — set in UI).
 * Run: npm run generate:policy-import-template
 */
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

/** Minimal body: name (required) + description (optional). Add more columns anytime using exact API field names. */
const headers = ['name', 'description'];

const rows = [
  [
    'Acceptable use policy',
    'Defines acceptable use of organization IT assets and messaging.',
  ],
  [
    'Data classification policy',
    'Labels and handling for confidential, internal, and public information.',
  ],
];

const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
ws['!cols'] = [{ wch: 36 }, { wch: 62 }];

const instructions = [
  ['Data Studio · Policy import — POST body columns only'],
  [''],
  ['What is imported'],
  ['Each row becomes one JSON body for POST /api/policies/. Column headers must match writable field names (see GRC OpenAPI / Policy create).'],
  ['folder is not a column — choose it in Data Studio before import.'],
  ['Only the first worksheet (Policies) is read.'],
  [''],
  ['This template columns'],
  ['name', 'Required in GRC. Included in every POST.'],
  ['description', 'Optional. Omit the column or leave cells blank if unused.'],
  [''],
  ['Add more columns'],
  ['Use the same spelling as the API: ref_id, status, csf_function, priority, reference_control,'],
  ['effort, control_impact, start_date, eta, expiry_date, link, progress_field, observation,'],
  ['is_published, etc. Unknown or empty cells are skipped.'],
];

const wsHelp = XLSX.utils.aoa_to_sheet(instructions);
wsHelp['!cols'] = [{ wch: 78 }, { wch: 76 }];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Policies');
XLSX.utils.book_append_sheet(wb, wsHelp, 'Instructions');

const outDir = path.join(__dirname, '..', 'templates');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'data-studio-policies-import-template.xlsx');
XLSX.writeFile(wb, outFile);
console.log('Wrote', path.resolve(outFile));
