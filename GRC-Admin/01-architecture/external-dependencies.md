# WathbahGRC Admin — External Dependencies
**Snapshot taken:** 2026-04-14
**Commit / branch:** a03a947 / db-scheme-changes
**Scope of this file:** All third-party services the code communicates with.

## Third-Party Services

### 1. Google Gemini AI (via `@google/genai` SDK + REST)

| Aspect | Detail |
|---|---|
| SDK | `@google/genai` ^1.41.0 — used for chat sessions, cached content, file search grounding |
| REST | Direct `fetch()` calls to `generativelanguage.googleapis.com/v1beta` for analysis endpoints |
| Model | `gemini-2.5-pro` (hardcoded in multiple places) |
| Credential | `GEMINI_API_KEY` env var |
| Features Used | `generateContent`, `caches.create`, `chats.create`, File Search Stores (create/list/delete/upload/documents), resumable uploads |

**Wiring:** `server.js` — scattered across ~20 functions. No single module encapsulates Gemini access.

### 2. WathbahGRC (CISO Assistant) API

| Aspect | Detail |
|---|---|
| Base URL | `GRC_API_URL` env var, defaults to `https://stage-hrsd.wathbahs.com` |
| Auth | Token-based — user logs into Admin, which forwards credentials to `GRC_API_URL/api/iam/login/`. The returned GRC token is stored in-memory and forwarded on subsequent requests. |
| Endpoints consumed | `/api/iam/login/`, `/api/frameworks/`, `/api/requirement-nodes/`, `/api/compliance-assessments/`, `/api/requirement-assessments/`, `/api/applied-controls/`, `/api/organisation-objectives/`, `/api/risk-scenarios/`, `/api/folders/`, `/api/stored-libraries/upload/`, `/api/reference-controls/`, `/api/metrology/metric-instances/` |
| Wiring | `grcFetch()` helper at `server.js:57–64`, proxy endpoints at `server.js:2028–2500` |

### 3. Muraji API (External prompt/library management)

| Aspect | Detail |
|---|---|
| Base URL | `https://muraji-api.wathbahs.com` |
| Endpoints | `/api/libraries` (GET), `/api/libraries/:id/controls` (PATCH), `/api/prompts` (CRUD + cache clear) |
| Auth | None visible — no API key or token sent |
| Wiring | Called from frontend JavaScript (`app.js:6`, `prompts.js:6`), not from server.js |

### 4. No Other Services

- No Mailgun, Sendgrid, or email service
- No auth providers (OAuth, SAML, etc.) — auth is delegated to CISO Assistant's IAM
- No S3, GCS, or cloud storage — files stored locally on disk + Gemini File Search Stores
- No Redis, Memcached, or external cache
- No monitoring/APM (Datadog, Sentry, etc.)
