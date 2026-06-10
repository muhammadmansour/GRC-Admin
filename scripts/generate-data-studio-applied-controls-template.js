/**
 * Generates templates/data-studio-applied-controls-import-template.xlsx
 *
 * Sheet shape matches the Data Studio applied-controls importer
 * (server.js → dsNormalizeImportRow / dsBuildDescriptionFromRow):
 *
 *   Primary columns (read by dsNormalizeImportRow):
 *     - ref_id   ≡ كود المتطلب  ≡ "Ref ID"  ≡ requirement_ref
 *     - name     ≡ اسم الكنترول ≡ "Name"    ≡ control_name
 *     - description (optional; auto-built from the Arabic context columns
 *       below when missing)
 *
 *   Optional context columns (used to auto-build description if it is blank):
 *     - كود المنظور / اسم المنظور                (perspective code / name)
 *     - كود المحور  / اسم المحور                 (axis code / name)
 *     - كود المعيار / اسم المعيار                (standard code / name)
 *     - نص المتطلب بحسب وثيقة هيئة الحكومة الرقمية (requirement text)
 *
 * Run:  npm run generate:applied-controls-import-template
 */
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// English-first header layout, with the same column aliases the importer accepts.
// The importer reads each row case-sensitively against the listed aliases, so any
// of these column names will work — keep this layout to give users both forms.
const headers = [
  'ref_id',
  'name',
  'description',
  // Arabic context columns (used only if `description` is blank).
  'كود المنظور',
  'اسم المنظور',
  'كود المحور',
  'اسم المحور',
  'كود المعيار',
  'اسم المعيار',
  'نص المتطلب بحسب وثيقة هيئة الحكومة الرقمية',
];

// Example rows — first uses English columns only, second mixes Arabic context
// to demonstrate auto-built description, third shows a typical Qyias-style row.
const rows = [
  [
    'AC-001',
    'Multi-factor authentication enforcement',
    'MFA required for all administrative and remote access to information systems.',
    '', '', '', '', '', '', '',
  ],
  [
    '5.1.1',
    'Identity & access management policy',
    '', // intentionally blank → importer builds description from Arabic context cols
    'P1', 'حوكمة الأمن السيبراني',
    'M5', 'إدارة الهويات والصلاحيات',
    'S1', 'سياسة إدارة الهويات والصلاحيات',
    'يجب على الجهة وضع وتوثيق سياسة لإدارة الهويات والصلاحيات بما يتوافق مع متطلبات الجهات التشريعية.',
  ],
  [
    '5.1.1.3',
    'Privileged access review (quarterly)',
    'Quarterly review of privileged accounts by the information security function. Evidence: signed PAM review report.',
    '', '', '', '', '', '', '',
  ],
];

const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
ws['!cols'] = [
  { wch: 14 },  // ref_id
  { wch: 44 },  // name
  { wch: 60 },  // description
  { wch: 14 },  // كود المنظور
  { wch: 28 },  // اسم المنظور
  { wch: 14 },  // كود المحور
  { wch: 28 },  // اسم المحور
  { wch: 14 },  // كود المعيار
  { wch: 28 },  // اسم المعيار
  { wch: 60 },  // نص المتطلب …
];

const instructions = [
  ['Data Studio · Applied controls import — POST /api/applied-controls/'],
  [''],
  ['Sheet → request mapping'],
  ['  Each row creates one applied control via POST /api/applied-controls/'],
  ['  folder is NOT a column — choose the GRC folder in Data Studio before import.'],
  ['  Only the first worksheet (Applied Controls) is read.'],
  ['  Column headers come from row 1; extra / unknown columns are ignored.'],
  [''],
  ['Required columns'],
  ['  name           Control name. Accepted aliases: name | Name | control_name | اسم الكنترول'],
  [''],
  ['Recommended columns'],
  ['  ref_id         Requirement ref (e.g. 5.1.1, AC-001). Used to link the control'],
  ['                  to an existing requirement assessment in the chosen audit.'],
  ['                  Aliases: ref_id | Ref ID | requirement_ref | كود المتطلب'],
  ['  description    Free-text description. Aliases: description | Description | full_description'],
  ['                  If left blank, the importer builds one from the Arabic context'],
  ['                  columns below (perspective + axis + standard + requirement text).'],
  [''],
  ['Optional context columns (auto-fill description when description is blank)'],
  ['  كود المنظور / اسم المنظور                          (perspective code & name)'],
  ['  كود المحور  / اسم المحور                           (axis code & name)'],
  ['  كود المعيار / اسم المعيار                          (standard code & name)'],
  ['  نص المتطلب بحسب وثيقة هيئة الحكومة الرقمية         (requirement text — Qyias-style)'],
  [''],
  ['Server-side defaults (set automatically per row)'],
  ['  status         = "to_do"'],
  ['  csf_function   = "govern"'],
  ['  folder         = the folder you choose in Data Studio'],
  [''],
  ['Canonical CISO Assistant AppliedControl writable fields'],
  ['(currently ignored by the Data Studio importer — track in product roadmap)'],
  ['  ref_id, name, description, status, category, csf_function, priority (1-4),'],
  ['  effort (S/M/L/XL/XXL), control_impact (1-5), start_date, eta, expiry_date,'],
  ['  link, observation, reference_control, owner, evidence_link, is_published.'],
  [''],
  ['Tip — Qyias / MHRSD 4-level refs'],
  ['  Sheet rows like 5.1.1.3 attach to the parent standard 5.1.1 in the audit'],
  ['  when the framework only assesses 3 levels. Toggle off by sending'],
  ['  rollUpUnknownRefs: false in the API body (advanced).'],
];

const wsHelp = XLSX.utils.aoa_to_sheet(instructions);
wsHelp['!cols'] = [{ wch: 100 }];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Applied Controls');
XLSX.utils.book_append_sheet(wb, wsHelp, 'Instructions');

const outDir = path.join(__dirname, '..', 'templates');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'data-studio-applied-controls-import-template.xlsx');
XLSX.writeFile(wb, outFile);
console.log('Wrote', path.resolve(outFile));
