# WathbahGRC Admin — Cross-App API Calls
**Snapshot taken:** 2026-04-14
**Commit / branch:** a03a947 / db-scheme-changes
**Scope of this file:** API calls from this project to external services, direction, auth, and data exchanged.

## 1. WathbahGRC (CISO Assistant) API

| Aspect | Detail |
|---|---|
| **Base URL** | `https://stage-hrsd.wathbahs.com` (from `GRC_API_URL` env var) |
| **Direction** | Admin → GRC (this project calls GRC; GRC never calls back) |
| **Auth** | Bearer token from logged-in user's GRC session |
| **Protocol** | REST / JSON |

### Endpoints Called

| Endpoint | Method | Purpose | Evidence |
|---|---|---|---|
| `/api/iam/login/` | POST | Login to get GRC token | `server.js:1898` |
| `/api/iam/current-user/` | GET | Validate token / get user info | `server.js:1860` |
| `/api/frameworks/` | GET | List/fetch frameworks | via `grcFetch()` |
| `/api/requirement-nodes/` | GET | List/fetch requirement nodes | via `grcFetch()` |
| `/api/compliance-assessments/` | GET/POST | List, create compliance assessments | `server.js:539, 550` |
| `/api/requirement-assessments/` | GET/PATCH | List, update requirement assessments | `server.js:577, 629` |
| `/api/applied-controls/` | GET/POST | List, create applied controls | `server.js:2270, 2310` |
| `/api/risk-scenarios/` | GET | Fetch risk scenarios | via entity cache |
| `/api/folders/` | GET | Fetch domain/perimeter folders | `server.js:2206` |
| `/api/reference-controls/` | GET | Fetch reference controls | via entity cache |
| `/api/evidences/` | GET | Fetch evidences | via entity cache |
| `/api/threats/` | GET | Fetch threats | via entity cache |
| `/api/libraries/` | POST (multipart) | Upload generated library YAML | `server.js:3744` |

## 2. Muraji API

| Aspect | Detail |
|---|---|
| **Base URL** | `https://muraji-api.wathbahs.com/api` |
| **Direction** | Admin frontend → Muraji (browser calls Muraji directly) |
| **Auth** | **None — endpoints appear unauthenticated** |
| **Protocol** | REST / JSON |

### Endpoints Called (from frontend)

| Endpoint | Method | Purpose | Evidence |
|---|---|---|---|
| `/api/libraries` | GET | List all libraries | `app.js:53` |
| `/api/libraries/:id/controls` | PATCH | Write AI analysis results (questions, evidence) | `app.js:1141` |
| `/api/prompts` | GET/POST/PUT/DELETE | CRUD prompt templates | `prompts.js:6` |

## 3. Google Gemini API

| Aspect | Detail |
|---|---|
| **Base URL** | `https://generativelanguage.googleapis.com` (via SDK and REST) |
| **Direction** | Admin backend → Google |
| **Auth** | API key from `GEMINI_API_KEY` env var |
| **Protocol** | REST (File Search) + SDK (`@google/genai`) |

### Capabilities Used

| Capability | Method | Evidence |
|---|---|---|
| Text generation | `model.generateContent()` | `server.js:1202, 1369` |
| Cached content | `caches.create()` / `caches.get()` | `server.js:1245, 1281` |
| Chat sessions | `model.startChat()` / `chat.sendMessage()` | `server.js:2685, 2722` |
| File Search Stores | REST: `POST /corpora`, `POST /corpora/:id/documents:upload` | `server.js:1627, 1678` |
| File Search grounding | `tools: [{googleSearch: {}}]` for grounded generation | `server.js:2680` |

## Data Flow Summary

```
User Browser ──▶ Admin Backend (Node.js) ──▶ GRC API (CISO Assistant)
    │                   │
    │                   └──▶ Google Gemini API
    │
    └──▶ Muraji API (direct from browser)
```
