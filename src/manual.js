const express = require('express');

const { generateReply } = require('./ai');
const { createLogger } = require('./logger');
const { detectStage } = require('./stage');

const logger = createLogger('manual');

function createManualRouter({ storage }) {
  const router = express.Router();

  router.get('/conversations', (_req, res) => {
    const conversations = storage.listConversations(200).map(attachTelegramLeadCard);
    res.status(200).json({ conversations });
  });

  router.post('/conversations', (req, res) => {
    const userId = normalizeUserId(req.body?.userId);
    const initialMessage = normalizeText(req.body?.text);

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    let conversation;
    if (initialMessage) {
      conversation = storage.appendInboundMessage(userId, {
        id: null,
        text: initialMessage,
        timestamp: Date.now(),
      });
      const stage = detectStage(conversation.messages);
      storage.setStage(userId, stage);
      conversation = storage.getConversation(userId);
    } else {
      conversation = storage.getOrCreateConversation(userId);
    }

    if (req.body?.profile) {
      conversation = storage.saveLeadProfile(userId, req.body.profile);
    }

    logger.info('Conversation opened in manual mode', {
      userId,
      hasInitialMessage: Boolean(initialMessage),
    });

    return res.status(201).json({
      conversation: attachTelegramLeadCard(conversation),
      summaries: storage.listConversations(200).map(attachTelegramLeadCard),
    });
  });

  router.get('/conversations/:userId', (req, res) => {
    const userId = normalizeUserId(req.params.userId);
    const conversation = userId ? storage.getConversation(userId) : null;

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    return res.status(200).json({ conversation: attachTelegramLeadCard(conversation) });
  });

  router.patch('/conversations/:userId/profile', (req, res) => {
    const userId = normalizeUserId(req.params.userId);

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const conversation = storage.saveLeadProfile(userId, req.body || {});
    logger.info('Lead profile updated', {
      userId,
      hasName: Boolean(conversation.profile?.name),
      hasTelegramLabel: Boolean(conversation.profile?.telegramLabel),
    });

    return res.status(200).json({
      conversation: attachTelegramLeadCard(conversation),
      summaries: storage.listConversations(200).map(attachTelegramLeadCard),
    });
  });

  router.post('/conversations/:userId/inbound', (req, res) => {
    const userId = normalizeUserId(req.params.userId);
    const text = normalizeText(req.body?.text);

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }

    let conversation = storage.appendInboundMessage(userId, {
      id: null,
      text,
      timestamp: Date.now(),
    });

    const stage = detectStage(conversation.messages);
    storage.setStage(userId, stage);
    conversation = storage.getConversation(userId);

    logger.info('Inbound message saved in manual mode', {
      userId,
      stage,
      messageCount: conversation.messages.length,
    });

    return res.status(201).json({
      stage,
      conversation: attachTelegramLeadCard(conversation),
      summaries: storage.listConversations(200).map(attachTelegramLeadCard),
    });
  });

  router.post('/conversations/:userId/generate-reply', async (req, res, next) => {
    const userId = normalizeUserId(req.params.userId);
    const conversation = userId ? storage.getConversation(userId) : null;

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    try {
      const stage = detectStage(conversation.messages);
      storage.setStage(userId, stage);

      const reply = await generateReply(conversation.messages, stage);
      if (!reply) {
        return res.status(502).json({ error: 'AI reply generation returned empty result' });
      }

      const updatedConversation = storage.appendOutboundMessage(userId, {
        id: null,
        text: reply,
        timestamp: Date.now(),
      });

      logger.info('Reply generated in manual mode', {
        userId,
        stage,
        messageCount: updatedConversation.messages.length,
      });

      return res.status(200).json({
        stage,
        reply,
        conversation: attachTelegramLeadCard(updatedConversation),
        summaries: storage.listConversations(200).map(attachTelegramLeadCard),
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

function attachTelegramLeadCard(conversation) {
  if (!conversation) {
    return conversation;
  }

  return {
    ...conversation,
    telegramLeadCard: buildTelegramLeadCard(conversation),
  };
}

function buildTelegramLeadCard(conversation) {
  const profile = conversation.profile || {};
  const lines = [
    `Лид: ${profile.name || conversation.userId}`,
    `Instagram ID: ${conversation.userId}`,
  ];

  if (profile.telegramLabel) {
    lines.push(`Метка: ${profile.telegramLabel}`);
  }

  if (profile.country) {
    lines.push(`Страна: ${profile.country}`);
  }

  if (profile.citizenship) {
    lines.push(`Гражданство: ${profile.citizenship}`);
  }

  if (profile.age) {
    lines.push(`Возраст: ${profile.age}`);
  }

  if (profile.passportStatus) {
    lines.push(`Загранпаспорт: ${humanizePassportStatus(profile.passportStatus)}`);
  }

  lines.push(`Стадия: ${conversation.stage}`);

  if (profile.notes) {
    lines.push(`Заметки: ${profile.notes}`);
  }

  return lines.join('\n');
}

function humanizePassportStatus(value) {
  if (value === 'yes') {
    return 'есть';
  }

  if (value === 'no') {
    return 'нет';
  }

  if (value === 'processing') {
    return 'в процессе';
  }

  return 'не указано';
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeUserId(value) {
  return normalizeText(value);
}

module.exports = {
  createManualRouter,
};
