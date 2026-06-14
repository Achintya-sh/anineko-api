import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';

import gogoanime from './gogoanime';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  await fastify.register(gogoanime, { prefix: '/gogoanime' });

  // Miruro embed — same Miruro scraper, just aliased under /miruro/embed
  // so the frontend's VITE_API_URL/anime/miruro/embed route works on Render
  fastify.get('/miruro/embed', async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = new URLSearchParams(request.query as Record<string, string>).toString();
    return reply.redirect(302, `/anime/gogoanime/embed?${qs}`);
  });

  fastify.get('/', async (request: any, reply: any) => {
    reply.status(200).send('Welcome to Consumet Anime 🗾 (AniNeko scraper active)');
  });
};

export default routes;
