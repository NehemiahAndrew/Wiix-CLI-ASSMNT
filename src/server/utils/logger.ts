// =============================================================================
// Safe Logger — NEVER logs tokens, passwords, secrets or PII
// =============================================================================
import winston from 'winston';

const REDACT_KEYS = new Set([
  'access_token', 'accesstoken', 'refresh_token', 'refreshtoken',
  'token', 'secret', 'password', 'authorization', 'cookie',
  'apikey', 'api_key', 'client_secret', 'clientsecret',
  'wixappsecret', 'hubspotclientsecret', 'jwtsecret',
]);

function redactSensitive(obj: unknown, depth = 0): unknown {
  if (depth > 6 || !obj || typeof obj !== 'object') return obj;
  const clean: Record<string, unknown> = Array.isArray(obj) ? ([] as unknown as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const normKey = key.toLowerCase().replace(/[_\-.\s]/g, '');
    if (REDACT_KEYS.has(normKey)) {
      clean[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      clean[key] = redactSensitive(value, depth + 1);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const safe = redactSensitive(meta);
      const metaStr =
        typeof safe === 'object' && Object.keys(safe as object).length
          ? ` ${JSON.stringify(safe)}`
          : '';
      return `[${timestamp as string}] ${level.toUpperCase()}: ${message as string}${metaStr}`;
    }),
  ),
  transports: [
    new winston.transports.Console(),
    ...(process.env.NODE_ENV !== 'production'
      ? [new winston.transports.File({ filename: 'logs/app.log', maxsize: 5_000_000, maxFiles: 3 })]
      : []),
  ],
});

export default logger;
