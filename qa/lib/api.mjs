// HTTP helpers for the QA suite. Every response is screened: any 5xx, non-JSON API error,
// error without a Russian message or a leaked stack trace is recorded as a failure.
import { randomUUID } from 'node:crypto';
import { TEST_KEY } from './worker.mjs';

export const ctx = { base: process.env.BASE || 'http://127.0.0.1:8797', key: process.env.QA_TEST_KEY || TEST_KEY };
export const serverErrors = [];
export const shapeErrors = [];
/** 5xx produced by the local runtime itself (miniflare lost the connection to workerd), not by the Worker code. */
export const infraErrors = [];
export const latencies = new Map(); // label -> [ms]

let seq = 0;
const CYR = /[А-Яа-яЁё]/;
const STACK = /(\n\s+at\s|\bat [\w$.]+ \(|\.ts:\d+|\.js:\d+|node_modules|Error: .*\n)/;

export function testHeaders(user, extra = {}) {
  return { 'x-test-user': String(user), 'x-test-key': ctx.key, 'x-test-name': encodeURIComponent(extra.name ?? `QA ${user}`), ...(extra.headers ?? {}) };
}

/**
 * Low-level request. `user` = X-Test-User id (null = no test auth).
 * opts: { body, rawBody, headers, label, noAuth, expectError }
 */
export async function req(user, method, path, opts = {}) {
  const headers = { ...(user !== null && user !== undefined && !opts.noAuth ? testHeaders(user, opts) : {}), ...(opts.headers ?? {}) };
  let body;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  }
  const id = `q${process.pid}-${++seq}`;
  headers['x-qa-req'] = id;
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(ctx.base + path, { method, headers, body, redirect: 'manual' });
  } catch (e) {
    serverErrors.push({ method, path, status: 'NETWORK', detail: String(e) });
    return { status: 0, body: null, text: '', headers: new Headers(), id, ms: 0 };
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const ms = performance.now() - t0;
  const text = new TextDecoder().decode(buf);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  const out = { status: res.status, body: json, text, bytes: buf, headers: res.headers, id, ms };
  if (opts.label) {
    if (!latencies.has(opts.label)) latencies.set(opts.label, []);
    latencies.get(opts.label).push(ms);
  }
  screen(method, path, out, opts);
  return out;
}

/** Contract of every API error: 4xx, JSON { error: { code, message } }, Russian message, no stack. */
export function screen(method, path, r, opts = {}) {
  const where = `${method} ${path.slice(0, 140)}`;
  if (r.status >= 500 && /^Error: Network connection lost\.[\s\S]*miniflare/.test(r.text)) {
    infraErrors.push({ where, body: r.text.slice(0, 200) });
    return;
  }
  if (r.status >= 500 && !opts.allow5xx) serverErrors.push({ where, status: r.status, body: r.text.slice(0, 300) });
  if (STACK.test(r.text) && !(r.headers.get('content-type') || '').includes('text/csv')) shapeErrors.push({ where, why: 'stack trace / file path leaked', body: r.text.slice(0, 300) });
  if (r.status >= 400 && path.startsWith('/api/') && !opts.allowNonJsonError) {
    const e = r.body?.error;
    if (!e || typeof e.code !== 'string' || typeof e.message !== 'string') shapeErrors.push({ where, status: r.status, why: 'error is not { error: { code, message } }', body: r.text.slice(0, 200) });
    else if (!CYR.test(e.message)) shapeErrors.push({ where, status: r.status, why: 'error message is not Russian', body: e.message.slice(0, 200) });
  }
}

export const as = (user) => ({
  get: (path, o = {}) => req(user, 'GET', path, o),
  post: (path, body, o = {}) => req(user, 'POST', path, { ...o, body }),
  put: (path, body, o = {}) => req(user, 'PUT', path, { ...o, body }),
  del: (path, o = {}) => req(user, 'DELETE', path, o),
});

export async function qa(path, body) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(ctx.base + '/__qa' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-test-key': ctx.key, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (attempt > 40) throw e; // worker restarting (wrangler reload): wait a bit
      await new Promise((res) => setTimeout(res, 250));
      continue;
    }
    const text = await r.text();
    // miniflare occasionally loses the connection to workerd ("Network connection lost"): infra, retry
    if (r.status >= 500 && /Network connection lost/.test(text) && attempt < 5) {
      infraErrors.push({ where: `/__qa${path}`, body: text.slice(0, 120) });
      await new Promise((res) => setTimeout(res, 500));
      continue;
    }
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`/__qa${path}: ${r.status} ${text.slice(0, 300)}`); }
    if (r.status !== 200) throw new Error(`/__qa${path}: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  }
}

/** Read-only SQL against the local D1 (through the QA entry, same database the Worker uses). */
export async function sql(query, params = []) {
  return (await qa('/sql', { sql: query, params })).rows;
}

/** D1 counters of a finished request (waits for waitUntil / streaming to finish). */
export async function d1Of(id) {
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${ctx.base}/__qa/req/${encodeURIComponent(id)}`, { headers: { 'x-test-key': ctx.key } });
    const c = await r.json();
    if (c.done || r.status !== 200) return c;
    await new Promise((res) => setTimeout(res, 20));
  }
  return null;
}

export const wipe = () => qa('/wipe', {});
export const newKey = (p = 'qa') => `${p}-${randomUUID()}`;

export async function setRole(user, role) {
  const r = await as(user).post('/api/test/role', { role });
  if (r.status !== 200) throw new Error(`setRole ${user} ${role}: ${r.status} ${r.text}`);
  return r.body;
}

export async function clock(days) {
  const r = await as(999_999_999).post('/api/test/clock', days === 'reset' ? { reset: true } : { days });
  if (r.status !== 200) throw new Error(`clock ${days}: ${r.status} ${r.text}`);
  return r.body;
}

/** Run the daily job until nothing is left (CRON_MAX_CLIENTS per run). */
export async function runExpiryAll(maxRuns = 500) {
  const total = { expired: 0, warned: 0, checked: 0, runs: 0 };
  for (let i = 0; i < maxRuns; i++) {
    const r = await as(999_999_999).post('/api/test/run-expiry', {});
    if (r.status !== 200) throw new Error(`run-expiry: ${r.status} ${r.text}`);
    total.expired += r.body.expired;
    total.warned += r.body.warned;
    total.checked += r.body.checked;
    total.runs++;
    if (!r.body.more) return total;
  }
  total.stuck = true;
  return total;
}

let phoneSeq = 0;
/** Unique Uzbek phone per test user. */
export function phoneFor(user) {
  const n = String(user % 10_000_000).padStart(7, '0');
  return `+99890${n}`;
}
export function nextPhone() {
  return `+99893${String(++phoneSeq + (process.pid % 1000) * 10000).padStart(7, '0')}`;
}

export async function register(user, name = `Клиент ${user}`, phone = phoneFor(user)) {
  const r = await as(user).post('/api/test/register', { phone, name });
  if (r.status !== 201) throw new Error(`register ${user}: ${r.status} ${r.text}`);
  return r.body.client;
}

export function percentile(list, p) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
