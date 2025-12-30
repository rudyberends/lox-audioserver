const BASE_URL = 'https://opml.radiotime.com';

type TuneInResponse = {
  head?: {
    status?: number | string;
    fault?: string;
  };
  body?: unknown[];
};

export class TuneInClient {
  private async request(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<unknown[]> {
    const url = new URL(path, BASE_URL);
    url.searchParams.set('partnerId', '1');
    url.searchParams.set('formats', 'ogg,aac,wma,mp3,hls');
    url.searchParams.set('render', 'json');

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'lox-audioserver/1.0 (+https://github.com/loxone-audioserver)',
        'Accept-Language': 'nl-NL,nl;q=0.9,*;q=0.5',
      },
    });

    if (!res.ok) {
      throw new Error(`TuneIn request failed: HTTP ${res.status}`);
    }

    const json = (await res.json()) as TuneInResponse;
    if (!json || !json.head || !Array.isArray(json.body)) {
      throw new Error('TuneIn: invalid JSON response');
    }

    const status = Number(json.head.status ?? 0);
    if (status !== 200) {
      throw new Error(`TuneIn error: ${json.head.fault ?? json.head.status}`);
    }

    return json.body;
  }

  public browsePresets(username: string): Promise<unknown[]> {
    return this.request('/Browse.ashx', { c: 'presets', username });
  }

  public tune(id: string): Promise<unknown[]> {
    return this.request('/Tune.ashx', { id });
  }

  public search(query: string, username?: string): Promise<unknown[]> {
    return this.request('/Search.ashx', { query, username });
  }
}
