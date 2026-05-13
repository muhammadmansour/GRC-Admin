# WathbahGRC Admin — External Data Sources
**Snapshot taken:** 2026-04-14
**Commit / branch:** a03a947 / db-scheme-changes
**Scope of this file:** External data sources, ingestion logic, and refresh cadence.

## External Data Sources

### 1. GRC Entity Data (via CISO Assistant API)

**Source:** `https://stage-hrsd.wathbahs.com`

**Entities pulled:**
- Frameworks (name, ref_id, description)
- Requirement Nodes (name, description, urn, parent)
- Compliance Assessments (name, framework, folder)
- Requirement Assessments (status, requirement, compliance assessment)
- Applied Controls (name, description, category, status, folder)
- Risk Scenarios (name, description, treatment, existing controls)
- Reference Controls (name, description, category)
- Threats (name, description)
- Evidences (name, description)
- Folders / Domains / Perimeters

**Caching:** Fetched entities stored in `ciso_entity_cache` table with 30-minute TTL per entity type (`server.js:417–445`). Cache key = `entity_type`. Cache is per-user (no user scoping — another gap, see `08-gaps`).

**Pagination:** Helper fetches all pages via `?page=1&page_size=500` and follows `next` links (`server.js:449–466`).

### 2. Muraji Library Data (via Muraji API)

**Source:** `https://muraji-api.wathbahs.com/api/libraries`

**Entities pulled (by frontend):**
- Libraries (id, name, controls list)
- Each control includes: requirement node IDs, questions, typical evidence

**Caching:** None — fetched on every page load.

### 3. Muraji Prompt Data (via Muraji API)

**Source:** `https://muraji-api.wathbahs.com/api/prompts`

**Entities pulled (by frontend):**
- Prompt templates (id, name, content)

**Caching:** None — fetched on every page load.

### 4. User-Uploaded Documents

**Source:** Direct file upload from browser

**Types:**
- Policy documents (PDF, DOCX) → `policy-uploads/` directory → uploaded to Gemini File Search Store
- Attachment files for organization contexts

**Refresh:** No refresh — one-time upload, processed by AI, results stored locally.

## Refresh Cadence Summary

| Source | TTL / Refresh | Mechanism |
|---|---|---|
| GRC entities | 30 min | `ciso_entity_cache` table, checked on read |
| Muraji libraries | None (fresh every load) | Direct fetch |
| Muraji prompts | None (fresh every load) | Direct fetch |
| Uploaded documents | N/A | One-time ingestion |
