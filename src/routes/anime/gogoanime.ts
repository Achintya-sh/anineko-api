import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { AniNekoScraper } from '../../services/anineko';
import cache from '../../utils/cache';
import { redis } from '../../main';
import { Redis } from 'ioredis';
import axios from 'axios';

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

  // Embed redirection route
  fastify.get('/embed', async (request: FastifyRequest, reply: FastifyReply) => {
    const anilistId = (request.query as { anilistId?: string }).anilistId;
    const title = (request.query as { title?: string }).title;
    const episode = (request.query as { episode?: string }).episode || '1';
    const isDub = (request.query as { dub?: string }).dub === 'true';

    try {
      let resolvedSlug: string | null = null;
      let resolvedEp = parseInt(episode, 10);
      const normalize = (str: string) => str.replace(/['']/g, "'").replace(/[""]/g, '"').trim();

      if (anilistId) {
        const parsedId = parseInt(anilistId, 10);
        const cacheKey = `${redisPrefix}anilist-to-slug:${anilistId}:${episode}:${isDub}`;
        const cached = redis ? await (redis as Redis).get(cacheKey) : null;
        
        if (cached) {
          const parsed = JSON.parse(cached);
          resolvedSlug = parsed.slug;
          resolvedEp = parsed.episode;
        } else {
          const chain = await buildChain(parsedId);
          if (chain.length > 0) {
            console.log(`[Embed Mapping] Resolved sequel chain of length ${chain.length}`);
            let accumulated = 0;

            for (const item of chain) {
              if (item.format !== 'TV' && chain.some(c => c.format === 'TV')) {
                continue;
              }

              const results = await anineko.search(item.title);
              const slugCandidate = getBestSlug(results, item.title);

              if (!slugCandidate) {
                console.warn(`[AniNeko] Could not find slug for title: "${item.title}"`);
                continue;
              }

              const info = await anineko.fetchAnimeInfo(slugCandidate);
              const count = info?.episodes?.length || 0;
              console.log(`[AniNeko] Checked slug: ${slugCandidate} (${count} episodes)`);

              if (resolvedEp <= accumulated + count) {
                resolvedSlug = slugCandidate;
                resolvedEp = resolvedEp - accumulated;
                break;
              }
              accumulated += count;
            }

            // Fallback to last resolved slug if out of range
            if (!resolvedSlug && chain.length > 0) {
              const lastItem = chain[chain.length - 1];
              const results = await anineko.search(lastItem.title);
              resolvedSlug = getBestSlug(results, lastItem.title);
              resolvedEp = resolvedEp - accumulated;
            }

            if (resolvedSlug && redis) {
              await (redis as Redis).setex(cacheKey, redisCacheTime, JSON.stringify({ slug: resolvedSlug, episode: resolvedEp }));
            }
          }
        }
      }

      if (!resolvedSlug && title) {
        const cleanTitle = normalize(title);
        const searchResults = await anineko.search(cleanTitle);
        if (searchResults.length > 0) {
          resolvedSlug = getBestSlug(searchResults, cleanTitle);
        }
      }

      if (!resolvedSlug) {
        console.error(`[Embed Mapping] Failed to resolve slug for AniList ID: ${anilistId}, Title: ${title}`);
        return reply.status(404).send({ message: 'Anime title or mapping not found' });
      }

      const episodeId = `${resolvedSlug}/ep-${resolvedEp}`;
      const sources = await anineko.fetchEpisodeSources(episodeId);

      let filtered = sources.filter(s => s.isDub === isDub);
      if (filtered.length === 0) {
        filtered = sources;
      }

      if (filtered.length === 0) {
        return reply.status(404).send({ message: 'No video sources found' });
      }

      return reply.redirect(302, filtered[0].url);
    } catch (err: any) {
      reply.status(500).send({ message: err.message });
    }
  });
};

export default routes;