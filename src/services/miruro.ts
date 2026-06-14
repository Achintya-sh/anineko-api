import axios from 'axios';
import { gunzipSync } from 'zlib';

const MIRURO_BASE = 'https://www.miruro.to';
const MIRURO_PIPE_URL = `${MIRURO_BASE}/api/secure/pipe`;

const http = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': `${MIRURO_BASE}/`,
    'Accept': 'text/plain, */*',
  },
});

export interface MiruroSource {
  url: string;
  quality: string;
  isM3U8: boolean;
}

function encodePipeRequest(payload: object): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url').replace(/=+$/, '');
}

function decodePipeResponse(encodedStr: string): any {
  let padded = encodedStr.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4) padded += '=';
  const compressed = Buffer.from(padded, 'base64');
  const decompressed = gunzipSync(compressed);
  return JSON.parse(decompressed.toString('utf-8'));
}

async function httpGetWithRetry(url: string, config: object = {}, retries = 2): Promise<any> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await http.get(url, config);
    } catch (err: any) {
      if (i === retries) throw err;
      console.warn(`[Miruro] request failed (${err.message}), retrying (${i + 1}/${retries})...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

const PROVIDERS_ORDER = ['kiwi', 'moo', 'hop', 'ally', 'pewe', 'bee', 'bonk'];

export async function resolveMiruroStream(
  anilistId: number,
  epNum: number,
  isDub: boolean
): Promise<MiruroSource[]> {
  console.log(`[Miruro] Resolving stream for AniList ID: ${anilistId}, Episode: ${epNum}, Dub: ${isDub}`);

  // Step 1: fetch episode list
  const episodesPayload = {
    path: 'episodes',
    method: 'GET',
    query: { anilistId },
    body: null,
    version: '0.1.0',
  };

  const encoded = encodePipeRequest(episodesPayload);
  const { data: rawResponse } = await httpGetWithRetry(`${MIRURO_PIPE_URL}?e=${encoded}`);
  const episodesData = decodePipeResponse(rawResponse.trim());

  const category = isDub ? 'dub' : 'sub';

  // Find target episode
  let targetEpisode: any = null;
  let selectedProvider: string | null = null;

  for (const prov of PROVIDERS_ORDER) {
    const provData = episodesData.providers?.[prov];
    if (!provData) continue;
    const eps = provData.episodes?.[category] || (Array.isArray(provData.episodes) ? provData.episodes : null);
    if (!eps) continue;
    const match = eps.find((e: any) => e.number === epNum);
    if (match) {
      targetEpisode = match;
      selectedProvider = prov;
      break;
    }
  }

  // Fallback: check all providers
  if (!targetEpisode && episodesData.providers) {
    for (const [prov, provData] of Object.entries(episodesData.providers) as [string, any][]) {
      if (!provData) continue;
      const eps = provData.episodes?.[category] || (Array.isArray(provData.episodes) ? provData.episodes : null);
      if (!eps) continue;
      const match = eps.find((e: any) => e.number === epNum);
      if (match) {
        targetEpisode = match;
        selectedProvider = prov;
        break;
      }
    }
  }

  if (!targetEpisode || !selectedProvider) {
    throw new Error(`Episode ${epNum} (${category}) not found on Miruro for AniList ID ${anilistId}`);
  }

  console.log(`[Miruro] Resolved to provider: ${selectedProvider}, episode ID: ${targetEpisode.id}`);

  // Step 2: fetch sources
  const sourcesPayload = {
    path: 'sources',
    method: 'GET',
    query: {
      episodeId: targetEpisode.id,
      provider: selectedProvider,
      category,
      anilistId,
    },
    body: null,
    version: '0.1.0',
  };

  const sourcesEncoded = encodePipeRequest(sourcesPayload);
  const { data: rawSourcesResponse } = await httpGetWithRetry(`${MIRURO_PIPE_URL}?e=${sourcesEncoded}`);
  const sourcesData = decodePipeResponse(rawSourcesResponse.trim());

  if (!sourcesData.streams || sourcesData.streams.length === 0) {
    throw new Error(`No streams returned for episode ${epNum} from provider ${selectedProvider}`);
  }

  return sourcesData.streams.map((s: any) => ({
    url: s.url,
    quality: s.quality || 'default',
    isM3U8: s.type === 'hls' || (s.url || '').includes('.m3u8'),
  }));
}
