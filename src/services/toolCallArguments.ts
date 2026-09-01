export function normalizeToolCallArguments(value: string | null | undefined): string {
  return value?.trim() || '{}';
}

export function parseToolCallArguments(value: string | null | undefined): Record<string, unknown> {
  const normalized = normalizeToolCallArguments(value);
  const parsed: unknown = JSON.parse(normalized);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new SyntaxError('Tool call arguments must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}
