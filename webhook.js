const crypto = require('crypto');
const express = require('express');

const { generateReply } = require('./ai');
const { sendInstagramMessage } = require('./instagram');
const { createLogger } = require('./logger');
const { detectStage } = require('./stage');

const logger = createLogger('webhook');

function createWebhookRouter({ config, storage }) {
  const router = express.Router();

  router.get('/instagram', (req, res) => {
    const mode = req.query['hub.mode'];
    const verifyToken = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode !== 'subscribe') {
      logger.warn('Meta webhook verification rejected: invalid mode', { mode });
      return res.status(400).json({ error: 'Invalid hub.mode' });
    }

    if (!config.webhookVerifyToken || verifyToken !== config.webhookVerifyToken) {
      logger.warn('Meta webhook verification rejected: token mismatch');
      return res.status(403).json({ error: 'Webhook verification token mismatch' });
    }

    logger.info('Meta webhook verification succeeded');
    return res.status(200).send(challenge);
  });

  router.post('/instagram', (req, res) => {
    if (config.enableSignatureValidation && !isValidMetaSignature(req, config.metaAppSecret)) {
      logger.warn('Incoming webhook rejected: invalid signature');
      return res.status(401).json({ error: 'Invalid X-Hub-Signature-256 signature' });
    }

    if (req.body?.object !== 'instagram') {
      logger.warn('Incoming webhook rejected: unsupported object', { object: req.body?.object });
      return res.status(400).json({ error: 'Unsupported webhook object' });
    }

    res.status(200).send('EVENT_RECEIVED');

    setImmediate(async () => {
      try {
        await processWebhookPayload(req.body, { config, storage });
      } catch (error) {
        logger.error('Failed to process webhook payload', serializeError(error));
      }
    });
  });

  return router;
}

async function processWebhookPayload(payload, dependencies) {
  const events = extractInboundEvents(payload, dependencies.config.instagramIgUserId);
  logger.info('Webhook payload received', { eventsCount: events.length });

  for (const event of events) {
    await processInboundEvent(event, dependencies);
  }
}

async function processInboundEvent(event, { config, storage }) {
  if (!event.text) {
    return;
  }

  if (storage.hasProcessedMessage(event.messageId)) {
    logger.debug('Skipping already processed message', {
      userId: event.userId,
      messageId: event.messageId,
    });
    return;
  }

  storage.markProcessed(event.messageId);
  const conversation = storage.appendInboundMessage(event.userId, {
    id: event.messageId,
    text: event.text,
    timestamp: event.timestamp,
  });

  const stage = detectStage(conversation.messages);
  storage.setStage(event.userId, stage);
  logger.info('Lead stage detected', {
    userId: event.userId,
    messageId: event.messageId,
    stage,
    messageCount: conversation.messages.length,
  });

  const reply = await generateReply(conversation.messages, stage);
  if (!reply) {
    logger.warn('Reply generation returned empty result', {
      userId: event.userId,
      messageId: event.messageId,
    });
    return;
  }

  const replySlot = storage.reserveReplySlot(event.userId, 2000);
  if (!replySlot.allowed) {
    logger.warn('Reply skipped due to per-user rate limit', {
      userId: event.userId,
      retryAfterMs: replySlot.retryAfterMs,
    });
    return;
  }

  let response;

  try {
    response = await sendInstagramMessage({
      recipientId: event.userId,
      text: reply,
      config,
    });
    storage.confirmReplySlot(event.userId, Date.now());
    logger.info('Reply sent to Instagram', {
      userId: event.userId,
      messageId: event.messageId,
      stage,
      responseMessageId: response?.message_id ?? null,
    });
  } catch (error) {
    storage.releaseReplySlot(event.userId, replySlot.reservedAt);
    throw error;
  }

  storage.appendOutboundMessage(event.userId, {
    id: response?.message_id ?? null,
    text: reply,
    timestamp: Date.now(),
  });
}

function extractInboundEvents(payload, ownInstagramId) {
  const events = [];

  for (const entry of payload.entry || []) {
    for (const messagingEvent of entry.messaging || []) {
      const text = messagingEvent.message?.text?.trim();
      const messageId = messagingEvent.message?.mid || messagingEvent.postback?.mid || null;
      const senderId = messagingEvent.sender?.id;
      const recipientId = messagingEvent.recipient?.id;
      const isSelfEvent = Boolean(messagingEvent.is_self) || senderId === ownInstagramId;

      if (!text || !senderId || isSelfEvent || recipientId !== ownInstagramId) {
        continue;
      }

      events.push({
        userId: senderId,
        text,
        messageId,
        timestamp: messagingEvent.timestamp || Date.now(),
      });
    }
  }

  return events;
}

function isValidMetaSignature(req, appSecret) {
  if (!appSecret) {
    logger.warn('META_APP_SECRET is missing. Signature validation cannot be enforced.');
    return false;
  }

  const signatureHeader = req.get('x-hub-signature-256');
  if (!signatureHeader || !req.rawBody) {
    return false;
  }

  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex')}`;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signatureHeader);

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function serializeError(error) {
  return {
    message: error.message,
    status: error.response?.status,
    data: error.response?.data,
  };
}

module.exports = {
  createWebhookRouter,
};
