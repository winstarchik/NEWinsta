require('dotenv').config();

const path = require('path');

const { createStorage } = require('../storage');

const storage = createStorage({
  dbPath: process.env.STORAGE_PATH || path.resolve(__dirname, '..', '..', 'data', 'storage.sqlite'),
  maxConversationMessages: Number(process.env.MAX_CONVERSATION_MESSAGES || 30),
  maxProcessedMessages: Number(process.env.MAX_PROCESSED_MESSAGES || 5000),
});

const retentionDays = Number(process.env.CONVERSATION_RETENTION_DAYS || 30);
const deletedCount = storage.cleanupOldConversations(retentionDays);

console.log(`Cleanup completed. Deleted conversations: ${deletedCount}`);
