const MUSIC_ASSISTANT_PROVIDER_DEFAULT = 'spotify@musicassistant';
let musicAssistantProviderId = MUSIC_ASSISTANT_PROVIDER_DEFAULT;

export function setMusicAssistantProviderId(providerId?: string): void {
  const normalized =
    typeof providerId === 'string' && providerId.trim()
      ? providerId.trim()
      : MUSIC_ASSISTANT_PROVIDER_DEFAULT;
  musicAssistantProviderId = normalized;
}

export function getMusicAssistantProviderId(): string {
  return musicAssistantProviderId;
}

export function getMusicAssistantUserId(): string {
  const provider = getMusicAssistantProviderId().trim();
  if (provider.toLowerCase().startsWith('spotify@')) {
    const user = provider.slice('spotify@'.length);
    return user || 'musicassistant';
  }
  return provider || 'musicassistant';
}

export { MUSIC_ASSISTANT_PROVIDER_DEFAULT };
