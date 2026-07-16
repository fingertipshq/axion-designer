export class ReferenceSystemError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReferenceSystemError';
    this.code = code;
    Object.assign(this, details);
  }
}

export class ReferenceValidationError extends ReferenceSystemError {
  constructor(issues, message = 'Reference artifact validation failed') {
    const normalized = Array.isArray(issues) ? issues.map(String) : [String(issues)];
    super('DK_REFERENCE_VALIDATION', `${message}:\n- ${normalized.join('\n- ')}`, { issues: normalized });
    this.name = 'ReferenceValidationError';
  }
}

export function isReferenceSystemError(error) {
  return error instanceof ReferenceSystemError
    || String(error?.code ?? '').startsWith('DK_REFERENCE_');
}

