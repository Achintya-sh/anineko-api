import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { AniNekoScraper } from '../../services/anineko';
import cache from '../../utils/cache';
import { redis } from '../../main';
import { Redis } from 'ioredis';
import axios from 'axios';
import { resolveMiruroStream } from '../../services/miruro';

interface ChainItem {
  id: number;
  title: string;
  format: string;
}

const mediaCache = new Map<number, any>();

async function queryAniListMedia(id: number): Promise<any> {
  if (mediaCache.has(id)) {
    return mediaCache.get(id);
  }
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        format
        title { romaji english native }
        relations {
          edges {
            relationType
            node {
              id
              type
              format
              title { romaji english native }
            }
          }
        }
      }
    }
  `;
  try {
    const { data } = await axios.post('https://graphql.anilist.co', { query, variables: { id } }, { timeout: 8000 });
    const media = data?.data?.Media;
    if (media) {
      mediaCache.set(id, media);
    }
    return media;
  } catch (e: any) {
    console.error(`[AniNeko] AniList GQL query failed for ID ${id}: ${e.message}`);
    return null;
  }
}

async function findFirstSeason(startId: number): Promise<number> {
  let currentId = startId;
  const visited = new Set<number>();
  
  while (currentId) {
    visited.add(currentId);
    const media = await queryAniListMedia(currentId);
    if (!media) break;
    
    let prequelEdge = media.relations.edges.find((edge: any) => 
      edge.relationType === 'PREQUEL' && 
      edge.node.type === 'ANIME' && 
      edge.node.format === 'TV'
    );
    
    if (!prequelEdge) {
      prequelEdge = media.relations.edges.find((edge: any) => 
        edge.relationType === 'PREQUEL' && 
        edge.node.type === 'ANIME' && 
        (edge.node.format === 'OVA' || edge.node.format === 'MOVIE')
      );
    }
    
    if (prequelEdge && !visited.has(prequelEdge.node.id)) {
      currentId = prequelEdge.node.id;
    } else {
      break;
    }
  }
  return currentId;
}

async function buildChain(startId: number): Promise<ChainItem[]> {
  const firstId = await findFirstSeason(startId);
  const chain: ChainItem[] = [];
  let currentId = firstId;
  const visited = new Set<number>();

  while (currentId) {
    visited.add(currentId);
    const media = await queryAniListMedia(currentId);
    if (!media) break;
    
    chain.push({
      id: media.id,
      title: media.title.english || media.title.romaji || media.title.native,
      format: media.format
    });

    const sequelEdges = media.relations.edges.filter((edge: any) => 
      edge.relationType === 'SEQUEL' && 
      edge.node.type === 'ANIME'
    );

    if (sequelEdges.length === 0) break;

    let nextEdge = sequelEdges.find((edge: any) => edge.node.format === 'TV');
    if (!nextEdge) {
      nextEdge = sequelEdges.find((edge: any) => edge.node.format === 'OVA' || edge.node.format === 'MOVIE');
    }

    if (nextEdge && !visited.has(nextEdge.node.id)) {
      currentId = nextEdge.node.id;
    } else {
      break;
    }
  }
  return chain;
}

function getBestSlug(results: any[], targetTitle: string): string | null {
  if (!results || results.length === 0) return null;
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanTarget = clean(targetTitle);

  let match = results.find(r => clean(r.id) === cleanTarget || clean(r.title) === cleanTarget);
  if (match) return match.id;

  match = results.find(r => clean(r.id).includes(cleanTarget) || clean(r.title).includes(cleanTarget));
  if (match) return match.id;

  return results[0].id;
}

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const anineko = new AniNekoScraper();
  const redisCacheTime = 60 * 60;
  const redisPrefix = 'gogoanime:';

  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro: "Welcome to the custom AniNeko Gogoanime scraper! 🐈",
      routes: [
        '/:query',
        '/info/:id',
        '/watch/:episodeId',
        '/embed'
      ],
    });
  });

  // Search Anime
  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.params as { query: string }).query;
    try {
      const results = redis
        ? await cache.fetch(
            redis as Redis,
            `${redisPrefix}search;${query}`,
            async () => await anineko.search(query),
            redisCacheTime,
          )
        : await anineko.search(query);

      reply.status(200).send({
        currentPage: 1,
        hasNextPage: false,
        results
      });
    } catch (err: any) {
      reply.status(500).send({ message: err.message });
    }
  });

  // Get Info & Episode list
  fastify.get('/info/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = decodeURIComponent((request.params as { id: string }).id);
    try {
      const info = redis
        ? await cache.fetch(
            redis as Redis,
            `${redisPrefix}info;${id}`,
            async () => await anineko.fetchAnimeInfo(id),
            redisCacheTime,
          )
        : await anineko.fetchAnimeInfo(id);

      if (!info) {
        return reply.status(404).send({ message: 'Anime not found' });
      }

      reply.status(200).send(info);
    } catch (err: any) {
      reply.status(500).send({ message: err.message });
    }
  });

  // Get Episode Stream Sources (with Sub/Dub selection)
  fastify.get(
    '/watch/:episodeId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const episodeId = (request.params as { episodeId: string }).episodeId;
      const isDub = (request.query as { dub?: string }).dub === 'true';

      try {
        const allSources = redis
          ? await cache.fetch(
              redis as Redis,
              `${redisPrefix}watch-raw;${episodeId}`,
              async () => await anineko.fetchEpisodeSources(episodeId),
              redisCacheTime,
          )
          : await anineko.fetchEpisodeSources(episodeId);

        let filtered = allSources.filter(s => s.isDub === isDub);
        if (filtered.length === 0) {
          filtered = allSources;
        }

        const sources = filtered.map(s => ({
          url: s.url,
          quality: s.server,
          isM3U8: s.url.includes('.m3u8')
        }));

        reply.status(200).send({ sources });
      } catch (err: any) {
        reply.status(500).send({ message: err.message });
      }
    },
  );

  // Embed route — powered by Miruro's secure pipe API (replaces broken AniNeko scraper)
  fastify.get('/embed', async (request: FastifyRequest, reply: FastifyReply) => {
    const anilistId = (request.query as { anilistId?: string }).anilistId;
    const title = (request.query as { title?: string }).title;
    const episode = (request.query as { episode?: string }).episode || '1';
    const isDub = (request.query as { dub?: string }).dub === 'true';

    if (!anilistId) {
      return reply.status(400).type('text/html').send(errorHtml('Missing anilistId parameter.'));
    }

    const parsedId = parseInt(anilistId, 10);
    const epNum = parseInt(episode, 10);
    const displayTitle = title ? decodeURIComponent(title) : `Anime #${anilistId}`;

    console.log(`\n[Embed/Miruro] AniList=${anilistId} EP=${epNum} Dub=${isDub} Title="${displayTitle}"`);

    try {
      const rawSources = await resolveMiruroStream(parsedId, epNum, isDub);

      if (rawSources.length === 0) {
        return reply.status(404).type('text/html').send(errorHtml('No video sources found.'));
      }

      // Rewrite CDN URLs that require special Referer headers through our proxy
      const proto = (request.headers['x-forwarded-proto'] as string || request.protocol).split(',')[0].trim();
      const proxyBase = `${proto}://${request.hostname}/anime/gogoanime`;
      const sources = rawSources.map(s => ({
        ...s,
        url: needsProxy(s.url)
          ? `${proxyBase}/proxy?url=${encodeURIComponent(s.url)}`
          : s.url,
      }));

      return reply.type('text/html').send(playerHtml(sources, displayTitle, epNum, isDub));
    } catch (err: any) {
      console.error(`[Embed/Miruro] Error: ${err.message}`);
      return reply.status(500).type('text/html').send(errorHtml(`Could not load stream: ${err.message}`));
    }
  });

  // ── Miruro embed alias (same logic, registered under gogoanime prefix for routing) ──
  fastify.get('/miruro-embed', async (request: FastifyRequest, reply: FastifyReply) => {
    // delegate to the same handler — just re-use the embed logic
    return reply.redirect(302,
      `/anime/gogoanime/embed?${new URLSearchParams(request.query as Record<string, string>).toString()}`);
  });

  // ── Stream proxy — forwards owocdn.top / kwik.cx with correct Referer ──
  fastify.get('/proxy', async (request: FastifyRequest, reply: FastifyReply) => {
    const { url } = request.query as { url?: string };
    if (!url) return reply.status(400).send('Missing url parameter.');

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      };
      if (url.includes('owocdn.top') || url.includes('kwik.cx')) {
        headers['Referer'] = 'https://kwik.cx/';
        headers['Origin'] = 'https://kwik.cx';
      } else if (url.includes('miruro.to') || url.includes('miruro.online')) {
        headers['Referer'] = 'https://www.miruro.to/';
      }

      const response = await axios({
        method: 'get',
        url,
        headers,
        responseType: 'arraybuffer',
        timeout: 20000,
      });

      const contentType = (response.headers['content-type'] || '') as string;
      const proto = (request.headers['x-forwarded-proto'] as string || request.protocol).split(',')[0].trim();
      const proxyBase = `${proto}://${request.hostname}/anime/gogoanime`;

      // Rewrite m3u8 manifests so segment/key URLs also go through proxy
      if (url.includes('.m3u8') || contentType.includes('mpegurl')) {
        const text = Buffer.from(response.data).toString('utf-8');
        const rewritten = text.split('\n').map(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#EXT')) {
            // Rewrite URI= attributes inside tags (e.g. #EXT-X-KEY:URI="...")
            return line.replace(/URI="([^"]+)"/g, (_, uri) => {
              const abs = toAbsolute(uri, url);
              return `URI="${proxyBase}/proxy?url=${encodeURIComponent(abs)}"`;
            });
          }
          // Rewrite bare segment lines
          const abs = toAbsolute(trimmed, url);
          return `${proxyBase}/proxy?url=${encodeURIComponent(abs)}`;
        }).join('\n');

        reply.header('Content-Type', 'application/vnd.apple.mpegurl');
        reply.header('Access-Control-Allow-Origin', '*');
        return reply.send(rewritten);
      }

      reply.header('Content-Type', contentType);
      reply.header('Access-Control-Allow-Origin', '*');
      if (response.headers['content-length']) reply.header('Content-Length', response.headers['content-length']);
      return reply.send(response.data);
    } catch (err: any) {
      console.error(`[Proxy] Error for "${url}": ${err.message}`);
      return reply.status(502).send(`Proxy error: ${err.message}`);
    }
  });
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function needsProxy(url: string): boolean {
  return url.includes('owocdn.top') || url.includes('kwik.cx');
}

