import axios from 'axios';
import * as cheerio from 'cheerio';

export interface IAnimeResult {
  id: string;
  title: string;
  url: string;
  image?: string;
}

export interface IAnimeEpisode {
  id: string;
  title: string;
  url: string;
}

export interface IVideoSource {
  server: string;
  url: string;
  isDub: boolean;
}

export class AniNekoScraper {
  private baseUrl = 'https://anineko.to';
  private userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  private client = axios.create({
    baseURL: this.baseUrl,
    headers: {
      'User-Agent': this.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  });

  public async search(query: string): Promise<IAnimeResult[]> {
    try {
      const res = await this.client.get(`/browser?keyword=${encodeURIComponent(query)}`);
      const $ = cheerio.load(res.data);
      const results: IAnimeResult[] = [];

      $('.nv-anime-title').each((_, el) => {
        const link = $(el).find('a');
        const href = link.attr('href');
        const title = link.text().trim();
        if (href && title) {
          results.push({
            id: href.replace('/watch/', ''),
            title,
            url: this.baseUrl + href
          });
        }
      });

      return results;
    } catch (err: any) {
      console.error(`[AniNekoScraper] Search error for "${query}":`, err.message);
      return [];
    }
  }

  public async fetchAnimeInfo(id: string): Promise<{ id: string; title: string; episodes: IAnimeEpisode[] } | null> {
    try {
      const res = await this.client.get(`/watch/${id}`);
      const $ = cheerio.load(res.data);
      const episodes: IAnimeEpisode[] = [];

      const title = $('title').text().replace('Anime Info - AniNeko', '').trim();

      $('.nv-info-episode-item').each((_, el) => {
        const link = $(el).find('.nv-info-episode-main');
        const href = link.attr('href');
        const epTitle = link.find('strong').text().trim();
        if (href) {
          episodes.push({
            id: href.replace('/watch/', ''),
            title: epTitle,
            url: this.baseUrl + href
          });
        }
      });

      return {
        id,
        title,
        episodes
      };
    } catch (err: any) {
      console.error(`[AniNekoScraper] Info error for "${id}":`, err.message);
      return null;
    }
  }

  public async fetchEpisodeSources(episodeId: string): Promise<IVideoSource[]> {
    try {
      const res = await this.client.get(`/watch/${episodeId}`);
      const $ = cheerio.load(res.data);
      const sources: IVideoSource[] = [];

      $('.nv-server-btn').each((_, el) => {
        const videoUrl = $(el).attr('data-video');
        const serverName = $(el).text().replace(/DUB|SUB|Sort Sub/g, '').trim() || 'Default';
        const isDub = $(el).text().includes('DUB') || ($(el).attr('class') || '').includes('dub');

        if (videoUrl) {
          sources.push({
            server: serverName,
            url: videoUrl,
            isDub
          });
        }
      });

      return sources;
    } catch (err: any) {
      console.error(`[AniNekoScraper] Sources error for "${episodeId}":`, err.message);
      return [];
    }
  }
}
