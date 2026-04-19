const axios = require('axios');

const { createLogger } = require('./logger');

const TELEGRAM_LINK = 'https://t.me/EuroWorkGmbHBot?start=ref_8532194559';
const logger = createLogger('ai');

const COUNTRY_QUESTION = 'Подскажите, в какой стране вы сейчас находитесь?';
const PASSPORT_QUESTION = 'Есть ли у вас загранпаспорт?';
const NAME_QUESTION = 'Как я могу к вам обращаться?';

const SHORT_AMBIGUOUS_REPLIES = new Set([
  'да',
  'нет',
  'ага',
  'ок',
  'хорошо',
  'понял',
  'ясно',
  'можно',
  'актуально',
]);

const COUNTRY_PATTERNS = [
  { label: 'Польша', pattern: /польш/i },
  { label: 'Германия', pattern: /герман/i },
  { label: 'Чехия', pattern: /чех/i },
  { label: 'Литва', pattern: /литв/i },
  { label: 'Латвия', pattern: /латви/i },
  { label: 'Эстония', pattern: /эстон/i },
  { label: 'Румыния', pattern: /румын/i },
  { label: 'Болгария', pattern: /болгар/i },
  { label: 'Словакия', pattern: /словак/i },
  { label: 'Украина', pattern: /украин/i },
  { label: 'Казахстан', pattern: /казах/i },
  { label: 'Узбекистан', pattern: /узбек/i },
  { label: 'Молдова', pattern: /молд/i },
  { label: 'Грузия', pattern: /грузи/i },
  { label: 'Армения', pattern: /армен/i },
  { label: 'Беларусь', pattern: /беларус/i },
  { label: 'Россия', pattern: /росси/i },
  { label: 'Кыргызстан', pattern: /киргиз|кыргыз/i },
  { label: 'Таджикистан', pattern: /таджик/i },
  { label: 'Европа', pattern: /европ/i },
];

const SYSTEM_PROMPT = `Ты — менеджер по подбору персонала компании EuroWork GmbH.

Твоя задача:
максимально быстро и аккуратно перевести лида из Instagram в Telegram:
https://t.me/EuroWorkGmbHBot?start=ref_8532194559

Ты работаешь по воронке:
лид → короткий диалог → базовый прогрев → перевод в Telegram

=====================
ОПРЕДЕЛЕНИЕ СТАДИИ
==================

Ты должен сам определять стадию лида:

1. ХОЛОДНЫЙ

* только ответил "да", "актуально"
* мало информации
* не задаёт вопросов

2. ТЁПЛЫЙ

* отвечает на вопросы
* говорит про страну / документы
* начинает интересоваться

3. ГОРЯЧИЙ

* задаёт вопросы про вакансии / зарплату / условия
* проявляет явный интерес

=====================
ПРАВИЛА РАБОТЫ
==============

* Пиши коротко и по делу
* Максимум 1-2 вопроса за сообщение
* Не пиши длинные тексты
* Не объясняй лишнего
* Не отвечай на все вопросы лида
* После 3-4 сообщений ОБЯЗАТЕЛЬНО веди в Telegram
* Всегда используй ссылку (не @username)

=====================
СЦЕНАРИЙ
========

1. ХОЛОДНЫЙ ЛИД:
   Цель — открыть диалог

Пример:
Здравствуйте
Вы оставляли комментарий по поводу работы в Европе
Актуально для вас?

Если ответ "да":
→ переход к вопросам

2. ТЁПЛЫЙ ЛИД:
   Цель — собрать минимум информации

Обязательные вопросы:

* В какой стране сейчас находитесь?
* Есть ли загранпаспорт?

Дополнительно:

* Как я могу к вам обращаться?

3. ГОРЯЧИЙ ЛИД:
   Цель — сразу перевод

Пример:
По вакансиям вас более подробно проконсультирует старший менеджер
Напишите ему:
https://t.me/aleksmakaer
Он сейчас на связи

=====================
ПЕРЕВОД В TELEGRAM
==================

Всегда используешь формулировку:

всегда по разному по случаям, условно у тебя будет вопрос, а ну скажите пожалуйста по цене документов, виза и т.д
тогда отвечаем примерно так

Смотрите ( имя ) по поводу цены более подробно вас сможет проконсультировать старший менеджер, так как я ниже по рангу и не смогу ответить вам на этот вопрос
напишите старшему менеджеру в телеграм
https://t.me/EuroWorkGmbHBot?start=ref_8532194559

Под каждый закрывающий вопрос новый перевод.

=====================
ОБРАБОТКА ВОЗРАЖЕНИЙ
====================

Если:
"Почему отвечаете вы?"
→
Мы работаем командой
Заявки обрабатываются несколькими менеджерами
Я подключился к вашему запросу и помогаю вам сейчас

Если:
"Я не верю"
→
Наш головной офис находится в Германии
Мы работаем напрямую с работодателями
Основная гарантия — официальный контракт

=====================
СТИЛЬ
=====

* Уверенный
* Спокойный
* Без лишней "воды"
* Как живой человек, не как бот

=====================
ЗАПРЕТЫ
=======

* Не пиши длинные сообщения
* Не затягивай диалог
* Не забывай переводить в Telegram
* Не задавай много вопросов сразу

=====================
ГЛАВНОЕ ПРАВИЛО
===============

Твоя цель — не общаться,
а максимально быстро перевести лида в Telegram.`;

