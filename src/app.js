require('dotenv').config();

const express = require('express');
const path = require('path');

const { createLogger } = require('./logger');
const { createManualRouter } = require('./manual');
const { createStorage } = require('./storage');
const { createWebhookRouter } = require('./webhook');

const logger = createLogger('app');
const config = buildConfig();
const storage = createStorage({
  dbPath: config.storagePath,
  maxConversationMessages: config.maxConversationMessages,
  maxProcessedMessages: config.maxProcessedMessages,
});
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const app = express();
const publicDir = path.resolve(__dirname, '..', 'public');
app.disable('x-powered-by');

app.use(
  express.json({
    verify: (req, _res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  }),
);

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    provider: config.aiProvider,
    mode: config.appMode,
  });
});

app.get('/', (_req, res) => {
  res.redirect('/dashboard');
});

app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(publicDir, 'dashboard.html'));
});

app.use('/static', express.static(publicDir));
app.use('/api', createManualRouter({ storage }));

if (config.metaWebhookEnabled) {
  app.use('/webhook', createWebhookRouter({ config, storage }));
}

app.use((error, _req, res, _next) => {
  logger.error('Unhandled Express error', {
    errorMessage: error.message,
    stack: error.stack,
  });
  res.status(500).json({ error: 'Internal server error' });
});

let server = null;
let cleanupInterval = null;

if (require.main === module) {
  server = startServer();
  cleanupInterval = startCleanupLoop();
}

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection', {
    errorMessage: error?.message,
    stack: error?.stack,
  });
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }

  if (!server) {
    process.exit(0);
    return;
  }

  server.close(() => {
    process.exit(0);
  });
});

function startServer() {
  return app.listen(config.port, () => {
    logger.info('Instagram lead processor started', {
      port: config.port,
      appMode: config.appMode,
      metaWebhookEnabled: config.metaWebhookEnabled,
      aiProvider: config.aiProvider,
      storagePath: config.storagePath,
    });
  });
}

function startCleanupLoop() {
  if (typeof storage.cleanupOldConversations !== 'function') {
    return null;
  }

  const runCleanup = () => {
    try {
      const deletedCount = storage.cleanupOldConversations(config.conversationRetentionDays);
      logger.info('Conversation cleanup completed', {
        retentionDays: config.conversationRetentionDays,
        deletedCount,
      });
    } catch (error) {
      logger.error('Conversation cleanup failed', {
        errorMessage: error.message,
        stack: error.stack,
      });
    }
  };

  runCleanup();
  const interval = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }

  return interval;
}

function buildConfig() {
  return {
    port: Number(process.env.PORT || 3000),
    webhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN || '',
    metaAppSecret: process.env.META_APP_SECRET || '',
    enableSignatureValidation: parseBoolean(process.env.ENABLE_SIGNATURE_VALIDATION, true),
    instagramAccessToken: process.env.INSTAGRAM_ACCESS_TOKEN || '',
    instagramIgUserId: process.env.INSTAGRAM_IG_USER_ID || '',
    instagramApiVersion: process.env.INSTAGRAM_API_VERSION || 'v23.0',
    metaWebhookEnabled: parseBoolean(process.env.META_WEBHOOK_ENABLED, false),
    appMode: process.env.APP_MODE || 'manual',
    aiProvider: String(process.env.AI_PROVIDER || 'openai').toLowerCase(),
    storagePath: process.env.STORAGE_PATH || path.resolve(__dirname, '..', 'data', 'storage.sqlite'),
    conversationRetentionDays: Number(process.env.CONVERSATION_RETENTION_DAYS || 30),
    maxConversationMessages: Number(process.env.MAX_CONVERSATION_MESSAGES || 30),
    maxProcessedMessages: Number(process.env.MAX_PROCESSED_MESSAGES || 5000),
  };
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return String(value).toLowerCase() === 'true';
}

module.exports = {
  app,
  config,
  startServer,
};
