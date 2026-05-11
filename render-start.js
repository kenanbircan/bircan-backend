'use strict';

/**
 * Render production entrypoint for Bircan Migration backend.
 *
 * Purpose:
 * - Runs the existing server.js normally.
 * - Detects whether server.js actually binds to process.env.PORT.
 * - If server.js creates an Express app but forgets app.listen(...), this file
 *   captures that app and binds it to 0.0.0.0:PORT for Render.
 *
 * This avoids the Render error:
 *   "Port scan timeout reached, no open ports detected"
 */

const http = require('http');
const Module = require('module');

const PORT = Number(process.env.PORT || 4242);
const HOST = '0.0.0.0';

let didListen = false;
let capturedExpressApp = null;

// Track whether any server has already called .listen().
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function patchedListen(...args) {
  didListen = true;
  return originalListen.apply(this, args);
};

// Capture the Express app created by server.js without editing server.js.
const originalLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);

  if (request === 'express' && typeof loaded === 'function') {
    function expressWrapper(...args) {
      const app = loaded(...args);
      capturedExpressApp = app;
      return app;
    }

    // Preserve express.json(), express.Router(), express.static(), etc.
    Object.assign(expressWrapper, loaded);
    Object.setPrototypeOf(expressWrapper, loaded);
    return expressWrapper;
  }

  return loaded;
};

let serverModule;
try {
  serverModule = require('./server.js');
} catch (err) {
  console.error('[render-start] Failed to load server.js');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}

function getExportedApp(mod) {
  if (!mod) return null;
  if (typeof mod.listen === 'function') return mod;
  if (mod.app && typeof mod.app.listen === 'function') return mod.app;
  if (mod.default && typeof mod.default.listen === 'function') return mod.default;
  return null;
}

setImmediate(() => {
  if (didListen) {
    console.log(`[render-start] Existing server.js listener detected. Render port binding OK.`);
    return;
  }

  const app = getExportedApp(serverModule) || capturedExpressApp;

  if (app && typeof app.listen === 'function') {
    app.listen(PORT, HOST, () => {
      console.log(`[render-start] Bound captured Express app to ${HOST}:${PORT} for Render.`);
    });
    return;
  }

  // Last-resort safety net. This keeps Render alive, but it means server.js did
  // not expose or create a capturable Express app. In that case, patch server.js
  // directly to call app.listen(PORT, '0.0.0.0', ...).
  const fallback = http.createServer((req, res) => {
    res.statusCode = req.url === '/api/health' || req.url === '/health' ? 503 : 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      ok: false,
      service: 'bircan-backend',
      error: 'server.js loaded but did not bind a port and no Express app could be captured',
      fix: "Add app.listen(process.env.PORT || 4242, '0.0.0.0') at the bottom of server.js"
    }));
  });

  fallback.listen(PORT, HOST, () => {
    console.error(`[render-start] WARNING: fallback server bound to ${HOST}:${PORT}; patch server.js directly if APIs are unavailable.`);
  });
});