async function generateReply(messages, stage) {
  const context = buildConversationContext(messages, stage);
  const provider = String(process.env.AI_PROVIDER || 'openai').toLowerCase();

  logger.info('Generating AI reply', {
    provider,
    stage: context.stage,
    totalMessages: context.totalMessages,
    leadMessages: context.leadMessageCount,
    forceTelegram: context.forceTelegram,
  });

  if (provider === 'anthropic') {
    if (!isConfiguredSecret(process.env.ANTHROPIC_API_KEY)) {
      logger.warn('Anthropic API key missing, using fallback reply');
      return buildFallbackReply(context);
    }

    try {
      const reply = await generateAnthropicReply(messages, context);
      return finalizeReply(reply, context);
    } catch (error) {
      logger.error('Anthropic reply generation failed, using fallback reply', serializeError(error));
      return buildFallbackReply(context);
    }
  }

  if (!isConfiguredSecret(process.env.OPENAI_API_KEY)) {
    logger.warn('OpenAI API key missing, using fallback reply');
    return buildFallbackReply(context);
  }

  try {
    const reply = await generateOpenAIReply(messages, context);
    return finalizeReply(reply, context);
  } catch (error) {
    logger.error('OpenAI reply generation failed, using fallback reply', serializeError(error));
    return buildFallbackReply(context);
  }
}

async function generateOpenAIReply(messages, context) {
  const timeout = Number(process.env.AI_REQUEST_TIMEOUT_MS || 20000);
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const client = axios.create({
    baseURL: 'https://api.openai.com/v1',
    timeout,
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const response = await client.post('/chat/completions', {
    model,
    temperature: 0.6,
    max_tokens: 160,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: buildSystemContext(context) },
      { role: 'user', content: buildUserPrompt(messages, context) },
    ],
  });

  const content = response.data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content.map((item) => item.text || '').join('').trim();
  }

  return String(content || '').trim();
}

async function generateAnthropicReply(messages, context) {
  const timeout = Number(process.env.AI_REQUEST_TIMEOUT_MS || 20000);
  const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
  const client = axios.create({
    baseURL: 'https://api.anthropic.com/v1',
    timeout,
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
  });

  const response = await client.post('/messages', {
    model,
    system: `${SYSTEM_PROMPT}\n\n${buildSystemContext(context)}`,
    temperature: 0.6,
    max_tokens: 160,
    messages: [
      {
        role: 'user',
        content: buildUserPrompt(messages, context),
      },
    ],
  });

  const parts = response.data?.content ?? [];
  return parts.map((item) => item.text || '').join('').trim();
}

function buildUserPrompt(messages, context) {
  const normalizedMessages = (messages || []).slice(-10).map((message) => {
    const role = message.role === 'assistant' ? 'Менеджер' : 'Лид';
    return `${role}: ${message.text}`;
  });

  return [
    'Ниже история диалога из Instagram Direct.',
    `Backend heuristic stage: ${context.stage}. Используй это только как подсказку и сам оцени контекст диалога.`,
    `Сообщений от лида: ${context.leadMessageCount}.`,
    'Сформируй только следующее сообщение менеджера без кавычек, JSON и пояснений.',
    normalizedMessages.join('\n'),
  ].join('\n\n');
}

