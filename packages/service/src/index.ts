/**
 * @honey/service — storage-agnostic application layer shared by apps/api
 * (Fastify, in-memory) and apps/worker (Cloudflare Worker, D1).
 * Runs on Node 20+ and on Workers (Web Crypto only, no node: imports).
 */
export * from './repository.js';
export * from './notifier.js';
export * from './loyaltyService.js';
export * from './inMemoryRepository.js';
export * from './phone.js';
export * from './telegram/initData.js';
