import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { AniNekoScraper } from '../../services/anineko';
import cache from '../../utils/cache';
import { redis } from '../../main';
import { Redis } from 'ioredis';
import axios from 'axios';

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
      let slug = '';
      const normalize = (str: string) => str.replace(/['']/g, "'").replace(/[""]/g, '"').trim();

      if (anilistId) {
        const cacheKey = `${redisPrefix}anilist-to-slug:${anilistId}`;
        const cached = redis ? await (redis as Redis).get(cacheKey) : null;
        if (cached) {
          slug = cached;
        } else {
          const query = `
            query ($id: Int) {
              Media (id: $id, type: ANIME) {
                title {
                  romaji
                  english
                  userPreferred
                }
              }
            }
          `;
          const alRes = await axios.post('https://graphql.anilist.co', {
            query,
            variables: { id: parseInt(anilistId) }
          });
          const titles = alRes.data?.data?.Media?.title;

          let searchResults: any[] = [];
          let selectedTitle = '';

          // 1. Try English Title
          if (titles?.english) {
            selectedTitle = normalize(titles.english);
            searchResults = await anineko.search(selectedTitle);
          }

          // 2. Try Romaji Title if English failed or wasn't provided
          if (searchResults.length === 0 && titles?.romaji) {
            selectedTitle = normalize(titles.romaji);
            searchResults = await anineko.search(selectedTitle);
          }

          // 3. Try User Preferred Title
          if (searchResults.length === 0 && titles?.userPreferred) {
            selectedTitle = normalize(titles.userPreferred);
            searchResults = await anineko.search(selectedTitle);
          }

          // 4. Try Query Param Title
          if (searchResults.length === 0 && title) {
            selectedTitle = normalize(title);
            searchResults = await anineko.search(selectedTitle);
          }

          if (searchResults.length > 0) {
            const target = selectedTitle.toLowerCase();
            const best = searchResults.find(r => {
              const t = r.title.toLowerCase();
              return t === target || t.includes(target) || target.includes(t);
            }) || searchResults[0];
            slug = best.id;
            console.log(`[Embed Mapping] Resolved AniList ID ${anilistId} to AniNeko slug: "${slug}"`);
            if (redis) {
              await (redis as Redis).setex(cacheKey, redisCacheTime, slug);
            }
          }
        }
      }

      if (!slug && title) {
        const cleanTitle = normalize(title);
        const searchResults = await anineko.search(cleanTitle);
        if (searchResults.length > 0) {
          const target = cleanTitle.toLowerCase();
          const best = searchResults.find(r => {
            const t = r.title.toLowerCase();
            return t === target || t.includes(target) || target.includes(t);
          }) || searchResults[0];
          slug = best.id;
        }
      }

      if (!slug) {
        console.error(`[Embed Mapping] Failed to resolve slug for AniList ID: ${anilistId}, Title: ${title}`);
        return reply.status(404).send({ message: 'Anime title or mapping not found' });
      }

      const episodeId = `${slug}/ep-${episode}`;
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