function buildSystemContext(context) {
  return [
    'SYSTEM CONTEXT:',
    `stage=${context.stage}`,
    `total_messages=${context.totalMessages}`,
    `lead_messages=${context.leadMessageCount}`,
    `force_telegram=${context.forceTelegram ? 'yes' : 'no'}`,
    `latest_message_low_signal=${context.latestLeadMessageLowSignal ? 'yes' : 'no'}`,
    `questions_asked.country=${context.askedQuestions.country ? 'yes' : 'no'}`,
    `questions_asked.passport=${context.askedQuestions.passport ? 'yes' : 'no'}`,
    `questions_asked.name=${context.askedQuestions.name ? 'yes' : 'no'}`,
    `extracted.country=${context.extracted.country || 'unknown'}`,
    `extracted.passport_status=${context.extracted.passportStatus}`,
    `extracted.name=${context.extracted.name || 'unknown'}`,
    `next_clarifying_question=${context.nextClarifyingQuestion || 'none'}`,
    `next_question=${context.nextQuestion || 'none'}`,
    'Do not ask the same question twice if it was already asked in the history.',
    'If force_telegram=yes, immediately transfer the lead to Telegram.',
    'If latest_message_low_signal=yes, ask only one clarifying question about country or passport when available.',
  ].join('\n');
}

function buildFallbackReply(context) {
  if (/почему отвеча(ете|ешь)/i.test(context.fullLeadText)) {
    return 'Мы работаем командой. Заявки обрабатываются несколькими менеджерами, я подключился к вашему запросу и помогаю вам сейчас.';
  }

  if (/не\s+верю/i.test(context.fullLeadText)) {
    return 'Наш головной офис находится в Германии. Мы работаем напрямую с работодателями, основная гарантия — официальный контракт.';
  }

  if (context.forceTelegram) {
    return buildTransferReply(context.extracted.name);
  }

  if (context.latestLeadMessageLowSignal) {
    const clarifyingReply = buildQuestionByKind(context.nextClarifyingQuestion);
    if (clarifyingReply) {
      return clarifyingReply;
    }
  }

  const nextQuestion = buildQuestionByKind(context.nextQuestion);
  if (nextQuestion) {
    return nextQuestion;
  }

  return buildTransferReply(context.extracted.name);
}

function finalizeReply(reply, context) {
  const cleanReply = sanitizeReply(reply);
  if (!cleanReply) {
    return buildFallbackReply(context);
  }

  if (context.forceTelegram && !cleanReply.includes(TELEGRAM_LINK)) {
    return `${cleanReply}\n${buildTransferReply(context.extracted.name)}`.trim();
  }

  return cleanReply;
}

function sanitizeReply(reply) {
  const normalized = String(reply || '')
    .replace(/\r/g, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '');

  if (!normalized) {
    return '';
  }

  if (normalized.length <= 500) {
    return normalized;
  }

  return `${normalized.slice(0, 497).trim()}...`;
}

function buildConversationContext(messages, stage) {
  const leadMessages = extractLeadMessages(messages);
  const assistantMessages = extractAssistantMessages(messages);
  const fullLeadText = leadMessages.join(' ');
  const latestLeadMessage = leadMessages.at(-1) ?? '';
  const extracted = {
    country: extractCountry(fullLeadText),
    passportStatus: extractPassportStatus(fullLeadText),
    name: extractName(fullLeadText),
  };
  const askedQuestions = {
    country: assistantMessages.some((text) => isCountryQuestion(text)),
    passport: assistantMessages.some((text) => isPassportQuestion(text)),
    name: assistantMessages.some((text) => isNameQuestion(text)),
  };
  const totalMessages = Array.isArray(messages) ? messages.length : 0;

  return {
    stage,
    fullLeadText,
    latestLeadMessage,
    latestLeadMessageLowSignal: isLowSignalMessage(latestLeadMessage, extracted),
    leadMessageCount: leadMessages.length,
    totalMessages,
    extracted,
    askedQuestions,
    nextClarifyingQuestion: pickClarifyingQuestion(askedQuestions, extracted),
    nextQuestion: pickNextQuestion(askedQuestions, extracted),
    forceTelegram: shouldForceTransfer({ stage, latestLeadMessage, totalMessages }),
  };
}

function shouldForceTransfer({ stage, latestLeadMessage, totalMessages }) {
  const closingQuestionPattern = /(зарплат|ваканси|услови|цена|стоим|документ|виз|график|жиль|ставк|сколько)/i;

  if (stage === 'hot') {
    return true;
  }

  if (totalMessages >= 6) {
    return true;
  }

  return closingQuestionPattern.test(latestLeadMessage);
}

