import logger from '@/utils/troxorLogger';

export function getAvailableServices() {
  logger.debug('[MusicAssistantProviderMapper] Returning available services [Fake Spotify]');
  return [
    {
      cmd: 'spotify',
      config: [
        { name: 'Username', regex: '%2F', type: 'text' },
        { link: 'https://w.c/l', name: 'EULA', type: 'eula' },
      ],
      helplink: 'http://o.c/h',
      icon: 'http://e.k',
      name: 'Spotify',
      registerlink: 'https://w/s',
    },
  ];
}

export function getServices() {
  logger.debug('[MusicAssistantProviderMapper] Returning active services [Fake Spotify]');
  return [
    {
      asdefault: [3],
      cmd: 'spotify',
      configerror: false,
      email: 'nouser@test.com',
      icon: 'https://e',
      id: 'nouser',
      name: 'Spotify',
      offline_storage: [],
      product: 'premium',
      user: 'Music Assistant',
    },
  ];
}