/**
 * Portable cancellation error (works without a DOM lib).
 * Matches the `AbortError` name convention so callers can detect it.
 */
export function abortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

