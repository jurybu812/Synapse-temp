export interface ToolTaskIdentityParts {
  conversationId: string;
  runId: string;
  callId: string;
  ownerId: string;
}

export async function managedTaskId(kind: string, identity: ToolTaskIdentityParts): Promise<string> {
  const bytes = new TextEncoder().encode([
    kind,
    identity.conversationId,
    identity.ownerId,
    identity.runId,
    identity.callId,
  ].join('\0'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${kind}_${hash.slice(0, 40)}`;
}
