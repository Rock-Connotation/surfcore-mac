export class PerceptionError extends Error {
  constructor(code, error, hint, { retryable = false, stage = null, cause } = {}) {
    super(error || 'ASR operation failed', cause ? { cause } : undefined);
    this.name = 'PerceptionError';
    this.code = code || 'ASR_FAILED';
    this.error = error || 'ASR operation failed';
    this.hint = hint || 'Check the ASR job details and retry after correcting the reported issue.';
    this.retryable = Boolean(retryable);
    this.stage = stage;
  }
}

export function fail(code, error, hint, options) {
  return new PerceptionError(code, error, hint, options);
}

export function errorRecord(error, fallback = {}) {
  if (error && typeof error === 'object' && error.code && error.error && error.hint) {
    return {
      code: String(error.code),
      error: String(error.error),
      hint: String(error.hint),
      retryable: Boolean(error.retryable),
      stage: error.stage || null,
    };
  }
  return {
    code: fallback.code || 'ASR_FAILED',
    error: fallback.error || 'ASR operation failed.',
    hint: fallback.hint || 'Inspect the local diagnostic and retry after correcting the issue.',
    retryable: Boolean(fallback.retryable),
    stage: fallback.stage || null,
  };
}
