// =============================================================================
// DatabaseError — Typed error for all mapping store failures
// =============================================================================
// Wraps raw database/Mongoose errors so consumers get a clean, predictable
// error type. NEVER includes actual contact data in the message — only
// operation names and generic identifiers.
// =============================================================================

export type DatabaseOperation =
  | 'findByWixId'
  | 'findByHubSpotId'
  | 'upsert'
  | 'delete'
  | 'setup'
  | 'count';

export class DatabaseError extends Error {
  /** Which mapping-store operation failed */
  public readonly operation: DatabaseOperation;
  /** The original error (for internal logging only — never expose to callers) */
  public readonly cause: Error;

  constructor(operation: DatabaseOperation, cause: Error) {
    // Generic message with no contact data — safe to log
    super(`Mapping store ${operation} failed: ${sanitiseMessage(cause.message)}`);
    this.name = 'DatabaseError';
    this.operation = operation;
    this.cause = cause;

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, DatabaseError.prototype);
  }
}

/**
 * Strip anything that looks like an ID, email, or token from the error
 * message so we never accidentally leak contact data.
 */
function sanitiseMessage(msg: string): string {
  return msg
    // Remove email-like patterns
    .replace(/[\w.-]+@[\w.-]+\.\w+/g, '[REDACTED_EMAIL]')
    // Remove long hex strings (Mongo ObjectIds, UUIDs)
    .replace(/\b[0-9a-f]{24,}\b/gi, '[REDACTED_ID]')
    // Remove UUIDs
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '[REDACTED_UUID]',
    )
    // Truncate to reasonable length
    .slice(0, 200);
}
