# WathbahGRC Admin — Deployment and Environments
**Snapshot taken:** 2026-04-14
**Commit / branch:** a03a947 / db-scheme-changes
**Scope of this file:** Environment configuration, known deployments, and feature flags.

## Environment Configuration

- **Method:** `.env` file loaded manually at startup (`server.js:14–27`). No `dotenv` package — custom line-by-line parser.
- **Known env vars:**
  - `GEMINI_API_KEY` — Google Generative AI API key
  - `GRC_API_URL` — Base URL for the WathbahGRC (CISO Assistant) API. Defaults to `https://stage-hrsd.wathbahs.com` (`server.js:39`). Trailing slashes are stripped at load.

## Known Environments

| Environment | URL (inferred) | Evidence |
|---|---|---|
| Production | `https://wathbahs.com` | nginx config (`nginx/prompt.wathbahs.com`) proxies to `127.0.0.1:8888` |
| Staging / Default | `https://stage-hrsd.wathbahs.com` | Default value of `GRC_API_URL` in `server.js:39` |
| Local | `http://localhost:5555` | Hardcoded `PORT = 5555` in `server.js:8` |

## SSL / TLS

- Let's Encrypt certificates at `/etc/letsencrypt/live/wathbahs.com/` (`nginx/prompt.wathbahs.com:18–19`)
- HTTP2 enabled

## Feature Flags

**None.** There is no feature flag system, no environment-based toggles, no LaunchDarkly or equivalent. All code paths are unconditionally active.

## Deployment Mechanism

Not present in this repo. No Dockerfile, no `docker-compose.yml`, no CI/CD config, no `Procfile`, no systemd unit file. The process is likely managed manually or via an unversioned systemd/PM2 setup on the server.