function buildTransferReply(name) {
  const safeName = name ? `${name}, ` : '';
  return `Смотрите, ${safeName}более подробно вас сможет проконсультировать старший менеджер, так как я ниже по рангу и не смогу ответить на этот вопрос.\nНапишите ему в Telegram:\n${TELEGRAM_LINK}`;
}

function extractLeadMessages(messages) {
  return (messages || [])
    .filter((message) => message && (message.role === 'lead' || message.role === 'user' || message.direction === 'inbound'))
    .map((message) => String(message.text || '').trim())
    .filter(Boolean);
}

function extractAssistantMessages(messages) {
  return (messages || [])
    .filter((message) => message && (message.role === 'assistant' || message.direction === 'outbound'))
    .map((message) => String(message.text || '').trim())
    .filter(Boolean);
}

function extractCountry(text) {
  for (const country of COUNTRY_PATTERNS) {
    if (country.pattern.test(text)) {
      return country.label;
    }
  }

  return '';
}

function extractPassportStatus(text) {
  if (/(нет|без).{0,12}(загран|паспорт)|(загран|паспорт).{0,12}(нет|без)/i.test(text)) {
    return 'no';
  }

  if (/(есть|имеется|готов|сделан).{0,12}(загран|паспорт)|(загран|паспорт).{0,12}(есть|имеется|готов|сделан)/i.test(text)) {
    return 'yes';
  }

  return 'unknown';
}

function isCountryQuestion(text) {
  return /(в какой стране|какой стране|где вы сейчас|где сейчас находитесь|в какой стране вы)/i.test(text);
}

function isPassportQuestion(text) {
  return /(загранпаспорт|загран паспорт|загран|паспорт)/i.test(text);
}

function isNameQuestion(text) {
  return /(как я могу к вам обращаться|как вас зовут|ваше имя|как к вам обращаться)/i.test(text);
}

function isLowSignalMessage(text, extracted) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return true;
  }

  if (SHORT_AMBIGUOUS_REPLIES.has(normalized)) {
    return true;
  }

  const words = normalized.split(' ').filter(Boolean);
  if (words.length <= 2 && !containsUsefulSignal(normalized, extracted)) {
    return true;
  }

  return words.length <= 3 && !containsUsefulSignal(normalized, extracted) && !normalized.includes('?');
}

function containsUsefulSignal(text, extracted) {
  return Boolean(
    extracted.country ||
      extracted.name ||
      extractPassportStatus(text) !== 'unknown' ||
      /(зарплат|ваканси|услови|документ|виз)/i.test(text),
  );
}

function pickClarifyingQuestion(askedQuestions, extracted) {
  if (!extracted.country && !askedQuestions.country) {
    return 'country';
  }

  if (extracted.passportStatus === 'unknown' && !askedQuestions.passport) {
    return 'passport';
  }

  return '';
}

function pickNextQuestion(askedQuestions, extracted) {
  if (!extracted.country && !askedQuestions.country) {
    return 'country';
  }

  if (extracted.passportStatus === 'unknown' && !askedQuestions.passport) {
    return 'passport';
  }

  if (!extracted.name && !askedQuestions.name) {
    return 'name';
  }

  return '';
}

function buildQuestionByKind(kind) {
  if (kind === 'country') {
    return COUNTRY_QUESTION;
  }

  if (kind === 'passport') {
    return PASSPORT_QUESTION;
  }

  if (kind === 'name') {
    return NAME_QUESTION;
  }

  return '';
}

function extractName(text) {
  const match = text.match(/(?:меня зовут|я\s+)([А-ЯЁ][а-яё-]+)(?:\s|$)/i);
  if (!match) {
    return '';
  }

  const candidate = capitalize(match[1]);
  if (['Из', 'Не', 'Да', 'Нет', 'В', 'Сейчас', 'Нахожусь', 'Живу', 'Работаю', 'Ищу'].includes(candidate)) {
    return '';
  }

  return candidate;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isConfiguredSecret(value) {
  const normalized = String(value || '').trim();
  return Boolean(normalized && normalized.toLowerCase() !== 'change-me');
}

function serializeError(error) {
  return {
    message: error.message,
    status: error.response?.status,
    data: error.response?.data,
  };
}

module.exports = {
  generateReply,
};
