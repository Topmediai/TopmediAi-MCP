import { TopMediaiError, type RequestErrorDetails, type RequestFailure } from '../types.js';

type Timing = { http_status?: number; timeout_ms: number; elapsed_ms: number };
// Keep business meanings aligned with the Web image/video generation handlers.
const businessMessages: Record<number, { code: string; message: string; suggestion: string }> = {
  400022: { code: 'INSUFFICIENT_CREDITS', message: 'You do not have enough credits for this generation.', suggestion: 'Check the available credits for this account and add credits before creating a new request.' },
  400030: { code: 'CONCURRENCY_LIMIT', message: 'Too many generation tasks are already in progress.', suggestion: 'Wait for the current tasks to finish before creating another request.' },
  400151: { code: 'CONTENT_RESTRICTED', message: 'The input contains content that cannot be generated.', suggestion: 'Revise the prompt or reference content before creating a new request.' },
  400072: { code: 'MEMBERSHIP_REQUIRED', message: 'This feature requires a membership.', suggestion: 'Check whether the current account has the required membership.' },
  400046: { code: 'UNSUPPORTED_LANGUAGE', message: 'This model does not support the selected language.', suggestion: 'Use English, as recommended by this model.' },
};

function numericCode(value: unknown): number | undefined {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

/** Only short, plain product messages may leave the transport; never raw error bodies. */
export function safeBackendMessage(value: unknown, secrets: string[] = []): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) return;
  if (secrets.some(secret => secret && value.includes(secret))) return;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>\r\n{}]/.test(value)
    || /https?:\/\/|file:\/\/|[A-Za-z]:[\\/]|\\\\|\/(?:[\w.-]+\/)+/i.test(value)
    || /\b(?:token|authorization|bearer|cookie|password|secret|private|sensitive|traceback|exception|stack|sql|credential|api[_ -]?key|access[_ -]?key|select\s+.+\s+from)\b/i.test(value)
    || /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(value)
    || /\b(?:sk-[\w-]+|[A-Za-z0-9_-]{32,})\b/.test(value)) return;
  return value.trim();
}

export function backendResponseError(payload: unknown, timing: Timing, secrets: string[] = []): TopMediaiError | undefined {
  const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const status = numericCode(data.status), check = numericCode(data.check_code);
  const details = { ...timing, ...(status !== undefined ? { backend_status: status } : {}), ...(check !== undefined ? { backend_code: check } : {}) };
  if (timing.http_status === 401 || [status, check].some(code => code === 401 || code === 400401)) {
    return new TopMediaiError('LOGIN_REQUIRED', 'Your login has expired. Please sign in again.', undefined,
      { ...details, category: 'authentication', suggestion: 'Sign in to TopMediai again, then check the original generation history before submitting a new paid request.' });
  }
  const httpFailed = timing.http_status !== undefined && (timing.http_status < 200 || timing.http_status >= 300);
  // Backends may report successful responses through status=200 or status=200000.
  const statusSucceeded = status === 200 || status === 200000;
  const failed = [check !== 200000 ? check : undefined, !statusSucceeded ? status : undefined].filter((code): code is number => code !== undefined);
  // An explicit rejection wins over a conflicting success field.
  if (!httpFailed && !failed.length && (statusSucceeded || check === 200000)) return;
  const mapped = failed.map(code => businessMessages[code]).find(Boolean);
  if (mapped) return new TopMediaiError(mapped.code, mapped.message, undefined, { ...details, category: 'business', suggestion: mapped.suggestion });
  if (httpFailed) {
    const http = timing.http_status!;
    const message = http === 429 ? 'Too many requests. Please wait before trying again.'
      : http >= 500 ? 'The generation service is temporarily unavailable.' : `The service could not process this request (HTTP ${http}).`;
    return new TopMediaiError('HTTP_ERROR', message, undefined,
      { ...details, category: 'http', suggestion: http >= 500 || http === 429 ? 'Check the original task history and try again later if no task was created.' : 'Check the request settings and your account access.' });
  }
  const message = safeBackendMessage(data.message, secrets) ?? safeBackendMessage(data.msg, secrets)
    ?? 'The service rejected this request. The specific reason was not provided.';
  return new TopMediaiError('BUSINESS_ERROR', message, undefined,
    { ...details, category: 'business', suggestion: 'Check the request settings. If the issue continues, contact support with the error code.' });
}

export function transportError(error: unknown, timing: Timing, timeout: AbortSignal, cancelled?: AbortSignal): TopMediaiError {
  if (error instanceof TopMediaiError) {
    if (error.requestDetails) return error;
    return new TopMediaiError(error.code, error.message, error.details, { ...timing, category: 'invalid_response',
      suggestion: 'The service response could not be read. Check the original task history before creating a new paid request.' });
  }
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  if (cancelled?.aborted) return new TopMediaiError('REQUEST_CANCELLED', 'The request was cancelled before a complete response was received.', undefined,
    { ...timing, category: 'cancelled', suggestion: 'Check the original task history; cancellation does not confirm that generation has stopped.' });
  if (timeout.aborted || name === 'TimeoutError') return new TopMediaiError('REQUEST_TIMEOUT', `The service did not respond within ${timing.timeout_ms / 1000} seconds.`, undefined,
    { ...timing, category: 'timeout', suggestion: 'The service may still be processing the request. Check the original task history before creating another paid request.' });
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined;
  const rawCode = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  const networkCode = typeof rawCode === 'string' && /^(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT|UND_ERR_SOCKET)$/.test(rawCode) ? rawCode : undefined;
  if (networkCode?.endsWith('_TIMEOUT')) return new TopMediaiError('REQUEST_TIMEOUT', 'The connection to the generation service timed out.', undefined,
    { ...timing, network_code: networkCode, category: 'timeout', suggestion: 'Check your connection and the original task history before submitting another paid request.' });
  return new TopMediaiError('NETWORK_ERROR', 'The connection to the generation service failed or was interrupted.', undefined,
    { ...timing, ...(networkCode ? { network_code: networkCode } : {}), category: 'network', suggestion: 'Check your network connection and the original task history before submitting another paid request.' });
}

export const UNKNOWN_SUBMISSION_RECOVERY = 'Check the original TopMediai task history before creating a new request. This submission will not be retried automatically; completion and charges have not been confirmed.';

export function requestFailure(error: unknown): RequestFailure {
  if (error instanceof TopMediaiError) return { code: error.code, message: safeBackendMessage(error.message)
    ?? 'The service could not complete this request.', ...(error.requestDetails ? { details: error.requestDetails } : {}) };
  return { code: 'REQUEST_FAILED', message: 'The request ended without a usable generation response.',
    details: { category: 'unknown', suggestion: UNKNOWN_SUBMISSION_RECOVERY } };
}
