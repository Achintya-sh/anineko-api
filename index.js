/**
 * AniNeko Scraper API
 * -------------------
 * A standalone Express server that directly scrapes AniNeko for anime
 * stream sources.
 *
 * Stack: express, axios, cheerio, node:crypto (built-in)
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// Load environment variables from project root env files if present
function loadEnv() {
  const envPaths = [
    path.join(__dirname, '../.env'),
    path.join(__dirname, '../.env.production')
  ];
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      content.split('\n').forEach(line => {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?$/);
        if (match) {
          const key = match[1];
          let value = (match[2] || '').trim();
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.substring(1, value.length - 1);
          } else if (value.startsWith("'") && value.endsWith("'")) {
            value = value.substring(1, value.length - 1);
          }
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      });
    }
  }
}
loadEnv();

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── AniNeko base URL ────────────────────────────────────────────────────────
const GOGO_BASE = 'https://anineko.to';

// ─── AniList GraphQL ─────────────────────────────────────────────────────────
const ANILIST_GQL = 'https://graphql.anilist.co';

// ─── Shared axios instance ────────────────────────────────────────────────────
const http = axios.create({
  timeout: 12000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': GOGO_BASE,
  },
});

// Cache for AniList requests to prevent rate limits
const mediaCache = new Map();

async function queryAniListMedia(id, retries = 2) {
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
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await axios.post(ANILIST_GQL, { query, variables: { id: Number(id) } }, { timeout: 8000 });
      const media = data?.data?.Media;
      if (media) {
        mediaCache.set(id, media);
        return media;
      }
    } catch (e) {
      if (i === retries) {
        console.error(`[AniNeko] AniList GQL query failed for ID ${id} after ${retries} retries: ${e.message}`);
        throw new Error(`AniList GQL query failed for ID ${id}: ${e.message}`);
      }
      console.warn(`[AniNeko] AniList query failed for ID ${id} (try ${i + 1}/${retries + 1}), retrying in 1s...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Traverse backwards to find the first season/ prequel
async function findFirstSeason(startId) {
  let currentId = startId;
  const visited = new Set();
  
  while (currentId) {
    visited.add(currentId);
    const media = await queryAniListMedia(currentId);
    if (!media) break;
    
    // Prioritize TV prequel
    let prequelEdge = media.relations.edges.find(edge => 
      edge.relationType === 'PREQUEL' && 
      edge.node.type === 'ANIME' && 
      edge.node.format === 'TV'
    );
    
    if (!prequelEdge) {
      prequelEdge = media.relations.edges.find(edge => 
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

// Build forward sequel chain prioritizing TV series
async function buildChain(startId) {
  const firstId = await findFirstSeason(startId);
  const chain = [];
  let currentId = firstId;
  const visited = new Set();

  while (currentId) {
    visited.add(currentId);
    const media = await queryAniListMedia(currentId);
    if (!media) break;
    
    chain.push({
      id: media.id,
      title: media.title.english || media.title.romaji || media.title.native,
      format: media.format
    });

    const sequelEdges = media.relations.edges.filter(edge => 
      edge.relationType === 'SEQUEL' && 
      edge.node.type === 'ANIME'
    );

    if (sequelEdges.length === 0) break;

    // Prioritize TV formats
    let nextEdge = sequelEdges.find(edge => edge.node.format === 'TV');
    if (!nextEdge) {
      nextEdge = sequelEdges.find(edge => edge.node.format === 'OVA' || edge.node.format === 'MOVIE');
    }

    if (nextEdge && !visited.has(nextEdge.node.id)) {
      currentId = nextEdge.node.id;
    } else {
      break;
    }
  }
  return chain;
}

// Search AniNeko for matching anime slugs
async function searchAniNeko(title, retries = 2) {
  const query = encodeURIComponent(title);
  const url = `${GOGO_BASE}/browser?keyword=${query}`;
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await http.get(url);
      const $ = cheerio.load(data);
      const results = [];
      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const name = $(el).text().trim();
        if (href.startsWith('/watch/')) {
          const slug = href.replace('/watch/', '').trim();
          if (!slug.includes('/ep-') && !results.some(r => r.slug === slug)) {
            results.push({ slug, name: name.replace(/\s+/g, ' ') });
          }
        }
      });
      return results;
    } catch (e) {
      if (i === retries) {
        console.error(`[AniNeko] Search failed for "${title}" after ${retries} retries: ${e.message}`);
        throw new Error(`Search failed for "${title}": ${e.message}`);
      }
      console.warn(`[AniNeko] Search failed for "${title}" (try ${i + 1}/${retries + 1}), retrying in 1s...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Get the number of episodes available on the watch page of a slug
async function getEpisodeCount(slug, retries = 2) {
  const url = `${GOGO_BASE}/watch/${slug}`;
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await http.get(url);
      const $ = cheerio.load(data);
      const count = $('.nv-info-episode-actions').length;
      if (count === 0) {
        throw new Error('No episode elements found on watch page');
      }
      return count;
    } catch (e) {
      if (i === retries) {
        console.error(`[AniNeko] getEpisodeCount failed for ${slug} after ${retries} retries: ${e.message}`);
        throw new Error(`Failed to get episode count for ${slug}: ${e.message}`);
      }
      console.warn(`[AniNeko] getEpisodeCount failed for ${slug} (try ${i + 1}/${retries + 1}), retrying in 1s...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Simple text distance matching to find the best slug
function getBestSlug(results, targetTitle) {
  if (!results || results.length === 0) return null;
  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanTarget = clean(targetTitle);

  let match = results.find(r => clean(r.slug) === cleanTarget || clean(r.name) === cleanTarget);
  if (match) return match.slug;

  match = results.find(r => clean(r.slug).includes(cleanTarget) || clean(r.name).includes(cleanTarget));
  if (match) return match.slug;

  return results[0].slug;
}

// Extract direct stream sources (m3u8) from vibeplayer or bibiemb
async function getStreamSources(slug, episodeNumber, isDub) {
  const url = `${GOGO_BASE}/watch/${slug}/ep-${episodeNumber}`;
  const { data } = await http.get(url);
  const $ = cheerio.load(data);

  const langGroupId = isDub ? 'dub' : 'sub';
  const container = $(`.lang-group[data-id="${langGroupId}"]`);
  
  if (container.length === 0) {
    throw new Error(`Could not find language container for ${langGroupId}`);
  }

  const sources = [];
  const buttons = container.find('.server-video');

  for (let i = 0; i < buttons.length; i++) {
    const btn = $(buttons[i]);
    const embedUrl = btn.attr('data-video');
    const label = btn.text().replace(/\s+/g, ' ').trim().replace(/(Sort Sub|DUB)/gi, '').trim();

    if (!embedUrl) continue;

    // Extract HLS stream from vibeplayer or bibiemb
    if (embedUrl.includes('vivibebe.site') || embedUrl.includes('vibeplayer.site') || embedUrl.includes('bibiemb.xyz') || embedUrl.includes('vibevibe.workers.dev')) {
      try {
        const { data: playerHtml } = await http.get(embedUrl);
        const match = playerHtml.match(/const\s+src\s*=\s*["'](https?:\/\/[^"']+)["']/);
        if (match && match[1]) {
          sources.push({
            url: match[1],
            quality: label,
            isM3U8: match[1].includes('.m3u8')
          });
        }
      } catch (e) {
        console.error(`[AniNeko] Error extracting from ${label}: ${e.message}`);
      }
    }
  }

  return sources;
}

// ────────────────────────────────────────────────────────────────────────────
// MASTER RESOLVER — chains steps to resolve the correct slug and episodes
// ────────────────────────────────────────────────────────────────────────────
async function resolveAnimeStream(anilistId, absoluteEpisode, isDub, fallbackTitle) {
  console.log(`[AniNeko] Starting resolution for AniList ID: ${anilistId}, Episode: ${absoluteEpisode}, Dub: ${isDub}`);
  
  const chain = await buildChain(anilistId);
  if (chain.length === 0) {
    throw new Error(`Could not resolve anime chain for AniList ID ${anilistId}`);
  }

  console.log(`[AniNeko] Resolved sequel chain of length ${chain.length}`);

  let accumulated = 0;
  let resolvedSlug = null;
  let resolvedEp = absoluteEpisode;

  for (const item of chain) {
    if (item.format !== 'TV' && chain.some(c => c.format === 'TV')) {
      continue;
    }

    const results = await searchAniNeko(item.title);
    const slug = getBestSlug(results, item.title);
    
    if (!slug) {
      console.warn(`[AniNeko] Could not find slug for title: "${item.title}"`);
      continue;
    }

    const count = await getEpisodeCount(slug);
    console.log(`[AniNeko] Checked slug: ${slug} (${count} episodes)`);

    if (absoluteEpisode <= accumulated + count) {
      resolvedSlug = slug;
      resolvedEp = absoluteEpisode - accumulated;
      break;
    }
    accumulated += count;
  }

  // Fallback to last resolved slug if out of range
  if (!resolvedSlug && chain.length > 0) {
    const lastItem = chain[chain.length - 1];
    const results = await searchAniNeko(lastItem.title);
    resolvedSlug = getBestSlug(results, lastItem.title);
    resolvedEp = absoluteEpisode - accumulated;
  }

  if (!resolvedSlug) {
    throw new Error(`Failed to resolve anime stream for ID ${anilistId}`);
  }

  console.log(`[AniNeko] Final mapped destination: slug "${resolvedSlug}" Episode ${resolvedEp}`);

  // Fetch final sources
  const sources = await getStreamSources(resolvedSlug, resolvedEp, isDub);
  if (sources.length === 0) {
    throw new Error(`No HLS streaming sources could be extracted for ${resolvedSlug} Ep ${resolvedEp}`);
  }

  return sources;
}

// ────────────────────────────────────────────────────────────────────────────
// API Route: GET /anime/gogoanime/embed
// ────────────────────────────────────────────────────────────────────────────
app.get('/anime/gogoanime/embed', async (req, res) => {
  const { anilistId, episode, dub, title } = req.query;

  if (!anilistId || !episode) {
    return res.status(400).send(errorPage('Missing anilistId or episode parameter.'));
  }

  const isDub      = dub === 'true';
  const epNum      = parseInt(episode, 10);
  const rawTitle   = title ? decodeURIComponent(title) : '';
  const displayTitle = rawTitle || `Anime #${anilistId}`;

  console.log(`\n[AniNeko] ── NEW REQUEST ──────────────────────────────`);
  console.log(`[AniNeko] AniList=${anilistId} EP=${epNum} Dub=${isDub} Title="${rawTitle}"`);

  try {
    const sources = await resolveAnimeStream(anilistId, epNum, isDub, rawTitle);
    const baseProxyUrl = `${req.protocol}://${req.get('host')}/anime/proxy?url=`;
    const proxiedSources = sources.map(s => ({
      ...s,
      url: `${baseProxyUrl}${encodeURIComponent(s.url)}`
    }));
    res.send(playerPage(proxiedSources, displayTitle, epNum, isDub));
  } catch (err) {
    console.error(`[AniNeko] ✗ ${err.message}`);
    res.status(500).send(errorPage(`Could not load stream: ${err.message}`));
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'AniNeko Scraper API', version: '2.5.0', engine: 'direct-anineko' });
});

// ─── TMDB Proxy Endpoints ────────────────────────────────────────────────────
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// Check if TMDB credentials are set on the backend
app.get('/api/tmdb/config-check', (req, res) => {
  const token = process.env.TMDB_ACCESS_TOKEN || process.env.VITE_TMDB_ACCESS_TOKEN;
  const apiKey = process.env.TMDB_API_KEY || process.env.VITE_TMDB_API_KEY;
  const configured = !!((token && token !== 'your_token_here') || (apiKey && apiKey !== 'your_key_here'));
  res.json({ configured });
});

// Proxy GET requests to the TMDB API
app.get('/api/tmdb/*', async (req, res) => {
  const subPath = req.params[0];
  const targetUrl = `${TMDB_BASE_URL}/${subPath}`;

  const token = process.env.TMDB_ACCESS_TOKEN || process.env.VITE_TMDB_ACCESS_TOKEN;
  const apiKey = process.env.TMDB_API_KEY || process.env.VITE_TMDB_API_KEY;

  const headers = {
    accept: 'application/json'
  };
  const params = { ...req.query };

  if (token && token !== 'your_token_here') {
    headers.Authorization = `Bearer ${token}`;
  } else if (apiKey && apiKey !== 'your_key_here') {
    params.api_key = apiKey;
  }

  try {
    const response = await axios.get(targetUrl, { headers, params, timeout: 15000 });
    res.json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    const errorMsg = error.response?.data || error.message;
    console.error(`[TMDB Proxy] Error fetching ${subPath}:`, errorMsg);
    res.status(status).json({ 
      error: true, 
      message: typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg) 
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// HTML Player Page
// ────────────────────────────────────────────────────────────────────────────
function playerPage(sources, title, episode, isDub) {
  const preferred = sources.find(s => s.quality === '1080p')
    || sources.find(s => s.quality === '720p')
    || sources.find(s => s.quality === 'default')
    || sources[0];

  const qualityButtons = sources
    .filter(s => s.url)
    .map((s, i) => {
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

// ────────────────────────────────────────────────────────────────────────────
// HTML Error Page
// ────────────────────────────────────────────────────────────────────────────
function errorPage(msg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AniNeko Error</title>
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
    <h2>⚠ AniNeko Error</h2>
    <p>${msg}</p>
    <p style="margin-top:12px;color:#444;">Switch to a different server in the player.</p>
  </div>
</head>
</html>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Miruro Scraper Implementation
// ────────────────────────────────────────────────────────────────────────────
const MIRURO_BASE = 'https://www.miruro.to';
const MIRURO_PIPE_URL = `${MIRURO_BASE}/api/secure/pipe`;

function encodePipeRequest(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url').replace(/=+$/, '');
}

function decodePipeResponse(encodedStr) {
  let padded = encodedStr.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4) padded += '=';
  const compressed = Buffer.from(padded, 'base64');
  const decompressed = require('zlib').gunzipSync(compressed);
  return JSON.parse(decompressed.toString('utf-8'));
}

async function httpGetWithRetry(url, config, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await http.get(url, config);
    } catch (err) {
      if (i === retries) throw err;
      console.warn(`[Miruro] request failed (${err.message}), retrying (${i + 1}/${retries})...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function resolveMiruroStream(anilistId, epNum, isDub) {
  console.log(`[Miruro] Starting stream resolution for AniList ID: ${anilistId}, Episode: ${epNum}, Dub: ${isDub}`);
  
  const payload = {
    path: "episodes",
    method: "GET",
    query: { anilistId: Number(anilistId) },
    body: null,
    version: "0.1.0",
  };
  
  const encoded = encodePipeRequest(payload);
  const url = `${MIRURO_PIPE_URL}?e=${encoded}`;
  
  const { data: rawResponse } = await httpGetWithRetry(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': `${MIRURO_BASE}/`
    }
  });
  
  const episodesData = decodePipeResponse(rawResponse.trim());
  const category = isDub ? 'dub' : 'sub';
  
  const providersOrder = ['kiwi', 'moo', 'hop'];
  let targetEpisode = null;
  let selectedProvider = null;
  
  for (const prov of providersOrder) {
    const provData = episodesData.providers?.[prov];
    if (!provData) continue;
    const eps = provData.episodes?.[category] || (Array.isArray(provData.episodes) ? provData.episodes : null);
    if (!eps) continue;
    
    const match = eps.find(e => e.number === epNum);
    if (match) {
      targetEpisode = match;
      selectedProvider = prov;
      break;
    }
  }
  
  if (!targetEpisode && episodesData.providers) {
    for (const [prov, provData] of Object.entries(episodesData.providers)) {
      if (!provData) continue;
      const eps = provData.episodes?.[category] || (Array.isArray(provData.episodes) ? provData.episodes : null);
      if (!eps) continue;
      const match = eps.find(e => e.number === epNum);
      if (match) {
        targetEpisode = match;
        selectedProvider = prov;
        break;
      }
    }
  }
  
  if (!targetEpisode) {
    throw new Error(`Episode ${epNum} (${category}) not found on Miruro for AniList ID ${anilistId}`);
  }
  
  console.log(`[Miruro] Resolved episode to provider: ${selectedProvider}, original ID: ${targetEpisode.id}`);
  
  const encEpisodeId = targetEpisode.id;
  
  const sourcesPayload = {
    path: "sources",
    method: "GET",
    query: {
      episodeId: encEpisodeId,
      provider: selectedProvider,
      category: category,
      anilistId: Number(anilistId),
    },
    body: null,
    version: "0.1.0"
  };
  
  const sourcesUrl = `${MIRURO_PIPE_URL}?e=${encodePipeRequest(sourcesPayload)}`;
  const { data: rawSourcesResponse } = await httpGetWithRetry(sourcesUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': `${MIRURO_BASE}/`
    }
  });
  
  const sourcesData = decodePipeResponse(rawSourcesResponse.trim());
  if (!sourcesData.streams || sourcesData.streams.length === 0) {
    throw new Error(`No streams returned for episode ${epNum} from provider ${selectedProvider}`);
  }
  
  return sourcesData.streams.map(s => {
    const isM3U8 = s.type === 'hls' || s.url.includes('.m3u8');
    return {
      url: s.url,
      quality: s.quality || 'default',
      isM3U8: isM3U8
    };
  });
}

// API Route: GET /anime/proxy
app.get('/anime/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url parameter.');

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
    if (url.includes('owocdn.top') || url.includes('kwik.cx')) {
      headers['Referer'] = 'https://kwik.cx/';
      headers['Origin'] = 'https://kwik.cx';
    }

    const response = await axios({
      method: 'get',
      url: url,
      headers: headers,
      responseType: 'arraybuffer',
      timeout: 15000
    });

    const contentType = response.headers['content-type'] || '';
    const baseProxyUrl = `${req.protocol}://${req.get('host')}/anime/proxy?url=`;

    if (url.includes('.m3u8') || contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('audio/x-mpegurl')) {
      let content = response.data.toString('utf-8');
      const lines = content.split('\n');
      const rewrittenLines = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        
        if (trimmed.startsWith('#')) {
          const uriMatch = trimmed.match(/URI=["']([^"']+)["']/);
          if (uriMatch && uriMatch[1]) {
            const absoluteUrl = new URL(uriMatch[1], url).toString();
            const proxiedUrl = `${baseProxyUrl}${encodeURIComponent(absoluteUrl)}`;
            return trimmed.replace(uriMatch[1], proxiedUrl);
          }
          return line;
        }

        const absoluteUrl = new URL(trimmed, url).toString();
        // Optimize: CDN-hosted video segments (.ts) that support CORS don't need proxying
        if (absoluteUrl.includes('ibyteimg.com') || absoluteUrl.includes('byteimg')) {
          return absoluteUrl;
        }
        return `${baseProxyUrl}${encodeURIComponent(absoluteUrl)}`;
      });
      
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewrittenLines.join('\n'));
    }

    res.setHeader('Content-Type', contentType);
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }
    if (response.headers['cache-control']) {
      res.setHeader('Cache-Control', response.headers['cache-control']);
    }
    
    res.send(response.data);
  } catch (err) {
    console.error(`[Proxy] Error for URL "${url}": ${err.message}`);
    res.status(500).send(`Proxy error: ${err.message}`);
  }
});

// API Route: GET /anime/miruro/embed
app.get('/anime/miruro/embed', async (req, res) => {
  const { anilistId, episode, dub, title } = req.query;

  if (!anilistId || !episode) {
    return res.status(400).send(errorPage('Missing anilistId or episode parameter.'));
  }

  const isDub      = dub === 'true';
  const epNum      = parseInt(episode, 10);
  const rawTitle   = title ? decodeURIComponent(title) : '';
  const displayTitle = rawTitle || `Anime #${anilistId}`;

  console.log(`\n[Miruro] ── NEW REQUEST ──────────────────────────────`);
  console.log(`[Miruro] AniList=${anilistId} EP=${epNum} Dub=${isDub} Title="${rawTitle}"`);

  try {
    const sources = await resolveMiruroStream(anilistId, epNum, isDub);
    const baseProxyUrl = `${req.protocol}://${req.get('host')}/anime/proxy?url=`;
    const proxiedSources = sources.map(s => ({
      ...s,
      url: `${baseProxyUrl}${encodeURIComponent(s.url)}`
    }));
    res.send(playerPage(proxiedSources, displayTitle, epNum, isDub));
  } catch (err) {
    console.error(`[Miruro] ✗ ${err.message}`);
    console.log(`[Miruro] ➜ Redirecting fallback to AniNeko (Gogoanime) embed`);
    res.redirect(`/anime/gogoanime/embed?anilistId=${anilistId}&episode=${episode}&dub=${dub}&title=${title || ''}`);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[AniNeko] Server on port ${PORT} (engine: direct-anineko)`));

