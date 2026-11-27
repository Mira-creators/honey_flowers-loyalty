/**
 * @honey/stock — pure math of the «Склад» module (no IO, no Date.now(), no dependencies), shared by
 * the Worker (authoritative posting) and the Mini App (live cost preview on the phone).
 * See docs/Склад — архитектура.md §4.
 */
export * from './types.js';
export * from './money.js';
export * from './allocate.js';
export * from './config.js';
export * from './receipt.js';
export * from './fifo.js';
export * from './pricing.js';
export * from './freshness.js';
export * from './disassembly.js';
export * from './permissions.js';
export * from './builder.js';
