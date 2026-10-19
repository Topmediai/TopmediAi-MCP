/** Shareable diagnostics only. Never apply this projection to normal MCP results. */
export type Diagnostic = null | string | number | boolean | Diagnostic[] | { [key: string]: Diagnostic };
const normalized = (key: string) => key.toLowerCase().replace(/[-_]/g, '');
const secrets = new Set(['token', 'accesstoken', 'refreshtoken', 'authorization', 'cookie', 'setcookie',
  'password', 'secret', 'privatekey', 'apikey', 'accesskey', 'accesskeyid', 'accesskeysecret', 'securitytoken',
  'sessionproof', 'proof', 'ciphertext', 'email', 'emailmasked', 'prompt', 'description', 'lyrics', 'title',
  'filename', 'url', 'uri', 'link', 'authorizationurl', 'privatelink', 'encodedreference', 'message', 'stack',
  'body', 'rawresponse', 'credits', 'estimatedcredits', 'characters', 'balancebefore', 'balanceafter', 'budget']);
const containers = new Set(['status', 'task', 'tasks', 'quote', 'submitted', 'balance', 'models', 'model',
  'images', 'artifacts', 'error', 'details', 'cause', 'capabilities', 'pricing', 'costs']);
const booleans = new Set(['tokenconfigured', 'credentialconfigured', 'credentialrefreshenabled', 'gatewayconfigured',
  'imageuploadenabled', 'referencemediauploadenabled', 'speechuploadenabled', 'automaticretry', 'reportsaved', 'sharedreportsaved']);
const counters: Record<string, number> = { httpstatus: 599, backendstatus: 999999, backendcode: 999999,
  timeoutms: 3600000, elapsedms: 86400000, retrycount: 10000, toolcount: 10000, pollafterseconds: 3600 };
const ids: Record<string, string> = { memberid: 'account', userid: 'account', accountid: 'account',
  requestid: 'task', groupid: 'task', taskid: 'task', taskhandle: 'task', quoteid: 'quote',
  referenceimageid: 'image', referencemediaid: 'media', speechassetid: 'audio', loginid: 'login' };
const states = new Set(['ready', 'submitted', 'submitting', 'submission_unknown', 'queued', 'running', 'completed',
  'failed', 'waiting', 'saved', 'cancelled', 'expired', 'unavailable', 'available', 'not_configured', 'unknown']);
const errorCodes = new Set(['LOGIN_REQUIRED', 'INVALID_CONFIG', 'INVALID_RESPONSE', 'HTTP_ERROR', 'BUSINESS_ERROR',
  'NETWORK_ERROR', 'REQUEST_TIMEOUT', 'REQUEST_CANCELLED', 'SUBMISSION_UNKNOWN', 'INSUFFICIENT_CREDITS',
  'CONCURRENCY_LIMIT', 'CONTENT_RESTRICTED', 'MEMBERSHIP_REQUIRED', 'UNSUPPORTED_LANGUAGE', 'INTERNAL_ERROR',
  'STORE_BUSY', 'STORE_LOCK_UNAVAILABLE', 'UPLOAD_FAILED', 'INVALID_UPLOAD_URL', 'INVALID_REFERENCE_IMAGE',
  'INVALID_REFERENCE_MEDIA', 'DIAGNOSTIC_ERROR']);
const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

export function sanitizeDiagnostic(input: unknown): Diagnostic {
  const aliases = new Map<string, string>(), counts = new Map<string, number>(), active = new WeakSet<object>();
  function visit(value: unknown, depth: number): Diagnostic {
    if (depth > 12) return '[REDACTED]';
    if (!value || typeof value !== 'object') return '[REDACTED]';
    if (active.has(value)) return '[CIRCULAR]';
    if (value instanceof Error) return { code: 'DIAGNOSTIC_ERROR' };
    active.add(value);
    try {
      if (Array.isArray(value)) return value.slice(0, 100).map(item => visit(item, depth + 1));
      const result: Record<string, Diagnostic> = {};
      for (const [key, entry] of Object.entries(value)) {
        const field = normalized(key);
        if (Object.hasOwn(ids, field)) {
          if (typeof entry !== 'string' && typeof entry !== 'number') { result[key] = '[REDACTED]'; continue; }
          const family = ids[field]!;
          const identity = `${family}:${entry}`;
          if (!aliases.has(identity)) {
            const next = (counts.get(family) ?? 0) + 1;
            counts.set(family, next); aliases.set(identity, `${family}_${String(next).padStart(3, '0')}`);
          }
          result[key] = aliases.get(identity)!;
        } else if (booleans.has(field) && typeof entry === 'boolean') result[key] = entry;
        else if (Object.hasOwn(counters, field) && typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0 && entry <= counters[field]!) result[key] = entry;
        else if (['path', 'filepath', 'report', 'datadir', 'uploadroot'].includes(field)) result[key] = '[LOCAL_PATH]';
        else if (secrets.has(field)) result[key] = '[REDACTED]';
        else if (containers.has(field) && entry && typeof entry === 'object') result[key] = visit(entry, depth + 1);
        else if (field === 'environment' && entry === 'production') result[key] = entry;
        else if (field === 'mode' && entry === 'live') result[key] = entry;
        else if (['status', 'pricingstatus'].includes(field) && typeof entry === 'string' && states.has(entry)) result[key] = entry;
        else if (['version', 'serverversion'].includes(field) && typeof entry === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(entry)) result[key] = entry;
        else if (field === 'code' && typeof entry === 'string' && errorCodes.has(entry)) result[key] = entry;
        else if (field === 'networkcode' && typeof entry === 'string' && networkCodes.has(entry)) result[key] = entry;
        else if (field === 'credentialsource' && ['none', 'environment', 'local-file'].includes(String(entry))) result[key] = String(entry);
        // Unknown keys are omitted, including maps keyed by user IDs or text.
      }
      return result;
    } finally { active.delete(value); }
  }
  return visit(input, 0);
}
