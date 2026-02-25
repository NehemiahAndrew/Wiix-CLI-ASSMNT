// =============================================================================
// Server Entry — Express application bootstrap
// =============================================================================
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import path from 'path';

import config from './config';
import logger from './utils/logger';
import {
  startCleanupScheduler,
  stopCleanupScheduler,
} from './services/cleanupScheduler';

// Routes
import hubspotOauthRoutes from './routes/hubspot-oauth';
import wixWebhookRoutes from './routes/wix-webhooks';
import hubspotWebhookRoutes from './routes/hubspot-webhooks';
import fieldMappingRoutes from './routes/field-mapping';
import syncRoutes from './routes/sync';
import connectionRoutes from './routes/connection';
import formRoutes from './routes/forms';
import backendMethodRoutes from './routes/backend-methods';
import widgetRoutes from './routes/widget';

const app = express();

/* ── Global middleware ── */
app.use(cors({ origin: true, credentials: true }));
// Stash the raw request buffer so webhook handlers can compute HMAC signatures
app.use(
  express.json({
    limit: '5mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

// Request logging (non-PII)
app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent')?.substring(0, 60),
  });
  next();
});

/* ── API routes ── */
app.use('/api/hubspot', hubspotOauthRoutes);
app.use('/api/webhooks/wix', wixWebhookRoutes);
app.use('/api/webhooks/hubspot', hubspotWebhookRoutes);
app.use('/api/field-mappings', fieldMappingRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/connection', connectionRoutes);
app.use('/api/forms', formRoutes);
app.use('/api/backend', backendMethodRoutes);
app.use('/api/widget', widgetRoutes);

/* ── Serve built React client (production bundle) ── */
const clientDir = path.join(__dirname, '../../dist/client');
app.use(express.static(clientDir));

/* ── Wix App URL handler (entry point for installation flow) ── */
app.get('/', (req, res) => {
  const token = req.query.token as string | undefined;
  const instance = req.query.instance as string | undefined;

  // If Wix sends a token, redirect through the Wix installer consent flow
  if (token) {
    const appId = config.wixAppId;
    const redirectUrl = encodeURIComponent(`${config.baseUrl}/api/wix/install`);
    const installerUrl = `https://www.wix.com/installer/install?token=${token}&appId=${appId}&redirectUrl=${redirectUrl}`;
    logger.info('Redirecting to Wix installer', { appId });
    return res.redirect(installerUrl);
  }

  // If accessed from Wix dashboard (iframe) with ?instance= param,
  // serve the built React dashboard directly
  if (instance) {
    return res.sendFile(path.join(clientDir, 'index.html'));
  }

  // Default: show a simple status page with a link to the dashboard
  const jwt = require('jsonwebtoken');
  const dashboardToken = jwt.sign(
    { instanceId: '191db8e3-9470-4d60-b1ad-25831ea43cc3' },
    config.jwtSecret,
    { expiresIn: '2h' },
  );
  const dashboardUrl = `/?instance=${dashboardToken}`;

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>HubSpot Contact Sync</title>
      <style>
        body { font-family: 'Inter', system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f0f4f7; }
        .card { background: white; border-radius: 12px; padding: 40px; max-width: 480px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); text-align: center; }
        h1 { font-size: 22px; color: #162d3d; margin: 0 0 8px; }
        p { font-size: 14px; color: #577083; margin: 0 0 24px; }
        .badge { display: inline-block; background: #dff5e9; color: #00a47a; padding: 4px 12px; border-radius: 16px; font-size: 12px; font-weight: 600; margin-bottom: 16px; }
        a.btn { display: inline-block; background: #3899ec; color: white; text-decoration: none; padding: 10px 24px; border-radius: 6px; font-size: 14px; font-weight: 500; }
        a.btn:hover { background: #2b81cb; }
        .stats { display: flex; gap: 20px; justify-content: center; margin: 20px 0; }
        .stat { text-align: center; }
        .stat-val { font-size: 24px; font-weight: 700; color: #162d3d; }
        .stat-label { font-size: 11px; color: #7a92a5; text-transform: uppercase; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="badge">● Server Running</div>
        <h1>Wix ↔ HubSpot Integration</h1>
        <p>Bi-directional contact sync, field mapping & form capture</p>
        <a class="btn" href="${dashboardUrl}">Open Dashboard →</a>
      </div>
    </body>
    </html>
  `);
});

/* ── Health check ── */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/* ── Dev-only debug endpoint (disabled in production) ── */
if (config.nodeEnv !== 'production') {
  app.get('/api/debug/installations', async (_req, res) => {
    try {
      const db = mongoose.connection.db;
      const colls = await db.listCollections().toArray();
      const collNames = colls.map((c: any) => c.name);

      const installations = await db.collection('installations').find({}).project({
        instanceId: 1, connected: 1, hubspotPortalId: 1, syncEnabled: 1, lastSyncAt: 1, createdAt: 1
      }).toArray();

      const counts: Record<string, number> = {};
      for (const name of ['fieldmappings', 'contactmappings', 'syncevents', 'syncerrors', 'syncdedupelogs']) {
        if (collNames.includes(name)) {
          counts[name] = await db.collection(name).countDocuments({});
        }
      }

      res.json({
        mongoState: mongoose.connection.readyState,
        collections: collNames,
        installations,
        counts,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}

/* ── Wix app install callback ── */
app.get('/api/wix/install', async (req, res) => {
  try {
    // Wix sends: ?code=<AUTH_CODE>&instanceId=<INSTANCE_ID>&state=<STATE>
    // OR legacy: ?instanceId=<INSTANCE_ID>&token=<TOKEN>
    const { instanceId, code, token } = req.query as {
      instanceId?: string;
      code?: string;
      token?: string;
    };

    logger.info('Wix install callback received', {
      instanceId,
      hasCode: !!code,
      hasToken: !!token,
      queryKeys: Object.keys(req.query),
    });

    if (!instanceId) {
      res.status(400).json({ error: 'Missing instanceId' });
      return;
    }

    let refreshToken = token || '';

    // If Wix sent an authorization code, exchange it for tokens
    if (code) {
      try {
        const https = await import('https');
        const tokenData = await new Promise<any>((resolve, reject) => {
          const body = JSON.stringify({
            grant_type: 'authorization_code',
            client_id: config.wixAppId,
            client_secret: config.wixAppSecret,
            code,
          });
          const req = https.request(
            'https://www.wix.com/oauth/access',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              },
            },
            (resp) => {
              let data = '';
              resp.on('data', (chunk: string) => (data += chunk));
              resp.on('end', () => {
                try {
                  resolve(JSON.parse(data));
                } catch {
                  resolve({ raw: data });
                }
              });
            },
          );
          req.on('error', reject);
          req.write(body);
          req.end();
        });

        logger.info('Wix OAuth token exchange', {
          instanceId,
          hasRefreshToken: !!tokenData.refresh_token,
          hasAccessToken: !!tokenData.access_token,
          keys: Object.keys(tokenData),
        });

        if (tokenData.refresh_token) {
          refreshToken = tokenData.refresh_token;
        } else if (tokenData.access_token) {
          refreshToken = tokenData.access_token;
        }
      } catch (exchangeErr) {
        logger.error('Failed to exchange Wix auth code', {
          instanceId,
          error: (exchangeErr as Error).message,
        });
      }
    }

    const Installation = (await import('./models/Installation')).default;
    await Installation.findOneAndUpdate(
      { instanceId },
      { instanceId, refreshToken },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    logger.info('Wix app installed', { instanceId, hasRefreshToken: !!refreshToken });
    res.redirect(config.baseUrl || '/');
  } catch (err) {
    logger.error('Install callback error', { error: (err as Error).message });
    res.status(500).json({ error: 'Installation failed' });
  }
});

/* ── Dashboard shortcut (auto-generates JWT for quick access) ── */
app.get('/dashboard', (_req, res) => {
  const jwt = require('jsonwebtoken');
  const dashboardToken = jwt.sign(
    { instanceId: '191db8e3-9470-4d60-b1ad-25831ea43cc3' },
    config.jwtSecret,
    { expiresIn: '2h' },
  );
  res.redirect(`/?instance=${dashboardToken}`);
});

/* ── SPA fallback — serve index.html for unmatched routes ── */
app.get('*', (req, res) => {
  // Don't catch API routes
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(clientDir, 'index.html'));
});

/* ── Global error handler ── */
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    logger.error('Unhandled server error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  },
);

/* ── Start ── */
async function start(): Promise<void> {
  try {
    await mongoose.connect(config.mongodbUri);
    logger.info('MongoDB connected');

    // Module 5-C: Start periodic SyncDedupeLog cleanup (every 10 min)
    startCleanupScheduler();

    app.listen(config.port, () => {
      logger.info(`Server running on port ${config.port} [${config.nodeEnv}]`);
    });
  } catch (err) {
    logger.error('Failed to start server', { error: (err as Error).message });
    process.exit(1);
  }
}

// Graceful shutdown — stop scheduler before exit
process.on('SIGTERM', () => {
  stopCleanupScheduler();
  mongoose.disconnect().catch(() => {});
});
process.on('SIGINT', () => {
  stopCleanupScheduler();
  mongoose.disconnect().catch(() => {});
});

start();

export default app;
