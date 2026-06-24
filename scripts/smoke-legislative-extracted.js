/**
 * Local smoke test for /api/legislative-updates/extracted.
 * Boots the real server.js on a free port, hits every endpoint, prints results, and exits.
 *
 * Run: node scripts/smoke-legislative-extracted.js
 */

const http = require('http');
const path = require('path');

// Force a non-default port so we don't collide with a running dev server.
process.env.PORT = process.env.PORT || '5557';

// We must override server.js's hard-coded PORT at the top — easiest is to monkey-patch
// http.Server.listen. Instead, spin the server in a child process so we don't fight that.
const { spawn } = require('child_process');

const serverPath = path.join(__dirname, '..', 'server.js');
const proc = spawn(process.execPath, [serverPath], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let booted = false;
let serverPort = 5555; // default in server.js
proc.stdout.on('data', (chunk) => {
  const s = chunk.toString();
  process.stdout.write(`[server] ${s}`);
  const m = s.match(/Server running at: http:\/\/localhost:(\d+)/);
  if (m) serverPort = parseInt(m[1], 10);
  if (!booted && /Server running/.test(s)) {
    booted = true;
    setTimeout(runTests, 250);
  }
});
proc.stderr.on('data', (chunk) => process.stderr.write(`[server-err] ${chunk}`));

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: serverPort, path: pathname, method: 'GET' },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function runTests() {
  try {
    console.log('\n===== GET /api/legislative-updates/extracted/facets =====');
    let r = await get('/api/legislative-updates/extracted/facets');
    console.log(r.status, r.body);

    console.log('\n===== GET /api/legislative-updates/extracted (no filters) =====');
    r = await get('/api/legislative-updates/extracted');
    console.log(r.status, r.body.slice(0, 1500));

    console.log('\n===== GET ...?status=under_analysis&impact_level=high =====');
    r = await get('/api/legislative-updates/extracted?status=under_analysis&impact_level=high');
    console.log(r.status, r.body.slice(0, 1500));

    console.log('\n===== GET ...?q=هندسية =====');
    r = await get('/api/legislative-updates/extracted?q=' + encodeURIComponent('هندسية'));
    console.log(r.status, r.body.slice(0, 1500));

    console.log('\n===== GET /api/legislative-updates/extracted/lu-eng-license-update-2026 =====');
    r = await get('/api/legislative-updates/extracted/lu-eng-license-update-2026');
    console.log(r.status, r.body);
  } catch (err) {
    console.error('Smoke failed:', err);
  } finally {
    proc.kill();
    setTimeout(() => process.exit(0), 200);
  }
}

setTimeout(() => {
  if (!booted) {
    console.error('server did not boot within 15s');
    proc.kill();
    process.exit(1);
  }
}, 15000);
