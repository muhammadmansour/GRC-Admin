// PM2 process definition for the admin/server app.
//
// IMPORTANT: the Node entry point is `server.js`. Do NOT point PM2 at
// `app.js` / `admin.js` — those are browser (client-side) scripts that use
// `document` / `window` and crash immediately under Node with
// "ReferenceError: document is not defined".
//
// Start/refresh with:   pm2 start ecosystem.config.js
// Then persist:         pm2 save
module.exports = {
  apps: [
    {
      name: 'admin',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        // Server-side PDF (Puppeteer). Using system Google Chrome avoids the
        // bundled-Chromium shared-library errors (e.g. libnspr4.so). If you
        // instead rely on Puppeteer's downloaded Chrome, remove these two.
        PUPPETEER_SKIP_DOWNLOAD: 'true',
        PUPPETEER_EXECUTABLE_PATH: '/usr/bin/google-chrome-stable',
      },
    },
  ],
};
