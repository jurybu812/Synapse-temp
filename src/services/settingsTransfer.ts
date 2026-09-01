const SECRET_KEYS = new Set([
  'apikey',
  'apikeys',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'credential',
  'credentials',
]);

export function isSensitiveSettingsKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SECRET_KEYS.has(normalized) || normalized.includes('providercredential');
}

export function sanitizeSettingsValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.startsWith('data:image/') ? '[wallpaper-data-url-omitted]' : value;
  }
  if (Array.isArray(value)) return value.map(sanitizeSettingsValue);
  if (!value || typeof value !== 'object') return value;
  const next: Record<string, unknown> = {};
  for (const [key, itemValue] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveSettingsKey(key)) continue;
    next[key] = sanitizeSettingsValue(itemValue);
  }
  return next;
}

export function sanitizeSettingsMap(settings: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (isSensitiveSettingsKey(key)) continue;
    result[key] = sanitizeSettingsValue(value);
  }
  return result;
}
