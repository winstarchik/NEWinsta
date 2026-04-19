const axios = require('axios');

const { createLogger } = require('./logger');

const GRAPH_BASE_URL = 'https://graph.instagram.com';
const logger = createLogger('instagram');

async function sendInstagramMessage({ recipientId, text, config }) {
  validateInstagramConfig(config);
  logger.debug('Sending Instagram message', {
    recipientId,
    apiVersion: config.instagramApiVersion,
    textLength: String(text || '').length,
  });

  const client = axios.create({
    baseURL: GRAPH_BASE_URL,
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${config.instagramAccessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const payload = {
    recipient: {
      id: recipientId,
    },
    message: {
      text: sanitizeInstagramText(text),
    },
  };

  return retry(async () => {
    const response = await client.post(`/${config.instagramApiVersion}/${config.instagramIgUserId}/messages`, payload);
    return response.data;
  }, 3, 1000);
}

function sanitizeInstagramText(text) {
  const normalized = String(text || '').replace(/\r/g, '').trim();
  if (!normalized) {
    throw new Error('Instagram message text cannot be empty.');
  }

  if (normalized.length <= 1000) {
    return normalized;
  }

  return `${normalized.slice(0, 997).trim()}...`;
}

function validateInstagramConfig(config) {
  const missing = [];

  if (!config.instagramAccessToken) {
    missing.push('INSTAGRAM_ACCESS_TOKEN');
  }

  if (!config.instagramIgUserId) {
    missing.push('INSTAGRAM_IG_USER_ID');
  }

  if (missing.length > 0) {
    throw new Error(`Missing Instagram config: ${missing.join(', ')}`);
  }
}

async function retry(task, maxAttempts, delayMs) {
  let attempt = 1;

  while (attempt <= maxAttempts) {
    try {
      return await task();
    } catch (error) {
      const status = error.response?.status;
      const isRetryable = status === 429 || status >= 500;

      if (!isRetryable || attempt === maxAttempts) {
        logger.error('Meta API send failed', {
          attempt,
          maxAttempts,
          status,
          message: error.message,
          data: error.response?.data,
        });
        throw error;
      }

      logger.warn('Meta API send retry scheduled', {
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        status,
        delayMs,
      });
      await wait(delayMs);
      attempt += 1;
    }
  }

  throw new Error('Retry loop failed unexpectedly.');
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

module.exports = {
  sendInstagramMessage,
};
