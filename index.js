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

// Helper to construct dynamic proxy URLs with robust HTTPS enforcement for production
const getBaseProxyUrl = (req) => {
  const host = req.get('host') || '';
  const protocol = (host.includes('localhost') || host.includes('127.0.0.1')) ? req.protocol : 'https';
  return `${protocol}://${host}/anime/proxy?url=`;
};

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
          const subMatch = embedUrl.match(/[?&](sub|caption_1)=([^&]+)/);
          const subtitle = subMatch ? decodeURIComponent(subMatch[2]) : '';
          sources.push({
            url: match[1],
            quality: label,
            isM3U8: match[1].includes('.m3u8'),
            subtitle: subtitle
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
    const baseProxyUrl = getBaseProxyUrl(req);
    const proxiedSources = sources.map(s => {
      const proxiedSub = s.subtitle ? `${baseProxyUrl}${encodeURIComponent(s.subtitle)}` : '';
      return {
        ...s,
        url: `${baseProxyUrl}${encodeURIComponent(s.url)}`,
        subtitle: proxiedSub
      };
    });
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

  const serverButtons = sources
    .filter(s => s.url)
    .map((s, i) => {
      const active = s.url === preferred.url ? 'active' : '';
      return `<button class="q-btn ${active}" data-url="${s.url}" data-subtitle="${s.subtitle || ''}" data-m3u8="${!!s.isM3U8}">${s.quality}</button>`;
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
    html, body { width: 100%; height: 100%; background: #000; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    
    #player-container {
      position: relative;
      width: 100%;
      height: 100vh;
      background: #000;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    video {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
    }

    /* Subtitles default cue styling override */
    ::cue {
      background: rgba(0, 0, 0, 0.75);
      color: #fff;
      font-size: 26px;
      font-family: inherit;
    }

    #qbar {
      position: absolute; top: 15px; left: 15px; z-index: 30;
      display: flex; gap: 6px; flex-wrap: wrap;
      background: rgba(0,0,0,0.65); padding: 6px 12px; border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.1);
      backdrop-filter: blur(10px);
      transition: opacity 0.3s;
    }
    #qbar.hidden { opacity: 0; pointer-events: none; }
    
    .q-btn {
      background: transparent; color: #aaa; border: 1px solid rgba(255,255,255,0.15);
      padding: 4px 10px; font-size: 11px; font-weight: 600; cursor: pointer;
      border-radius: 4px; text-transform: uppercase; transition: all 0.2s;
    }
    .q-btn:hover { border-color: #ff6b00; color: #ff6b00; }
    .q-btn.active { background: #ff6b00; color: #000; border-color: #ff6b00; }

    #err {
      display: none; position: absolute; inset: 0;
      background: rgba(0,0,0,.85); color: #f44; font-family: monospace; font-size: 13px;
      align-items: center; justify-content: center; text-align: center;
      padding: 20px; z-index: 25;
    }
    #err.show { display: flex; }

    /* Custom Controls Styles */
    .controls-bar {
      position: absolute; bottom: 0; left: 0; right: 0; z-index: 20;
      background: linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.5) 60%, transparent 100%);
      padding: 30px 20px 20px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      transition: opacity 0.3s ease;
      user-select: none;
    }
    .controls-bar.hidden { opacity: 0; pointer-events: none; }

    .progress-container {
      width: 100%;
      height: 4px;
      position: relative;
      cursor: pointer;
      display: flex;
      align-items: center;
    }
    .progress-container:hover { height: 8px; }

    .progress-bg {
      position: absolute; left: 0; right: 0; height: 100%;
      background: rgba(255,255,255,0.2);
      border-radius: 4px;
    }
    .progress-buffer {
      position: absolute; left: 0; height: 100%;
      background: rgba(255,255,255,0.15);
      border-radius: 4px;
      width: 0;
      pointer-events: none;
    }
    .progress-hover {
      position: absolute; left: 0; height: 100%;
      background: rgba(255,255,255,0.3);
      border-radius: 4px;
      width: 0;
    }
    .progress-fill {
      position: absolute; left: 0; height: 100%;
      background: #ff6b00;
      border-radius: 4px;
      width: 0;
    }
    .progress-handle {
      position: absolute;
      top: 50%;
      transform: translate(-50%, -50%) scale(0);
      width: 12px;
      height: 12px;
      background: #ff6b00;
      border-radius: 50%;
      transition: transform 0.1s;
    }
    .progress-container:hover .progress-handle { transform: translate(-50%, -50%) scale(1); }

    .buttons-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .left-controls, .right-controls {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .control-btn {
      background: transparent;
      border: none;
      outline: none;
      color: #ccc;
      cursor: pointer;
      transition: color 0.2s, transform 0.1s;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 4px;
    }
    .control-btn:hover { color: #ff6b00; }
    .control-btn:active { transform: scale(0.9); }
    .control-btn.active { color: #ff6b00; }

    .time-display {
      color: #aaa;
      font-size: 13px;
      font-family: monospace;
    }

    /* Interactive Volume Slider */
    .volume-container {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .volume-slider-wrapper {
      width: 0;
      overflow: hidden;
      transition: width 0.2s ease;
      display: flex;
      align-items: center;
    }
    .volume-container:hover .volume-slider-wrapper {
      width: 60px;
    }
    #volume-slider {
      -webkit-appearance: none;
      width: 60px;
      height: 4px;
      background: rgba(255,255,255,0.25);
      border-radius: 2px;
      outline: none;
      cursor: pointer;
    }
    #volume-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #ff6b00;
      cursor: pointer;
    }

    /* Dropdown Menus */
    .dropdown-wrapper {
      position: relative;
    }

    .dropdown-menu {
      position: absolute;
      bottom: 35px;
      right: 0;
      background: rgba(15,15,15,0.95);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 8px;
      padding: 6px 0;
      min-width: 110px;
      display: flex;
      flex-direction: column;
      z-index: 100;
      backdrop-filter: blur(10px);
      box-shadow: 0 4px 15px rgba(0,0,0,0.5);
    }
    .dropdown-menu.hidden { display: none; }

    .dropdown-item {
      background: transparent;
      border: none;
      color: #bbb;
      text-align: left;
      padding: 8px 16px;
      font-size: 12px;
      cursor: pointer;
      width: 100%;
      transition: all 0.2s;
      font-family: inherit;
    }
    .dropdown-item:hover { background: rgba(255,107,0,0.15); color: #ff6b00; }
    .dropdown-item.active { color: #ff6b00; font-weight: 700; }

    /* Subtitle Customizer Panel */
    .subtitle-settings-menu {
      min-width: 175px !important;
      padding: 10px 12px !important;
      gap: 10px;
      color: #ccc;
    }
    .setting-section {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }
    .setting-section span {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .setting-section select {
      background: #1a1a1a;
      border: 1px solid rgba(255,255,255,0.2);
      color: #fff;
      border-radius: 4px;
      padding: 2px 6px;
      outline: none;
      font-size: 11px;
      cursor: pointer;
    }

    /* Resume progress toast */
    .resume-toast {
      position: absolute; bottom: 85px; left: 20px; z-index: 40;
      background: rgba(15,15,15,0.95); border: 1px solid rgba(255,255,255,0.15);
      border-radius: 8px; padding: 10px 14px; display: flex; align-items: center;
      gap: 12px; font-size: 12px; color: #fff; backdrop-filter: blur(10px);
      box-shadow: 0 4px 15px rgba(0,0,0,0.5);
      transition: opacity 0.3s;
    }
    .resume-toast.hidden { opacity: 0; pointer-events: none; }
    .resume-toast button {
      background: transparent; border: 1px solid rgba(255,255,255,0.2);
      color: #ccc; padding: 4px 10px; border-radius: 4px; cursor: pointer;
      font-size: 11px; font-weight: bold; transition: all 0.2s;
    }
    .resume-toast button#resume-yes { background: #ff6b00; color: #000; border-color: #ff6b00; }
    .resume-toast button:hover { transform: scale(1.05); }

    /* Skip Intro Button */
    .skip-btn {
      position: absolute; bottom: 85px; right: 20px; z-index: 40;
      background: rgba(15,15,15,0.95); border: 1px solid #ff6b00;
      border-radius: 6px; padding: 8px 16px; color: #ff6b00;
      font-weight: bold; cursor: pointer; font-size: 13px;
      backdrop-filter: blur(10px); transition: all 0.2s;
      box-shadow: 0 4px 15px rgba(0,0,0,0.5);
    }
    .skip-btn:hover { background: #ff6b00; color: #000; }
    .skip-btn.hidden { display: none; }

    /* Loader styling */
    .loader {
      position: absolute; z-index: 10;
      border: 4px solid rgba(255,255,255,0.1);
      border-top: 4px solid #ff6b00;
      border-radius: 50%;
      width: 44px; height: 44px;
      animation: spin 1s linear infinite;
    }
    .loader.hidden { display: none; }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    /* Center Overlay Animation */
    .center-icon {
      position: absolute; z-index: 12;
      width: 60px; height: 60px;
      background: rgba(0,0,0,0.6);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; pointer-events: none;
      transform: scale(0.7);
      transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.4s;
      color: #ff6b00;
    }
    .center-icon.active { opacity: 1; transform: scale(1); }
  </style>
</head>
<body>
  <div id="player-container">
    <video id="v" playsinline></video>
    
    <div id="loader" class="loader"></div>
    <div id="center-play" class="center-icon"></div>
    
    ${sources.length > 1 ? `<div id="qbar">${serverButtons}</div>` : ''}
    <div id="err">⚠ Stream failed.<br>Try another quality or server.</div>

    <!-- Resume Playback Toast -->
    <div id="resume-toast" class="resume-toast hidden">
      <span>Resume from <span id="resume-time">00:00</span>?</span>
      <button id="resume-yes">Yes</button>
      <button id="resume-no">No</button>
    </div>

    <!-- Skip Intro Button -->
    <button id="skip-intro-btn" class="skip-btn hidden">Skip Intro</button>

    <!-- Custom Control Bar -->
    <div id="controls-bar" class="controls-bar hidden">
      <!-- Progress Bar (Scrubber) -->
      <div class="progress-container" id="progress-container">
        <div class="progress-bg"></div>
        <div class="progress-buffer" id="progress-buffer"></div>
        <div class="progress-hover" id="progress-hover"></div>
        <div class="progress-fill" id="progress-fill"></div>
        <div class="progress-handle" id="progress-handle"></div>
      </div>

      <!-- Controls Row -->
      <div class="buttons-row">
        <div class="left-controls">
          <!-- Play / Pause -->
          <button id="play-btn" class="control-btn" title="Play">
            <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          </button>

          <!-- Interactive Volume -->
          <div class="volume-container">
            <button id="volume-btn" class="control-btn" title="Mute">
              <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
            </button>
            <div class="volume-slider-wrapper">
              <input type="range" id="volume-slider" min="0" max="1" step="0.05" value="1">
            </div>
          </div>

          <span id="time-display" class="time-display">00:00 / 00:00</span>
        </div>

        <div class="right-controls">
          <!-- CC Toggle -->
          <button id="sub-btn" class="control-btn hidden" title="Toggle Subtitles">
            <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" ry="2"></rect><line x1="7" y1="8" x2="17" y2="8"></line><line x1="7" y1="12" x2="17" y2="12"></line><line x1="7" y1="16" x2="13" y2="16"></line></svg>
          </button>

          <!-- CC Customizer Menu -->
          <div class="dropdown-wrapper">
            <button id="sub-styles-btn" class="control-btn hidden" title="Subtitle Appearance">
              <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4z"></path></svg>
            </button>
            <div id="sub-styles-menu" class="dropdown-menu subtitle-settings-menu hidden">
              <div class="setting-section">
                <span>Size</span>
                <select id="sub-size">
                  <option value="18px">Small</option>
                  <option value="26px" selected>Medium</option>
                  <option value="34px">Large</option>
                  <option value="44px">X-Large</option>
                </select>
              </div>
              <div class="setting-section">
                <span>Color</span>
                <select id="sub-color">
                  <option value="#ffffff" selected>White</option>
                  <option value="#ffff00">Yellow</option>
                  <option value="#00ff00">Green</option>
                </select>
              </div>
              <div class="setting-section">
                <span>Background</span>
                <select id="sub-bg">
                  <option value="rgba(0,0,0,0)">None</option>
                  <option value="rgba(0,0,0,0.4)">40%</option>
                  <option value="rgba(0,0,0,0.75)" selected>75%</option>
                  <option value="rgba(0,0,0,1)">100%</option>
                </select>
              </div>
              <div class="setting-section">
                <span>Outline</span>
                <select id="sub-outline">
                  <option value="none">None</option>
                  <option value="shadow" selected>Shadow</option>
                  <option value="thick">Thick</option>
                </select>
              </div>
              <div class="setting-section">
                <span>Align</span>
                <select id="sub-align">
                  <option value="center" selected>Center</option>
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                </select>
              </div>
              <div class="setting-section">
                <span>Position</span>
                <input type="range" id="sub-position" min="10" max="95" step="5" value="90" title="Vertical position">
              </div>
            </div>
          </div>

          <!-- Quality Select Menu -->
          <div class="dropdown-wrapper">
            <button id="quality-btn" class="control-btn hidden" title="Change Resolution">
              <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            </button>
            <div id="quality-menu" class="dropdown-menu hidden"></div>
          </div>

          <!-- Playback Speed Menu -->
          <div class="dropdown-wrapper">
            <button id="speed-btn" class="control-btn" title="Playback Speed">
              <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            </button>
            <div id="speed-menu" class="dropdown-menu hidden">
              <button class="dropdown-item" data-speed="0.5">0.5x</button>
              <button class="dropdown-item" data-speed="0.75">0.75x</button>
              <button class="dropdown-item active" data-speed="1">Normal</button>
              <button class="dropdown-item" data-speed="1.25">1.25x</button>
              <button class="dropdown-item" data-speed="1.5">1.5x</button>
              <button class="dropdown-item" data-speed="2">2.0x</button>
            </div>
          </div>

          <!-- Picture in Picture -->
          <button id="pip-btn" class="control-btn" title="Picture in Picture">
            <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><rect x="13" y="13" width="7" height="7"></rect></svg>
          </button>

          <!-- Fullscreen -->
          <button id="fs-btn" class="control-btn" title="Toggle Fullscreen">
            <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>
          </button>
        </div>
      </div>
    </div>
  </div>

  <script>
    const vid = document.getElementById('v');
    const err = document.getElementById('err');
    const loader = document.getElementById('loader');
    const centerPlay = document.getElementById('center-play');
    const playBtn = document.getElementById('play-btn');
    const subBtn = document.getElementById('sub-btn');
    const subStylesBtn = document.getElementById('sub-styles-btn');
    const subStylesMenu = document.getElementById('sub-styles-menu');
    const subSizeSelect = document.getElementById('sub-size');
    const subColorSelect = document.getElementById('sub-color');
    const subBgSelect = document.getElementById('sub-bg');
    const subOutlineSelect = document.getElementById('sub-outline');
    const subAlignSelect = document.getElementById('sub-align');
    const subPositionInput = document.getElementById('sub-position');
    
    const qualityBtn = document.getElementById('quality-btn');
    const qualityMenu = document.getElementById('quality-menu');
    
    const speedBtn = document.getElementById('speed-btn');
    const speedMenu = document.getElementById('speed-menu');
    
    const pipBtn = document.getElementById('pip-btn');
    const fsBtn = document.getElementById('fs-btn');
    const volumeBtn = document.getElementById('volume-btn');
    const volumeSlider = document.getElementById('volume-slider');
    
    const progressContainer = document.getElementById('progress-container');
    const progressFill = document.getElementById('progress-fill');
    const progressBuffer = document.getElementById('progress-buffer');
    const progressHover = document.getElementById('progress-hover');
    const progressHandle = document.getElementById('progress-handle');
    const controlsBar = document.getElementById('controls-bar');
    const qbar = document.getElementById('qbar');

    const resumeToast = document.getElementById('resume-toast');
    const resumeTimeSpan = document.getElementById('resume-time');
    const resumeYes = document.getElementById('resume-yes');
    const resumeNo = document.getElementById('resume-no');
    const skipIntroBtn = document.getElementById('skip-intro-btn');

    let hls = null;
    let idleTimer = null;
    let progressSaveInterval = null;
    let lastVolume = localStorage.getItem('player-volume') !== null ? parseFloat(localStorage.getItem('player-volume')) : 1;
    let isMuted = localStorage.getItem('player-muted') === 'true';

    const playIcon = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
    const pauseIcon = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';
    const volHighIcon = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';
    const volLowIcon = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';
    const volMutedIcon = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>';

    // Load Stream
    function load(url, subtitleUrl, isM3U8) {
      err.classList.remove('show');
      loader.classList.remove('hidden');
      resumeToast.classList.add('hidden');
      skipIntroBtn.classList.add('hidden');
      if (hls) { hls.destroy(); hls = null; }
      
      // Clean tracks
      while(vid.firstChild) { vid.removeChild(vid.firstChild); }
      subBtn.classList.add('hidden');
      subStylesBtn.classList.add('hidden');
      qualityBtn.classList.add('hidden');

      // Add subtitle if provided
      if (subtitleUrl) {
        const track = document.createElement('track');
        track.label = 'English';
        track.kind = 'subtitles';
        track.srclang = 'en';
        track.src = subtitleUrl;
        track.default = true;
        vid.appendChild(track);
        subBtn.classList.remove('hidden');
        subBtn.classList.add('active');
        subStylesBtn.classList.remove('hidden');
        
        track.addEventListener('load', () => {
          applyCuePositionSettings();
        });

        vid.textTracks.addEventListener('addtrack', () => {
          const t = vid.textTracks[0];
          t.mode = 'showing';
          t.addEventListener('cuechange', applyCuePositionSettings);
        });
      }

      if (isM3U8) {
        if (Hls.isSupported()) {
          hls = new Hls({ enableWorker: true });
          hls.loadSource(url);
          hls.attachMedia(vid);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            loader.classList.add('hidden');
            vid.play().catch(() => {});
            buildQualityMenu();
            initPlaybackResume(url);
          });
          hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) err.classList.add('show'); });
        } else if (vid.canPlayType('application/vnd.apple.mpegurl')) {
          vid.src = url;
          vid.play().catch(() => {});
          initPlaybackResume(url);
        } else {
          err.classList.add('show');
        }
      } else {
        vid.src = url;
        vid.play().catch(() => {});
        initPlaybackResume(url);
      }
    }

    // Playback state toggle
    function togglePlay() {
      if (vid.paused) { vid.play().catch(() => {}); } else { vid.pause(); }
    }
    
    vid.addEventListener('play', () => {
      playBtn.innerHTML = pauseIcon;
      triggerCenterIcon(playIcon);
    });
    vid.addEventListener('pause', () => {
      playBtn.innerHTML = playIcon;
      triggerCenterIcon(pauseIcon);
    });
    
    vid.addEventListener('click', togglePlay);
    playBtn.addEventListener('click', togglePlay);

    // Center icon animation
    function triggerCenterIcon(svgHtml) {
      centerPlay.innerHTML = svgHtml;
      centerPlay.classList.add('active');
      setTimeout(() => centerPlay.classList.remove('active'), 500);
    }

    // Time update & Progress bar
    function formatTime(secs) {
      if (isNaN(secs) || secs === Infinity) return '00:00';
      const m = Math.floor(secs / 60);
      const s = Math.floor(secs % 60);
      return \`\${m < 10 ? '0' : ''}\${m}:\${s < 10 ? '0' : ''}\${s}\`;
    }

    vid.addEventListener('timeupdate', () => {
      const pct = (vid.currentTime / vid.duration) * 100 || 0;
      progressFill.style.width = \`\${pct}%\`;
      progressHandle.style.left = \`\${pct}%\`;
      document.getElementById('time-display').textContent = \`\${formatTime(vid.currentTime)} / \${formatTime(vid.duration)}\`;
      
      // Auto-display Skip Intro between 80s and 170s
      if (vid.currentTime >= 80 && vid.currentTime <= 170) {
        skipIntroBtn.classList.remove('hidden');
      } else {
        skipIntroBtn.classList.add('hidden');
      }
    });

    skipIntroBtn.onclick = () => {
      vid.currentTime = 175;
      skipIntroBtn.classList.add('hidden');
      triggerCenterIcon('<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>');
    };

    // Buffer range tracking
    vid.addEventListener('progress', () => {
      if (vid.duration > 0 && vid.buffered.length > 0) {
        for (let i = 0; i < vid.buffered.length; i++) {
          if (vid.buffered.start(vid.buffered.length - 1 - i) < vid.currentTime) {
            const bufferEnd = vid.buffered.end(vid.buffered.length - 1 - i);
            const pct = (bufferEnd / vid.duration) * 100;
            progressBuffer.style.width = \`\${pct}%\`;
            break;
          }
        }
      }
    });

    progressContainer.addEventListener('click', (e) => {
      const rect = progressContainer.getBoundingClientRect();
      const pos = (e.clientX - rect.left) / rect.width;
      vid.currentTime = pos * vid.duration;
    });

    progressContainer.addEventListener('mousemove', (e) => {
      const rect = progressContainer.getBoundingClientRect();
      const pos = (e.clientX - rect.left) / rect.width;
      progressHover.style.width = \`\${pos * 100}%\`;
    });

    progressContainer.addEventListener('mouseleave', () => {
      progressHover.style.width = '0%';
    });

    // Auto-hide controls on idle
    function showControls() {
      controlsBar.classList.remove('hidden');
      if (qbar) qbar.classList.remove('hidden');
      document.body.style.cursor = 'default';
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!vid.paused) {
          controlsBar.classList.add('hidden');
          if (qbar) qbar.classList.add('hidden');
          document.body.style.cursor = 'none';
        }
      }, 3000);
    }

    document.body.addEventListener('mousemove', showControls);
    document.body.addEventListener('click', showControls);
    vid.addEventListener('play', showControls);
    showControls();

    // Loader events
    vid.addEventListener('waiting', () => loader.classList.remove('hidden'));
    vid.addEventListener('playing', () => loader.classList.add('hidden'));

    // Fullscreen
    async function toggleFullscreen() {
      const container = document.getElementById('player-container');
      if (!document.fullscreenElement) {
        await container.requestFullscreen().catch(e => console.error(e));
      } else {
        await document.exitFullscreen();
      }
    }
    fsBtn.addEventListener('click', toggleFullscreen);
    vid.addEventListener('dblclick', toggleFullscreen);

    // Picture in Picture
    if (document.pictureInPictureEnabled) {
      pipBtn.addEventListener('click', async () => {
        try {
          if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
          } else {
            await vid.requestPictureInPicture();
          }
        } catch (e) { console.error(e); }
      });
    } else {
      pipBtn.classList.add('hidden');
    }

    // Subtitle toggler
    subBtn.addEventListener('click', () => {
      const track = vid.textTracks[0];
      if (track) {
        if (track.mode === 'showing') {
          track.mode = 'disabled';
          subBtn.classList.remove('active');
        } else {
          track.mode = 'showing';
          subBtn.classList.add('active');
        }
      }
    });

    // Subtitle Styles Handler
    const subStyleEl = document.createElement('style');
    document.head.appendChild(subStyleEl);

    function applyCuePositionSettings() {
      const track = vid.textTracks[0];
      if (!track) return;

      const posVal = parseFloat(subPositionInput.value);
      const alignVal = subAlignSelect.value;

      const apply = (cue) => {
        cue.snapToLines = false;
        cue.line = posVal;
        cue.align = alignVal;
      };

      if (track.activeCues) {
        for (let i = 0; i < track.activeCues.length; i++) {
          apply(track.activeCues[i]);
        }
      }

      if (track.cues) {
        for (let i = 0; i < track.cues.length; i++) {
          apply(track.cues[i]);
        }
      }
    }

    function applySubtitleStyles() {
      const size = subSizeSelect.value;
      const color = subColorSelect.value;
      const bg = subBgSelect.value;
      const outline = subOutlineSelect.value;

      localStorage.setItem('sub-size', size);
      localStorage.setItem('sub-color', color);
      localStorage.setItem('sub-bg', bg);
      localStorage.setItem('sub-outline', outline);
      localStorage.setItem('sub-position', subPositionInput.value);
      localStorage.setItem('sub-align', subAlignSelect.value);

      let textShadow = 'none';
      if (outline === 'shadow') {
        textShadow = '2px 2px 4px rgba(0,0,0,0.8)';
      } else if (outline === 'thick') {
        textShadow = '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000';
      }

      subStyleEl.textContent = \`
        ::cue {
          font-size: \${size} !important;
          color: \${color} !important;
          background: \${bg} !important;
          text-shadow: \${textShadow} !important;
        }
      \`;

      applyCuePositionSettings();
    }

    subSizeSelect.onchange = applySubtitleStyles;
    subColorSelect.onchange = applySubtitleStyles;
    subBgSelect.onchange = applySubtitleStyles;
    subOutlineSelect.onchange = applySubtitleStyles;
    subAlignSelect.onchange = applySubtitleStyles;
    subPositionInput.oninput = applySubtitleStyles;

    if (localStorage.getItem('sub-size')) subSizeSelect.value = localStorage.getItem('sub-size');
    if (localStorage.getItem('sub-color')) subColorSelect.value = localStorage.getItem('sub-color');
    if (localStorage.getItem('sub-bg')) subBgSelect.value = localStorage.getItem('sub-bg');
    if (localStorage.getItem('sub-outline')) subOutlineSelect.value = localStorage.getItem('sub-outline');
    if (localStorage.getItem('sub-align')) subAlignSelect.value = localStorage.getItem('sub-align');
    if (localStorage.getItem('sub-position')) subPositionInput.value = localStorage.getItem('sub-position');
    applySubtitleStyles();

    // Volume Scrubber Logic
    function updateVolumeUI() {
      if (isMuted || vid.volume === 0) {
        volumeBtn.innerHTML = volMutedIcon;
        volumeSlider.value = 0;
      } else if (vid.volume < 0.5) {
        volumeBtn.innerHTML = volLowIcon;
        volumeSlider.value = vid.volume;
      } else {
        volumeBtn.innerHTML = volHighIcon;
        volumeSlider.value = vid.volume;
      }
    }

    function setVolume(val, save = true) {
      vid.volume = val;
      isMuted = val === 0;
      if (save) {
        localStorage.setItem('player-volume', val);
        localStorage.setItem('player-muted', isMuted);
      }
      updateVolumeUI();
    }

    volumeSlider.oninput = (e) => setVolume(parseFloat(e.target.value));
    volumeBtn.onclick = () => {
      if (vid.volume > 0) {
        lastVolume = vid.volume;
        setVolume(0);
      } else {
        setVolume(lastVolume);
      }
    };
    setVolume(isMuted ? 0 : lastVolume, false);

    // Playback Speed Selector
    document.querySelectorAll('#speed-menu .dropdown-item').forEach(btn => {
      btn.onclick = () => {
        const speed = parseFloat(btn.dataset.speed);
        vid.playbackRate = speed;
        document.querySelectorAll('#speed-menu .dropdown-item').forEach(x => x.classList.remove('active'));
        btn.classList.add('active');
        speedMenu.classList.add('hidden');
      };
    });

    // Quality manual dropdown builder
    function buildQualityMenu() {
      if (!hls || !hls.levels || hls.levels.length <= 1) return;
      qualityBtn.classList.remove('hidden');
      qualityMenu.innerHTML = '';

      // Auto button
      const autoBtn = document.createElement('button');
      autoBtn.className = 'dropdown-item active';
      autoBtn.textContent = 'Auto';
      autoBtn.onclick = () => {
        hls.currentLevel = -1;
        setQualityActive(autoBtn);
      };
      qualityMenu.appendChild(autoBtn);

      // Levels
      hls.levels.forEach((l, idx) => {
        const btn = document.createElement('button');
        btn.className = 'dropdown-item';
        btn.textContent = l.height ? \`\${l.height}p\` : \`Level \${idx + 1}\`;
        btn.onclick = () => {
          hls.currentLevel = idx;
          setQualityActive(btn);
        };
        qualityMenu.appendChild(btn);
      });
    }

    function setQualityActive(btn) {
      document.querySelectorAll('#quality-menu .dropdown-item').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      qualityMenu.classList.add('hidden');
    }

    // Dropdown Closing / Opening Helper
    function closeAllMenus() {
      qualityMenu.classList.add('hidden');
      speedMenu.classList.add('hidden');
      subStylesMenu.classList.add('hidden');
    }

    qualityBtn.onclick = (e) => {
      e.stopPropagation();
      const wasHidden = qualityMenu.classList.contains('hidden');
      closeAllMenus();
      if (wasHidden) qualityMenu.classList.remove('hidden');
    };

    speedBtn.onclick = (e) => {
      e.stopPropagation();
      const wasHidden = speedMenu.classList.contains('hidden');
      closeAllMenus();
      if (wasHidden) speedMenu.classList.remove('hidden');
    };

    subStylesBtn.onclick = (e) => {
      e.stopPropagation();
      const wasHidden = subStylesMenu.classList.contains('hidden');
      closeAllMenus();
      if (wasHidden) subStylesMenu.classList.remove('hidden');
    };

    document.onclick = closeAllMenus;

    // Prevent dropdown menus from closing when clicking inside them
    qualityMenu.onclick = (e) => e.stopPropagation();
    speedMenu.onclick = (e) => e.stopPropagation();
    subStylesMenu.onclick = (e) => e.stopPropagation();

    // Keyboard Hotkeys
    window.onkeydown = (e) => {
      if (document.activeElement.tagName === 'SELECT' || document.activeElement.tagName === 'INPUT') return;

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'arrowright':
        case 'l':
          e.preventDefault();
          vid.currentTime = Math.min(vid.duration, vid.currentTime + 10);
          triggerCenterIcon('<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><path d="M5 12h14M12 5l7 7-7 7"/></svg>');
          break;
        case 'arrowleft':
        case 'j':
          e.preventDefault();
          vid.currentTime = Math.max(0, vid.currentTime - 10);
          triggerCenterIcon('<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>');
          break;
        case 'arrowup':
          e.preventDefault();
          setVolume(Math.min(1, vid.volume + 0.05));
          break;
        case 'arrowdown':
          e.preventDefault();
          setVolume(Math.max(0, vid.volume - 0.05));
          break;
        case 'm':
          e.preventDefault();
          volumeBtn.click();
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'p':
          e.preventDefault();
          pipBtn.click();
          break;
      }
    };

    // Mobile Double-Tap seeking
    let lastTap = 0;
    vid.ontouchend = (e) => {
      const now = Date.now();
      if (now - lastTap < 300) {
        e.preventDefault();
        const rect = vid.getBoundingClientRect();
        const touchX = e.changedTouches[0].clientX - rect.left;
        const third = rect.width / 3;

        if (touchX < third) {
          vid.currentTime = Math.max(0, vid.currentTime - 10);
          triggerCenterIcon('<svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>');
        } else if (touchX > third * 2) {
          vid.currentTime = Math.min(vid.duration, vid.currentTime + 10);
          triggerCenterIcon('<svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none"><path d="M5 12h14M12 5l7 7-7 7"/></svg>');
        }
      }
      lastTap = now;
    };

    // Playback progress resume
    function getProgressKey(url) {
      return \`progress_\${btoa(url).slice(0, 30)}\`;
    }

    function initPlaybackResume(url) {
      const key = getProgressKey(url);
      const saved = localStorage.getItem(key);
      
      clearInterval(progressSaveInterval);

      if (saved) {
        const savedTime = parseFloat(saved);
        if (savedTime > 10) {
          vid.addEventListener('loadedmetadata', function onMetadata() {
            vid.removeEventListener('loadedmetadata', onMetadata);
            if (savedTime < vid.duration * 0.98) {
              resumeTimeSpan.textContent = formatTime(savedTime);
              resumeToast.classList.remove('hidden');
              
              resumeYes.onclick = () => {
                vid.currentTime = savedTime;
                resumeToast.classList.add('hidden');
                vid.play().catch(() => {});
              };
              
              resumeNo.onclick = () => {
                resumeToast.classList.add('hidden');
              };
              
              setTimeout(() => resumeToast.classList.add('hidden'), 8000);
            }
          });
        }
      }

      progressSaveInterval = setInterval(() => {
        if (vid.currentTime > 5 && vid.duration > 0) {
          if (vid.currentTime > vid.duration * 0.98) {
            localStorage.removeItem(key);
          } else {
            localStorage.setItem(key, vid.currentTime.toString());
          }
        }
      }, 4000);
    }

    // Server mirror buttons
    document.querySelectorAll('.q-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.q-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        load(b.dataset.url, b.dataset.subtitle, b.dataset.m3u8 === 'true');
      });
    });

    // Initialize with preferred
    load(${JSON.stringify(preferred.url)}, ${JSON.stringify(preferred.subtitle || '')}, ${!!preferred.isM3U8});
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
    const baseProxyUrl = getBaseProxyUrl(req);

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
    const baseProxyUrl = getBaseProxyUrl(req);
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

