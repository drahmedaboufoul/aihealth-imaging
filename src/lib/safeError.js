/*
 * safeError — user-facing error text for the staff viewers and share pages.
 *
 * Raw errors can carry signed URLs, storage paths, row ids, emails or
 * backend (PostgREST / Storage / edge function) messages. The UI shows only
 * a short redacted message, or a generic fallback when the text looks like a
 * backend error. Keep the raw error in console logs for support.
 */

export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again or contact the clinic.';

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+|\bdata:[^\s'"<>)]+/gi;
const EMAIL_RE = /[^\s@'"<>()]+@[^\s@'"<>()]+\.[^\s@'"<>()]+/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+/g;
const TOKEN_RE = /\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b/g;
const ID_PARAM_RE = /\b(id|study|patient|file|path|token)=[^\s,;&)]+/gi;

// Backend/driver error shapes that should never be shown verbatim.
const BACKEND_RE = /PGRST|SQLSTATE|JWT|row-level security|violates|duplicate key|relation "|column "|permission denied|syntax error|StorageApiError|FunctionsHttpError|storage\/v1|functions\/v1|rest\/v1|supabase|postgres|Anthropic|x-api-key|\bat \S+ \(/i;

const MAX_LENGTH = 180;

/** Message text from an Error, a typed { message } object, or a string. */
function rawMessage(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string') return err.message;
  return '';
}

/**
 * Return text that is safe to render: no URLs, paths, ids, emails, tokens or
 * raw backend errors. Falls back to `fallback` when nothing safe remains.
 */
export function safeErrorMessage(err, fallback = GENERIC_ERROR_MESSAGE) {
  const raw = rawMessage(err).trim();
  if (!raw || BACKEND_RE.test(raw)) return fallback;
  const cleaned = raw
    .replace(URL_RE, '[link]')
    .replace(EMAIL_RE, '[email]')
    .replace(UUID_RE, '[id]')
    .replace(ID_PARAM_RE, '$1=[id]')
    .replace(PATH_RE, '[file]')
    .replace(TOKEN_RE, '[id]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length > MAX_LENGTH) return fallback;
  return cleaned;
}
