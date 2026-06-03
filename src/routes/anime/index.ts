import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';

import gogoanime from './gogoanime';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  await fastify.register(gogoanime, { prefix: '/gogoanime' });

  fastify.get('/', async (request: any, reply: any) => {
    reply.status(200).send('Welcome to Consumet Anime 🗾 (AniNeko scraper active)');
  });
};

export default routes;