function toAbsolute(path: string, base: string): string {
  if (path.startsWith('http')) return path;
  try { return new URL(path, base).toString(); } catch { return path; }
}

// ─── HTML Player Page ────────────────────────────────────────────────────────
function playerHtml(sources: Array<{ url: string; quality: string; isM3U8: boolean }>, title: string, episode: number, isDub: boolean): string {
  const preferred = sources.find(s => s.quality === '1080p')
    || sources.find(s => s.quality === '720p')
    || sources.find(s => s.quality === 'default')
    || sources[0];

  const qualityButtons = sources
    .filter(s => s.url)
    .map(s => {
      const active = s.url === preferred.url ? 'active' : '';
      return `<button class="q-btn ${active}" data-url="${s.url}" data-m3u8="${!!s.isM3U8}">${s.quality}</button>`;
    }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Ep ${episode}${isDub ? ' [DUB]' : ' [SUB]'}</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
    #wrap { position: relative; width: 100%; height: 100vh; }
    video { width: 100%; height: 100%; background: #000; display: block; }
    #qbar {
      position: absolute; top: 10px; right: 10px; z-index: 20;
      display: flex; gap: 5px; flex-wrap: wrap;
      background: rgba(0,0,0,0.7); padding: 5px 10px; border-radius: 6px;
    }
    .q-btn {
      background: transparent; color: #999; border: 1px solid #444;
      padding: 3px 9px; font: 700 11px/1 monospace; cursor: pointer;
      border-radius: 3px; text-transform: uppercase; transition: all .15s;
    }
    .q-btn:hover { border-color: #ff6b00; color: #ff6b00; }
    .q-btn.active { background: #ff6b00; color: #000; border-color: #ff6b00; }
    #err {
      display: none; position: absolute; inset: 0;
      background: rgba(0,0,0,.85); color: #f44; font: 13px/1.5 monospace;
      align-items: center; justify-content: center; text-align: center;
      padding: 20px;
    }
    #err.show { display: flex; }
  </style>
</head>
<body>
  <div id="wrap">
    <video id="v" controls playsinline></video>
    ${sources.length > 1 ? `<div id="qbar">${qualityButtons}</div>` : ''}
    <div id="err">⚠ Stream failed.<br>Try another quality or server.</div>
  </div>
  <script>
    const vid = document.getElementById('v');
    const err = document.getElementById('err');
    let hls = null;

    function load(url, isM3U8) {
      err.classList.remove('show');
      if (hls) { hls.destroy(); hls = null; }
      if (isM3U8) {
        if (Hls.isSupported()) {
          hls = new Hls({ enableWorker: true });
          hls.loadSource(url);
          hls.attachMedia(vid);
          hls.on(Hls.Events.MANIFEST_PARSED, () => vid.play().catch(() => {}));
          hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) err.classList.add('show'); });
        } else if (vid.canPlayType('application/vnd.apple.mpegurl')) {
          vid.src = url; vid.play().catch(() => {});
        } else { err.classList.add('show'); }
      } else {
        vid.src = url; vid.play().catch(() => {});
      }
    }

    load(${JSON.stringify(preferred.url)}, ${!!preferred.isM3U8});

    document.querySelectorAll('.q-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.q-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        load(b.dataset.url, b.dataset.m3u8 === 'true');
      });
    });
  </script>
</body>
</html>`;
}

// ─── HTML Error Page ─────────────────────────────────────────────────────────
function errorHtml(msg: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Stream Error</title>
  <style>
    body { background:#0a0a0a; color:#f44; font:13px/1.6 monospace;
      display:flex; align-items:center; justify-content:center;
      min-height:100vh; padding:20px; text-align:center; }
    .box { border:2px solid #f44; padding:30px 40px; max-width:480px; }
    h2 { font-size:13px; letter-spacing:3px; margin-bottom:14px; text-transform:uppercase; }
    p { color:#777; font-size:12px; }
  </style>
</head>
<body>
  <div class="box">
    <h2>⚠ Stream Error</h2>
    <p>${msg}</p>
    <p style="margin-top:12px;color:#444;">Switch to a different server in the player.</p>
  </div>
</body>
</html>`;
}

export default routes;