const BASE_URL = 'https://opml.radiotime.com';

type TuneInResponse = {
  head?: {
    status?: number | string;
    fault?: string;
    title?: string;
  };
  body?: unknown[];
};

/** One Browse.ashx answer: the outlines plus the title TuneIn put in the head. */
export type TuneInBrowseResult = {
  /**
   * Present only when TuneIn recognises the request — for presets it reads
   * "<name>'s Favorites". A username TuneIn has never seen still answers HTTP 200
   * with `status: 200` and an empty body, so this title is the only thing that
   * tells "no such user" apart from "user with no presets".
   */
  title?: string;
  outlines: unknown[];
};

export class TuneInClient {
  private async request(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<TuneInBrowseResult> {
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
        'User-Agent': 'sonn-core/1.0 (+https://github.com/sonn-audio/core)',
        'Accept-Language': 'nl-NL,nl;q=0.9,*;q=0.5',
      },
      signal: AbortSignal.timeout(10_000),
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

    const title = typeof json.head.title === 'string' ? json.head.title : undefined;
    return { title, outlines: json.body };
  }

  public browsePresets(username: string): Promise<TuneInBrowseResult> {
    return this.request('/Browse.ashx', { c: 'presets', username });
  }

  /**
   * Contents of one favourites folder. TuneIn lets an account file its presets in
   * folders ("General", a country, ...), which the preset listing returns as links
   * to another Browse rather than as stations.
   */
  public browseFolder(id: string, username?: string): Promise<TuneInBrowseResult> {
    return this.request('/Browse.ashx', { id, username });
  }

  public async tune(id: string): Promise<unknown[]> {
    return (await this.request('/Tune.ashx', { id })).outlines;
  }

  public async search(query: string, username?: string): Promise<unknown[]> {
    return (await this.request('/Search.ashx', { query, username })).outlines;
  }
}
