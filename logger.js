const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function createLogger(scope) {
  const envLevel = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  const threshold = LEVELS[envLevel] ?? LEVELS.info;

  function log(level, message, meta = {}) {
    if ((LEVELS[level] ?? LEVELS.info) > threshold) {
      return;
    }

    const payload = {
      ts: new Date().toISOString(),
      level,
      scope,
      message,
      ...meta,
    };

    const output = JSON.stringify(payload);

    if (level === 'error') {
      console.error(output);
      return;
    }

    if (level === 'warn') {
      console.warn(output);
      return;
    }

    console.log(output);
  }

  return {
    error(message, meta) {
      log('error', message, meta);
    },
    warn(message, meta) {
      log('warn', message, meta);
    },
    info(message, meta) {
      log('info', message, meta);
    },
    debug(message, meta) {
      log('debug', message, meta);
    },
  };
}

module.exports = {
  createLogger,
};
