const HOT_PATTERNS = [
  /зарплат/i,
  /ваканси/i,
  /услови/i,
  /график/i,
  /ставк/i,
  /смен/i,
  /жиль/i,
  /сколько.{0,25}(плат|заработ|оплат)/i,
  /сколько.{0,25}стоит/i,
  /какая.{0,25}(зарплата|вакансия|работа)/i,
  /цена.{0,25}(документ|виз)/i,
];

const WARM_PATTERNS = [
  /загран/i,
  /паспорт/i,
  /документ/i,
  /виза/i,
  /внж/i,
  /пмж/i,
  /карта\s*побыту/i,
  /польш/i,
  /герман/i,
  /чех/i,
  /литв/i,
  /латви/i,
  /эстон/i,
  /румын/i,
  /болгар/i,
  /словаки/i,
  /европ/i,
  /стран/i,
];

const SHORT_COLD_REPLIES = new Set([
  'да',
  'ага',
  'актуально',
  'интересно',
  'ок',
  'хорошо',
  'можно',
]);

function detectStage(messages) {
  const leadMessages = extractLeadTexts(messages);

  if (leadMessages.length === 0) {
    return 'cold';
  }

  const latestMessage = leadMessages[leadMessages.length - 1];
  const combinedText = leadMessages.join(' ');

  if (hasHotSignal(leadMessages, combinedText)) {
    return 'hot';
  }

  if (hasWarmSignal(leadMessages, combinedText)) {
    return 'warm';
  }

  if (isColdLead(leadMessages, latestMessage)) {
    return 'cold';
  }

  return leadMessages.length >= 2 ? 'warm' : 'cold';
}

function extractLeadTexts(messages) {
  return (messages || [])
    .filter((message) => isLeadMessage(message))
    .map((message) => normalizeText(getMessageText(message)))
    .filter(Boolean);
}

function isLeadMessage(message) {
  if (!message) {
    return false;
  }

  if (typeof message === 'string') {
    return true;
  }

  if (message.role) {
    return message.role === 'lead' || message.role === 'user';
  }

  if (message.direction) {
    return message.direction === 'inbound';
  }

  return true;
}

function getMessageText(message) {
  if (typeof message === 'string') {
    return message;
  }

  return message.text ?? '';
}

function normalizeText(value) {
  return String(value)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function wordCount(text) {
  return normalizeText(text)
    .split(' ')
    .filter(Boolean).length;
}

function hasHotSignal(leadMessages, combinedText) {
  const hotKeywordMatch = HOT_PATTERNS.some((pattern) => pattern.test(combinedText));
  return hotKeywordMatch || hasQuestionAboutWork(leadMessages);
}

function hasQuestionAboutWork(leadMessages) {
  return leadMessages.some((message) => {
    if (!message.includes('?')) {
      return false;
    }

    return HOT_PATTERNS.some((pattern) => pattern.test(message));
  });
}

function hasWarmSignal(leadMessages, combinedText) {
  const mentionsCountryOrDocuments = WARM_PATTERNS.some((pattern) => pattern.test(combinedText));
  if (mentionsCountryOrDocuments) {
    return true;
  }

  const detailedAnswers = leadMessages.filter((message) => wordCount(message) >= 4);
  if (detailedAnswers.length >= 1) {
    return true;
  }

  return leadMessages.length >= 2 && leadMessages.some((message) => wordCount(message) >= 2);
}

function isColdLead(leadMessages, latestMessage) {
  const noQuestions = leadMessages.every((message) => !message.includes('?'));
  const shortRepliesOnly = leadMessages.every((message) => wordCount(message) <= 3);

  if (!noQuestions || !shortRepliesOnly) {
    return false;
  }

  return SHORT_COLD_REPLIES.has(latestMessage) || wordCount(latestMessage) <= 2;
}

module.exports = {
  detectStage,
};
