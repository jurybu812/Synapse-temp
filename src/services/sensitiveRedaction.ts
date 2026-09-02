const SENSITIVE_VALUE_KEY = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie|credential|session)(?:$|[_-])/i;

export function redactSensitiveText(value: string): string {
  return value
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie|credential|session)[A-Za-z0-9_.-]*\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/\b(sk-(?:proj-)?)[A-Za-z0-9_-]{8,}\b/g, '$1[redacted]');
}

export function redactSensitiveValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_VALUE_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(item => redactSensitiveValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => (
      [entryKey, redactSensitiveValue(entryValue, entryKey)]
    )));
  }
  return value;
}
