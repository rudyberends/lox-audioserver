import { createLogger } from '@/shared/logging/logger';

const log = createLogger('Content', 'YoutubeApi');

export type YoutubeVideoEntry = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnail: string;
};

export type YoutubePlaylistEntry = {
  playlistId: string;
  title: string;
  thumbnail: string;
  itemCount?: number;
};

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

export class YoutubeApiClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  public async search(query: string, maxResults = 20): Promise<YoutubeVideoEntry[]> {
    const url = new URL(`${YT_API_BASE}/search`);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('q', query);
    url.searchParams.set('maxResults', String(maxResults));
    const data = await this.apiFetch(url);
    return (data?.items ?? [])
      .map((item: any) => ({
        videoId: String(item?.id?.videoId ?? ''),
        title: String(item?.snippet?.title ?? ''),
        channelTitle: String(item?.snippet?.channelTitle ?? ''),
        thumbnail: pickThumb(item?.snippet?.thumbnails),
      }))
      .filter((v: YoutubeVideoEntry) => v.videoId && v.title);
  }

  public async getPlaylistItems(playlistId: string, maxResults = 50): Promise<YoutubeVideoEntry[]> {
    const url = new URL(`${YT_API_BASE}/playlistItems`);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('playlistId', playlistId);
    url.searchParams.set('maxResults', String(maxResults));
    const data = await this.apiFetch(url);
    return (data?.items ?? [])
      .map((item: any) => ({
        videoId: String(item?.snippet?.resourceId?.videoId ?? ''),
        title: String(item?.snippet?.title ?? ''),
        channelTitle: String(item?.snippet?.videoOwnerChannelTitle ?? item?.snippet?.channelTitle ?? ''),
        thumbnail: pickThumb(item?.snippet?.thumbnails),
      }))
      .filter(
        (v: YoutubeVideoEntry) => v.videoId && v.title && v.title !== 'Deleted video' && v.title !== 'Private video',
      );
  }

  public async getTrendingMusic(maxResults = 20): Promise<YoutubeVideoEntry[]> {
    const url = new URL(`${YT_API_BASE}/videos`);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('chart', 'mostPopular');
    url.searchParams.set('videoCategoryId', '10');
    url.searchParams.set('maxResults', String(maxResults));
    const data = await this.apiFetch(url);
    return (data?.items ?? [])
      .map((item: any) => ({
        videoId: String(item?.id ?? ''),
        title: String(item?.snippet?.title ?? ''),
        channelTitle: String(item?.snippet?.channelTitle ?? ''),
        thumbnail: pickThumb(item?.snippet?.thumbnails),
      }))
      .filter((v: YoutubeVideoEntry) => v.videoId && v.title);
  }

  private async apiFetch(url: URL): Promise<any> {
    url.searchParams.set('key', this.apiKey);
    try {
      const resp = await fetch(url.toString());
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`YouTube API request failed (${resp.status}): ${text.slice(0, 200)}`);
      }
      return resp.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('youtube api request failed', { message: msg });
      throw err;
    }
  }
}

function pickThumb(thumbnails: any): string {
  if (!thumbnails) return '';
  for (const key of ['maxres', 'high', 'medium', 'default']) {
    const t = thumbnails[key];
    if (typeof t?.url === 'string' && t.url) return t.url;
  }
  return '';
}
