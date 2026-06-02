/**
 * One-off helper: insert a Banking / Financial Services org context that matches
 * SingleView's profile (SAMA-regulated Saudi financial entity) so the policy
 * pipeline's F1 stage classifies SingleView-style documents as relevant.
 *
 * Run with:  node scripts/add-singleview-org.js
 */
const path     = require('path');
const Database = require('better-sqlite3');
const crypto   = require('crypto');

const db = new Database(path.join(__dirname, '..', 'sessions.db'));

const now = new Date().toISOString();
const id  = crypto.randomUUID();

const org = {
  nameEn:               'SingleView Financial Services',
  nameAr:               'سنجل فيو للخدمات المالية',
  sector:               'banking',
  sectorCustom:         '',
  size:                 'medium',
  complianceMaturity:   3,
  regulatoryMandates:   [
    'SAMA Cybersecurity Framework',
    'SAMA Outsourcing Regulations',
    'PDPL',
    'AML/CFT Regulations',
  ],
  governanceStructure:  'Centralized governance with board-level Risk Committee and dedicated Compliance, IT Risk, and Internal Audit functions',
  dataClassification:   'Confidential / Restricted (customer financial data, KYC records, transaction history)',
  geographicScope:      'Saudi Arabia (Kingdom-wide), MENA region',
  itInfrastructure:     'Hybrid cloud (private datacenter + AWS Middle East), core banking on-prem',
  strategicObjectives:  [
    'Maintain full SAMA regulatory compliance',
    'Strengthen third-party / vendor risk management',
    'Achieve 99.95% core banking availability',
    'Expand digital banking products to MENA',
  ],
  obligatoryFrameworks: ['SAMA CSF', 'ISO 27001', 'PCI-DSS', 'PDPL'],
  policies:             [],
  trackingMetrics:      [
    { name: 'Vendor risk assessment completion rate' },
    { name: 'Number of critical third-party incidents per quarter' },
    { name: 'Time-to-onboard new vendor (days)' },
  ],
  riskScenarios: [
    { name: 'Critical vendor service disruption affecting core banking' },
    { name: 'Third-party data breach exposing customer PII' },
    { name: 'SAMA non-compliance finding during audit' },
  ],
  objectiveFrameworkMap: {},
  notes:
    'Saudi-licensed financial services entity regulated by the Saudi Central Bank (SAMA). ' +
    'Heavy reliance on third-party vendors for payments processing, KYC, and cloud infrastructure. ' +
    'Subject to SAMA Outsourcing Regulations and Cybersecurity Framework. ' +
    'Activities: Digital banking, payments, KYC/AML processing, vendor management.',
};

const stmt = db.prepare(`
  INSERT INTO org_contexts (
    id, name_en, name_ar, sector, sector_custom, size, compliance_maturity,
    regulatory_mandates, governance_structure, data_classification,
    geographic_scope, it_infrastructure, strategic_objectives,
    obligatory_frameworks, policies, tracking_metrics, risk_scenarios,
    objective_framework_map, notes, is_active, created_at, updated_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?, ?
  )
`);

stmt.run(
  id,
  org.nameEn,
  org.nameAr,
  org.sector,
  org.sectorCustom,
  org.size,
  org.complianceMaturity,
  JSON.stringify(org.regulatoryMandates),
  org.governanceStructure,
  org.dataClassification,
  org.geographicScope,
  org.itInfrastructure,
  JSON.stringify(org.strategicObjectives),
  JSON.stringify(org.obligatoryFrameworks),
  JSON.stringify(org.policies),
  JSON.stringify(org.trackingMetrics),
  JSON.stringify(org.riskScenarios),
  JSON.stringify(org.objectiveFrameworkMap),
  org.notes,
  1,
  now,
  now,
);

console.log('Inserted org context:');
console.log('  id      :', id);
console.log('  nameEn  :', org.nameEn);
console.log('  sector  :', org.sector);
console.log('  mandates:', org.regulatoryMandates.join(', '));
console.log('');
console.log('Open Pipeline Configuration → Default org selection, pick this org, then re-run the pipeline.');
