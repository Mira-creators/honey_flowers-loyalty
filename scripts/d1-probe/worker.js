// D1 probe (C3 / M0): empirical checks of Cloudflare D1 on a SEPARATE throwaway database.
// Never bind this Worker to the polygon or customer database.
//
//   GET /run?key=<PROBE_KEY>                 → all checks except subrequests, JSON report
//   GET /run?key=<PROBE_KEY>&only=rollback   → one group (rollback, raise, fk, changes, params,
//                                              json, rows, batch)
//   GET /subreq?key=<PROBE_KEY>&n=50         → n separate queries in one invocation
//
// Every check creates its own tables (prefix p_) and drops them at the end, so a re-run starts clean.

const json = (o, status = 200) =>
  new Response(JSON.stringify(o, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const errText = (e) => String(e && (e.cause?.message || e.message) || e);

async function exec(db, sql) {
  // db.exec splits on newlines; keep each statement on one line
  for (const s of sql.split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
}

async function count(db, table) {
  try {
    return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
  } catch (e) {
    return `error: ${errText(e)}`;
  }
}

const meta = (r) => ({ rows_read: r.meta?.rows_read, rows_written: r.meta?.rows_written, changes: r.meta?.changes, duration_ms: r.meta?.duration });

// ---------- 1. Rollback of a batch ----------
async function rollback(db) {
  const out = {};
  await exec(db, `DROP TABLE IF EXISTS p_rb; CREATE TABLE p_rb (id INTEGER PRIMARY KEY, v INTEGER NOT NULL CHECK (v >= 0))`);

  // 1a. [INSERT ok, INSERT ok, INSERT violating CHECK]
  let err = null;
  try {
    await db.batch([
      db.prepare('INSERT INTO p_rb (id, v) VALUES (1, 1)'),
      db.prepare('INSERT INTO p_rb (id, v) VALUES (2, 2)'),
      db.prepare('INSERT INTO p_rb (id, v) VALUES (3, -1)'),
    ]);
  } catch (e) {
    err = errText(e);
  }
  const left = await count(db, 'p_rb');
  out.check_violation_last = { error: err, rows_left: left, expected_rows_left: 0, pass: err !== null && left === 0 };

  // 1b. violation in the MIDDLE, valid statements after it
  err = null;
  try {
    await db.batch([
      db.prepare('INSERT INTO p_rb (id, v) VALUES (10, 1)'),
      db.prepare('INSERT INTO p_rb (id, v) VALUES (11, -1)'),
      db.prepare('INSERT INTO p_rb (id, v) VALUES (12, 1)'),
    ]);
  } catch (e) {
    err = errText(e);
  }
  const left2 = await count(db, 'p_rb');
  out.check_violation_middle = { error: err, rows_left: left2, expected_rows_left: 0, pass: err !== null && left2 === 0 };

  // 1c. loyalty pattern: version guard (PK) FIRST; a concurrent writer with the same version
  //     must leave nothing from its batch (client_versions in d1Repository.saveOutcome)
  await exec(db, `DROP TABLE IF EXISTS p_ver; DROP TABLE IF EXISTS p_led; CREATE TABLE p_ver (client TEXT NOT NULL, ver INTEGER NOT NULL, PRIMARY KEY (client, ver)); CREATE TABLE p_led (id INTEGER PRIMARY KEY AUTOINCREMENT, client TEXT, amount INTEGER)`);
  await db.batch([
    db.prepare("INSERT INTO p_ver VALUES ('c1', 1)"),
    db.prepare("INSERT INTO p_led (client, amount) VALUES ('c1', 100)"),
  ]);
  err = null;
  try {
    await db.batch([
      db.prepare("INSERT INTO p_ver VALUES ('c1', 1)"), // same version → PK conflict
      db.prepare("INSERT INTO p_led (client, amount) VALUES ('c1', 999)"),
    ]);
  } catch (e) {
    err = errText(e);
  }
  const led = await db.prepare("SELECT COUNT(*) AS n, SUM(amount) AS s FROM p_led").first();
  out.version_guard_conflict = { error: err, ledger_rows: led.n, ledger_sum: led.s, expected: { ledger_rows: 1, ledger_sum: 100 }, pass: err !== null && led.n === 1 && led.s === 100 };

  // 1d. guard LAST (stock pattern header → ... → guard): earlier writes must vanish
  err = null;
  try {
    await db.batch([
      db.prepare("INSERT INTO p_led (client, amount) VALUES ('c1', 555)"),
      db.prepare("INSERT INTO p_ver VALUES ('c1', 1)"),
    ]);
  } catch (e) {
    err = errText(e);
  }
  const led2 = await db.prepare("SELECT COUNT(*) AS n FROM p_led").first();
  out.guard_last_conflict = { error: err, ledger_rows: led2.n, expected_ledger_rows: 1, pass: err !== null && led2.n === 1 };

  // 1e. trigger aborts inside INSERT … SELECT FROM json_each (5 rows), cache UPDATE earlier in the batch
  await exec(db, `DROP TABLE IF EXISTS p_mv; DROP TABLE IF EXISTS p_cache; CREATE TABLE p_mv (id INTEGER PRIMARY KEY AUTOINCREMENT, qty INTEGER NOT NULL); CREATE TABLE p_cache (k TEXT PRIMARY KEY, total INTEGER NOT NULL); INSERT INTO p_cache VALUES ('on_hand', 1000)`);
  await db.prepare("CREATE TRIGGER p_mv_guard BEFORE INSERT ON p_mv WHEN NEW.qty = 3 BEGIN SELECT RAISE(ABORT, 'перерасход партии'); END").run();
  err = null;
  try {
    await db.batch([
      db.prepare("UPDATE p_cache SET total = total - 15 WHERE k = 'on_hand'"),
      db.prepare('INSERT INTO p_mv (qty) SELECT value FROM json_each(?)').bind(JSON.stringify([1, 2, 3, 4, 5])),
    ]);
  } catch (e) {
    err = errText(e);
  }
  const mv = await count(db, 'p_mv');
  const cache = (await db.prepare("SELECT total FROM p_cache WHERE k = 'on_hand'").first()).total;
  out.trigger_abort_in_json_each = { error: err, movement_rows: mv, cache_total: cache, expected: { movement_rows: 0, cache_total: 1000 }, pass: err !== null && mv === 0 && cache === 1000 };

  await exec(db, 'DROP TABLE p_rb; DROP TABLE p_ver; DROP TABLE p_led; DROP TABLE p_mv; DROP TABLE p_cache');
  return out;
}

// ---------- 2. RAISE text reaches the Worker ----------
async function raise(db) {
  await exec(db, 'DROP TABLE IF EXISTS p_r; CREATE TABLE p_r (id INTEGER PRIMARY KEY)');
  await db.prepare("CREATE TRIGGER p_r_no_delete BEFORE DELETE ON p_r BEGIN SELECT RAISE(ABORT, 'stock_ledger_immutable: журнал не меняется'); END").run();
  await db.prepare('INSERT INTO p_r VALUES (1)').run();
  let err = null;
  try {
    await db.prepare('DELETE FROM p_r').run();
  } catch (e) {
    err = errText(e);
  }
  await exec(db, 'DROP TABLE p_r');
  return { raised_message: err, pass: !!err && err.includes('stock_ledger_immutable') && err.includes('журнал') };
}

// ---------- 3. Foreign keys ----------
async function fk(db) {
  const pragma = await db.prepare('PRAGMA foreign_keys').first();
  await exec(db, 'DROP TABLE IF EXISTS p_child; DROP TABLE IF EXISTS p_parent; CREATE TABLE p_parent (id INTEGER PRIMARY KEY); CREATE TABLE p_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES p_parent(id))');
  let err = null;
  try {
    await db.prepare('INSERT INTO p_child VALUES (1, 42)').run();
  } catch (e) {
    err = errText(e);
  }
  await exec(db, 'DROP TABLE p_child; DROP TABLE p_parent');
  return { pragma_foreign_keys: pragma, orphan_insert_error: err, enforced: err !== null };
}

// ---------- 4. changes() between statements of one batch ----------
async function changes(db) {
  await exec(db, "DROP TABLE IF EXISTS p_c; CREATE TABLE p_c (id INTEGER PRIMARY KEY, s TEXT); INSERT INTO p_c VALUES (1, 'a'), (2, 'a'), (3, 'b')");
  const r = await db.batch([
    db.prepare("UPDATE p_c SET s = 'x' WHERE s = 'a'"),
    db.prepare('SELECT changes() AS c'),
  ]);
  await exec(db, 'DROP TABLE p_c');
  const seen = r[1].results?.[0]?.c;
  return { changes_seen_by_next_statement: seen, expected: 2, pass: seen === 2 };
}

// ---------- 5. Bound parameters ----------
async function params(db) {
  const out = {};
  for (const n of [100, 101]) {
    // IN-list keeps expression depth flat (a + b + … hits SQLite's depth limit of 100 first)
    const sql = `SELECT COUNT(*) AS s FROM (SELECT 1) WHERE 1 IN (${Array.from({ length: n }, () => '?').join(', ')})`;
    try {
      const r = await db.prepare(sql).bind(...Array.from({ length: n }, () => 1)).first();
      out[`params_${n}`] = { ok: true, sum: r.s };
    } catch (e) {
      out[`params_${n}`] = { ok: false, error: errText(e) };
    }
  }
  return out;
}

// ---------- 6. json_each with a large parameter ----------
async function jsonParam(db) {
  const out = {};
  for (const kb of [100, 500, 1900]) {
    const item = { id: 'it_0000000000', qty: 12, cost: 123456 };
    const one = JSON.stringify(item).length + 1;
    const arr = Array.from({ length: Math.ceil((kb * 1024) / one) }, (_, i) => ({ ...item, id: `it_${String(i).padStart(10, '0')}` }));
    const payload = JSON.stringify(arr);
    try {
      const r = await db.prepare('SELECT COUNT(*) AS n, SUM(json_extract(value, \'$.qty\')) AS q FROM json_each(?)').bind(payload).first();
      out[`json_${kb}kb`] = { ok: true, bytes: payload.length, elements: r.n };
    } catch (e) {
      out[`json_${kb}kb`] = { ok: false, bytes: payload.length, error: errText(e) };
    }
  }
  return out;
}

// ---------- 7. meta.rows_written: indexes, partial index, triggers, upsert ----------
async function rows(db) {
  const out = {};
  await exec(db, 'DROP TABLE IF EXISTS p_w; DROP TABLE IF EXISTS p_daily; DROP TABLE IF EXISTS p_lot');
  await exec(db, 'CREATE TABLE p_w (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, c INTEGER); CREATE INDEX p_w_a ON p_w(a); CREATE INDEX p_w_b ON p_w(b); CREATE INDEX p_w_c ON p_w(c)');
  await exec(db, 'CREATE TABLE p_plain (id INTEGER PRIMARY KEY, a INTEGER)');
  out.insert_no_secondary_index = meta(await db.prepare('INSERT INTO p_plain VALUES (1, 1)').run());
  out.insert_3_indexes = meta(await db.prepare('INSERT INTO p_w VALUES (1, 1, 1, 1)').run());

  // partial index: does UPDATE rewrite it when the predicate does not change?
  await exec(db, 'CREATE TABLE p_lot (id INTEGER PRIMARY KEY, item TEXT, qty INTEGER); CREATE INDEX p_lot_pick ON p_lot(item, id) WHERE qty > 0');
  await db.prepare("INSERT INTO p_lot VALUES (1, 'rose', 10)").run();
  out.update_partial_predicate_unchanged = meta(await db.prepare('UPDATE p_lot SET qty = 5 WHERE id = 1').run());
  out.update_partial_predicate_changes = meta(await db.prepare('UPDATE p_lot SET qty = 0 WHERE id = 1').run());

  // AFTER INSERT trigger writing an aggregate row (stock_daily pattern)
  await exec(db, 'CREATE TABLE p_daily (day TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0); CREATE TABLE p_mv2 (id INTEGER PRIMARY KEY, day TEXT)');
  await db.prepare('CREATE TRIGGER p_mv2_daily AFTER INSERT ON p_mv2 BEGIN INSERT INTO p_daily (day, n) VALUES (NEW.day, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1; END').run();
  out.insert_without_trigger_baseline = meta(await db.prepare("INSERT INTO p_plain VALUES (2, 2)").run());
  out.insert_with_after_trigger_first = meta(await db.prepare("INSERT INTO p_mv2 VALUES (1, '2026-12-01')").run());
  out.insert_with_after_trigger_upsert = meta(await db.prepare("INSERT INTO p_mv2 VALUES (2, '2026-12-01')").run());

  // ON CONFLICT DO UPDATE directly
  out.upsert_insert_path = meta(await db.prepare("INSERT INTO p_daily (day, n) VALUES ('2026-12-02', 1) ON CONFLICT(day) DO UPDATE SET n = n + 1").run());
  out.upsert_update_path = meta(await db.prepare("INSERT INTO p_daily (day, n) VALUES ('2026-12-02', 1) ON CONFLICT(day) DO UPDATE SET n = n + 1").run());

  // 100 rows through json_each with the trigger: total written in one statement
  const days = Array.from({ length: 100 }, (_, i) => [1000 + i, `2026-12-${String((i % 28) + 1).padStart(2, '0')}`]);
  out.insert_100_rows_json_each_with_trigger = meta(
    await db.prepare("INSERT INTO p_mv2 (id, day) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)").bind(JSON.stringify(days)).run(),
  );

  out.trigger_writes_counted =
    (out.insert_with_after_trigger_first.rows_written ?? 0) > (out.insert_without_trigger_baseline.rows_written ?? 0);
  await exec(db, 'DROP TABLE p_w; DROP TABLE p_plain; DROP TABLE p_lot; DROP TABLE p_daily; DROP TABLE p_mv2');
  return out;
}

// ---------- 8. Statements per batch ----------
async function batchSize(db, sizes) {
  const out = {};
  for (const n of sizes) {
    const t = `p_b${n}`;
    await exec(db, `DROP TABLE IF EXISTS ${t}; CREATE TABLE ${t} (id INTEGER PRIMARY KEY, v INTEGER)`);
    const stmts = Array.from({ length: n }, (_, i) => db.prepare(`INSERT INTO ${t} VALUES (?, ?)`).bind(i, i));
    const t0 = Date.now();
    try {
      const r = await db.batch(stmts);
      const written = r.reduce((s, x) => s + (x.meta?.rows_written ?? 0), 0);
      out[`batch_${n}`] = { ok: true, ms: Date.now() - t0, rows_in_table: await count(db, t), rows_written: written };
    } catch (e) {
      out[`batch_${n}`] = { ok: false, ms: Date.now() - t0, error: errText(e), rows_in_table: await count(db, t) };
    }
    await exec(db, `DROP TABLE ${t}`);
  }
  return out;
}

const GROUPS = {
  rollback,
  raise,
  fk,
  changes,
  params,
  json: jsonParam,
  rows,
  batch: (db, url) => batchSize(db, (url.searchParams.get('sizes') || '100,500,1000,2000,5000').split(',').map(Number)),
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!env.PROBE_KEY || url.searchParams.get('key') !== env.PROBE_KEY) return json({ error: 'forbidden' }, 403);
    const db = env.DB;

    if (url.pathname === '/subreq') {
      const n = Math.min(Number(url.searchParams.get('n') || 50), 1200);
      let done = 0;
      try {
        for (let i = 0; i < n; i++) {
          await db.prepare('SELECT ? AS i').bind(i).first();
          done++;
        }
        return json({ test: 'subrequests', requested: n, completed: done, ok: true });
      } catch (e) {
        return json({ test: 'subrequests', requested: n, completed: done, ok: false, error: errText(e) });
      }
    }

    if (url.pathname === '/run') {
      const only = url.searchParams.get('only');
      const names = only ? only.split(',') : Object.keys(GROUPS);
      const report = { at: new Date().toISOString(), colo: req.cf?.colo ?? null, results: {} };
      for (const name of names) {
        const fn = GROUPS[name];
        if (!fn) {
          report.results[name] = { error: 'unknown group' };
          continue;
        }
        const t0 = Date.now();
        try {
          report.results[name] = await fn(db, url);
        } catch (e) {
          report.results[name] = { crashed: errText(e) };
        }
        report.results[name].group_ms = Date.now() - t0;
      }
      return json(report);
    }
    return json({ endpoints: ['/run?key=…[&only=rollback,raise,fk,changes,params,json,rows,batch]', '/subreq?key=…&n=50'] });
  },
};
