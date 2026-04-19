const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { createLogger } = require('./logger');

const logger = createLogger('storage');

const PROFILE_COLUMNS = [
  { column: 'lead_name', type: "TEXT NOT NULL DEFAULT ''" },
  { column: 'lead_country', type: "TEXT NOT NULL DEFAULT ''" },
  { column: 'lead_citizenship', type: "TEXT NOT NULL DEFAULT ''" },
  { column: 'passport_status', type: "TEXT NOT NULL DEFAULT ''" },
  { column: 'lead_age', type: "TEXT NOT NULL DEFAULT ''" },
  { column: 'telegram_label', type: "TEXT NOT NULL DEFAULT ''" },
  { column: 'lead_notes', type: "TEXT NOT NULL DEFAULT ''" },
];

class SqliteStorage {
  constructor(options = {}) {
    this.dbPath = options.dbPath || path.resolve(process.cwd(), 'data', 'storage.sqlite');
    this.maxConversationMessages = options.maxConversationMessages ?? 30;
    this.maxProcessedMessages = options.maxProcessedMessages ?? 5000;

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS conversations (
        user_id TEXT PRIMARY KEY,
        stage TEXT NOT NULL DEFAULT 'cold',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        message_id TEXT,
        role TEXT NOT NULL,
        direction TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        timestamp INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES conversations(user_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_user_id_row_id
      ON messages(user_id, row_id DESC);

      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reply_reservations (
        user_id TEXT PRIMARY KEY,
        reserved_at INTEGER NOT NULL
      );
    `);

    this.ensureProfileColumns();

    this.statements = {
      insertConversation: this.db.prepare(`
        INSERT INTO conversations (user_id, stage, created_at, updated_at)
        VALUES (?, 'cold', ?, ?)
        ON CONFLICT(user_id) DO NOTHING
      `),
      selectConversation: this.db.prepare(`
        SELECT
          user_id AS userId,
          stage,
          created_at AS createdAt,
          updated_at AS updatedAt,
          lead_name AS leadName,
          lead_country AS leadCountry,
          lead_citizenship AS leadCitizenship,
          passport_status AS passportStatus,
          lead_age AS leadAge,
          telegram_label AS telegramLabel,
          lead_notes AS leadNotes
        FROM conversations
        WHERE user_id = ?
      `),
      selectConversationSummaries: this.db.prepare(`
        SELECT
          c.user_id AS userId,
          c.stage AS stage,
          c.created_at AS createdAt,
          c.updated_at AS updatedAt,
          c.lead_name AS leadName,
          c.lead_country AS leadCountry,
          c.passport_status AS passportStatus,
          c.telegram_label AS telegramLabel,
          (
            SELECT text
            FROM messages m
            WHERE m.user_id = c.user_id
            ORDER BY m.row_id DESC
            LIMIT 1
          ) AS lastMessageText,
          (
            SELECT direction
            FROM messages m
            WHERE m.user_id = c.user_id
            ORDER BY m.row_id DESC
            LIMIT 1
          ) AS lastMessageDirection,
          (
            SELECT timestamp
            FROM messages m
            WHERE m.user_id = c.user_id
            ORDER BY m.row_id DESC
            LIMIT 1
          ) AS lastMessageTimestamp,
          (
            SELECT COUNT(*)
            FROM messages m
            WHERE m.user_id = c.user_id
          ) AS messageCount
        FROM conversations c
        ORDER BY c.updated_at DESC
        LIMIT ?
      `),
      touchConversation: this.db.prepare(`
        UPDATE conversations
        SET updated_at = ?
        WHERE user_id = ?
      `),
      updateStage: this.db.prepare(`
        UPDATE conversations
        SET stage = ?, updated_at = ?
        WHERE user_id = ?
      `),
      updateProfile: this.db.prepare(`
        UPDATE conversations
        SET
          lead_name = ?,
          lead_country = ?,
          lead_citizenship = ?,
          passport_status = ?,
          lead_age = ?,
          telegram_label = ?,
          lead_notes = ?,
          updated_at = ?
        WHERE user_id = ?
      `),
      insertMessage: this.db.prepare(`
        INSERT INTO messages (user_id, message_id, role, direction, text, timestamp, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      selectMessages: this.db.prepare(`
        SELECT
          message_id AS id,
          role,
          direction,
          text,
          timestamp,
          created_at AS createdAt
        FROM messages
        WHERE user_id = ?
        ORDER BY row_id ASC
      `),
      pruneMessages: this.db.prepare(`
        DELETE FROM messages
        WHERE user_id = ?
          AND row_id NOT IN (
            SELECT row_id
            FROM messages
            WHERE user_id = ?
            ORDER BY row_id DESC
            LIMIT ?
          )
      `),
      selectProcessedMessage: this.db.prepare(`
        SELECT 1 AS existsFlag
        FROM processed_messages
        WHERE message_id = ?
      `),
      upsertProcessedMessage: this.db.prepare(`
        INSERT INTO processed_messages (message_id, processed_at)
        VALUES (?, ?)
        ON CONFLICT(message_id) DO UPDATE
        SET processed_at = excluded.processed_at
      `),
      pruneProcessedMessages: this.db.prepare(`
        DELETE FROM processed_messages
        WHERE message_id NOT IN (
          SELECT message_id
          FROM processed_messages
          ORDER BY processed_at DESC
          LIMIT ?
        )
      `),
      selectReplyReservation: this.db.prepare(`
        SELECT reserved_at AS reservedAt
        FROM reply_reservations
        WHERE user_id = ?
      `),
      upsertReplyReservation: this.db.prepare(`
        INSERT INTO reply_reservations (user_id, reserved_at)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE
        SET reserved_at = excluded.reserved_at
      `),
      deleteReplyReservation: this.db.prepare(`
        DELETE FROM reply_reservations
        WHERE user_id = ? AND reserved_at = ?
      `),
      deleteReplyReservationsForOldConversations: this.db.prepare(`
        DELETE FROM reply_reservations
        WHERE user_id IN (
          SELECT user_id
          FROM conversations
          WHERE updated_at < ?
        )
      `),
      deleteOldConversations: this.db.prepare(`
        DELETE FROM conversations
        WHERE updated_at < ?
      `),
    };

    logger.info('SQLite storage initialized', {
      dbPath: this.dbPath,
      maxConversationMessages: this.maxConversationMessages,
      maxProcessedMessages: this.maxProcessedMessages,
    });
  }

  ensureProfileColumns() {
    for (const definition of PROFILE_COLUMNS) {
      try {
        this.db.exec(`ALTER TABLE conversations ADD COLUMN ${definition.column} ${definition.type}`);
      } catch (error) {
        if (!String(error.message || '').includes('duplicate column name')) {
          throw error;
        }
      }
    }
  }

  getConversation(userId) {
    const conversation = this.statements.selectConversation.get(userId);
    if (!conversation) {
      return null;
    }

    return {
      ...hydrateConversationRow(conversation),
      messages: this.statements.selectMessages.all(userId),
    };
  }

  listConversations(limit = 100) {
    return this.statements.selectConversationSummaries.all(limit).map((conversation) => ({
      ...hydrateConversationRow(conversation),
      messageCount: Number(conversation.messageCount ?? 0),
      lastMessageText: conversation.lastMessageText || '',
      lastMessageDirection: conversation.lastMessageDirection || '',
      lastMessageTimestamp: conversation.lastMessageTimestamp ? Number(conversation.lastMessageTimestamp) : null,
    }));
  }

  getOrCreateConversation(userId) {
    const now = new Date().toISOString();
    this.statements.insertConversation.run(userId, now, now);
    return this.getConversation(userId);
  }

  appendInboundMessage(userId, payload) {
    return this.appendMessage(userId, {
      ...payload,
      role: 'lead',
      direction: 'inbound',
    });
  }

  appendOutboundMessage(userId, payload) {
    return this.appendMessage(userId, {
      ...payload,
      role: 'assistant',
      direction: 'outbound',
    });
  }

  appendMessage(userId, payload) {
    const nowIso = new Date().toISOString();
    this.statements.insertConversation.run(userId, nowIso, nowIso);
    this.statements.insertMessage.run(
      userId,
      payload.id ?? null,
      payload.role,
      payload.direction,
      payload.text ?? '',
      payload.timestamp ?? Date.now(),
      nowIso,
    );
    this.statements.pruneMessages.run(userId, userId, this.maxConversationMessages);
    this.statements.touchConversation.run(nowIso, userId);
    return this.getConversation(userId);
  }

  setStage(userId, stage) {
    const nowIso = new Date().toISOString();
    this.statements.insertConversation.run(userId, nowIso, nowIso);
    this.statements.updateStage.run(stage, nowIso, userId);
  }

  saveLeadProfile(userId, profileUpdates = {}) {
    const currentConversation = this.getOrCreateConversation(userId);
    const normalizedProfile = normalizeLeadProfile({
      ...currentConversation.profile,
      ...profileUpdates,
    });
    const nowIso = new Date().toISOString();

    this.statements.updateProfile.run(
      normalizedProfile.name,
      normalizedProfile.country,
      normalizedProfile.citizenship,
      normalizedProfile.passportStatus,
      normalizedProfile.age,
      normalizedProfile.telegramLabel,
      normalizedProfile.notes,
      nowIso,
      userId,
    );

    return this.getConversation(userId);
  }

  cleanupOldConversations(retentionDays = 30) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    this.statements.deleteReplyReservationsForOldConversations.run(cutoff);
    const result = this.statements.deleteOldConversations.run(cutoff);
    const deletedCount = Number(result?.changes ?? 0);

    if (deletedCount > 0) {
      logger.info('Old conversations cleaned up', {
        retentionDays,
        deletedCount,
      });
    }

    return deletedCount;
  }

  hasProcessedMessage(messageId) {
    if (!messageId) {
      return false;
    }

    return Boolean(this.statements.selectProcessedMessage.get(messageId));
  }

  markProcessed(messageId) {
    if (!messageId) {
      return;
    }

    this.statements.upsertProcessedMessage.run(messageId, Date.now());
    this.trimProcessedMessages();
  }

  trimProcessedMessages() {
    this.statements.pruneProcessedMessages.run(this.maxProcessedMessages);
  }

  reserveReplySlot(userId, minIntervalMs = 2000) {
    const now = Date.now();
    const reservation = this.statements.selectReplyReservation.get(userId);
    const lastReplyAt = reservation?.reservedAt ?? 0;
    const diff = now - lastReplyAt;

    if (diff < minIntervalMs) {
      return {
        allowed: false,
        retryAfterMs: minIntervalMs - diff,
      };
    }

    this.statements.upsertReplyReservation.run(userId, now);
    return {
      allowed: true,
      reservedAt: now,
    };
  }

  confirmReplySlot(userId, timestamp = Date.now()) {
    this.statements.upsertReplyReservation.run(userId, timestamp);
  }

  releaseReplySlot(userId, reservedAt) {
    this.statements.deleteReplyReservation.run(userId, reservedAt);
  }
}

function hydrateConversationRow(row) {
  return {
    userId: row.userId,
    stage: row.stage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    profile: {
      name: row.leadName || '',
      country: row.leadCountry || '',
      citizenship: row.leadCitizenship || '',
      passportStatus: row.passportStatus || '',
      age: row.leadAge || '',
      telegramLabel: row.telegramLabel || '',
      notes: row.leadNotes || '',
    },
  };
}

function normalizeLeadProfile(profile = {}) {
  return {
    name: normalizeProfileText(profile.name),
    country: normalizeProfileText(profile.country),
    citizenship: normalizeProfileText(profile.citizenship),
    passportStatus: normalizePassportStatus(profile.passportStatus),
    age: normalizeProfileText(profile.age),
    telegramLabel: normalizeProfileText(profile.telegramLabel),
    notes: normalizeMultilineText(profile.notes),
  };
}

function normalizeProfileText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMultilineText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .trim();
}

function normalizePassportStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const allowed = new Set(['', 'unknown', 'yes', 'no', 'processing']);
  return allowed.has(normalized) ? normalized : '';
}

function createStorage(options) {
  return new SqliteStorage(options);
}

module.exports = {
  SqliteStorage,
  createStorage,
};
