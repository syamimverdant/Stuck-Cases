#!/usr/bin/env node
// Builds history.json for the "History of Movement" section (aggregates only, no customer data).
// Source: Monday.com activity log, replayed per case. Run: node build-history.js
// API key: env MONDAY_API_KEY, else read from index.html (local use).
const fs = require('fs');
const path = require('path');
const htmlPath = path.join(__dirname, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const KEY = process.env.MONDAY_API_KEY || (html.match(/const API_KEY = '([^']+)'/) || [])[1];
if (!KEY) throw new Error('No Monday API key (set MONDAY_API_KEY)');
const BOARD = 530233143;
const WINDOW_START = Date.UTC(2025, 6, 1) - 8 * 3600e3; // 1 Jul 2025 00:00 MYT
const LAUNCH = '2026-07-29', MOVEMENT_START = '2026-10-12';
const BEFORE_FROM = '2026-05-04', BEFORE_TO = '2026-07-20', AFTER_FROM = '2026-08-03';
const COLS = ['status91', 'status01', 'status55', 'status96'];
const ADDON = new Set([4, 5, 6, 9, 12, 13]);

// Team mapping reused from index.html so there is one source of truth.
const block = html.slice(html.indexOf('const STATE_TO_REGION'), html.indexOf('// Duration colour coding'));
const { resolveRegion, isExcludedSC } = new Function(block + '; return { resolveRegion, isExcludedSC };')();

async function gql(query, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch('https://api.monday.com/v2', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: KEY, 'API-Version': '2024-10' }, body: JSON.stringify({ query }) });
    const j = await r.json();
    if (!j.errors && j.data) return j;
    if (i === tries - 1) throw new Error(JSON.stringify(j.errors || j));
    await new Promise(s => setTimeout(s, 3000 * (i + 1)));
  }
}
const ms = c => Number(String(c).slice(0, 13));
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(2); };
const mean = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null;
const pct = (a, f) => a.length ? +(100 * a.filter(f).length / a.length).toFixed(1) : null;

// ---- 1. Items
async function fetchItems() {
  const items = new Map();
  const cv = `column_values(ids:["status91","status01","status55","status96","status32","date66","numbers8","person","area__1"]) { id text } `;
  const dd = `column_values(ids:["dropdown5"]) { id ... on DropdownValue { values { id } } }`;
  const sel = `cursor items { id name group { id title } ${cv.replace('column_values', 'a: column_values')} ${dd.replace('column_values', 'b: column_values')} }`;
  let cursor = null, first = true;
  while (first || cursor) {
    const q = first ? `{ boards(ids:${BOARD}) { items_page(limit:500) { ${sel} } } }` : `{ next_items_page(limit:500, cursor:"${cursor}") { ${sel} } }`;
    const r = await gql(q);
    const page = first ? r.data.boards[0].items_page : r.data.next_items_page;
    for (const it of page.items) {
      const c = {}; it.a.forEach(v => c[v.id] = (v.text || '').trim());
      const cat = (it.b[0] && it.b[0].values || []).map(v => Number(v.id));
      items.set(String(it.id), { id: String(it.id), name: it.name, group: it.group, c, addon: cat.some(x => ADDON.has(x)) });
    }
    cursor = page.cursor; first = false;
    if (!page.items.length) cursor = null;
  }
  return items;
}

// ---- 2. Events
async function fetchEvents(now) {
  const evs = []; const seen = new Set();
  let y = 2025, m = 7;
  while (Date.UTC(y, m - 1, 1) <= now) {
    const from = new Date(Date.UTC(y, m - 1, 1)).toISOString(), to = new Date(Date.UTC(y, m, 1) - 1000).toISOString();
    for (let page = 1; ; page++) {
      const r = await gql(`{ boards(ids:${BOARD}) { activity_logs(from:"${from}", to:"${to}", column_ids:${JSON.stringify(COLS)}, limit:1000, page:${page}) { id event data created_at } } }`);
      const logs = r.data.boards[0].activity_logs || [];
      for (const l of logs) {
        if (seen.has(l.id)) continue; seen.add(l.id);
        let d; try { d = JSON.parse(l.data); } catch { continue; }
        if (!COLS.includes(d.column_id)) continue;
        const ids = d.pulse_ids || (d.pulse_id ? [d.pulse_id] : []);
        const prev = d.previous_value && d.previous_value.label ? d.previous_value.label.text : null;
        const val = d.value && d.value.label ? d.value.label.text : '';
        for (const id of ids) evs.push({ id: String(id), col: d.column_id, ts: ms(l.created_at), prev, val: val || '' });
      }
      if (logs.length < 1000) break;
    }
    process.stderr.write(`events ${y}-${String(m).padStart(2, '0')}: total ${evs.length}\n`);
    if (++m > 12) { m = 1; y++; }
  }
  return evs;
}

// ---- 3. Replay
const STUCK = new Set(['Requested', 'SSR Approved', 'SSR Rejected', 'Pending', 'Revise Request', 'Return by Ops Team', 'PE Checking', 'Revised PE Checking']);
const SEDA_OUT = new Set(['Done', '3. Payment Made', '2. Submitted', '1. Check/Key In Pending']);
const PCC = 'Pending Client Confirmation';
const isPCC = s => s.status91 === PCC;
const isExt = s => STUCK.has(s.status91) && s.status01 === 'External' && s.status55 !== 'Done' && !SEDA_OUT.has(s.status96);

function replay(items, evs, now) {
  const byItem = new Map();
  evs.forEach(e => { if (!byItem.has(e.id)) byItem.set(e.id, []); byItem.get(e.id).push(e); });
  const out = { pcc: [], ext: [] }; // intervals {team,id,in,out,cause}
  for (const it of items.values()) {
    if (it.group.title.trim().toUpperCase() === 'DROP' || it.group.id === 'new_group6902') { it.dropGroup = true; }
    const sc = it.c.person; if (isExcludedSC(sc) || it.addon) continue;
    const list = (byItem.get(it.id) || []).sort((a, b) => a.ts - b.ts);
    if (it.group.title.trim().toUpperCase() === 'DROP' || it.group.id === 'new_group6902') {
      const dd = it.c.date66 ? Date.parse(it.c.date66 + 'T00:00:00+08:00') : NaN;
      it.dropTs = isFinite(dd) ? dd : (list.length ? list[list.length - 1].ts : -Infinity);
    }
    const team = resolveRegion(sc, it.c.area__1, it.name);
    it.team = team;
    const st = {};
    for (const col of COLS) { const f = list.find(e => e.col === col); st[col] = f ? (f.prev || '') : (it.c[col] || ''); }
    const seq = list.map(e => ({ ts: e.ts, col: e.col, val: e.val }));
    if (it.dropTs !== undefined && it.dropTs > WINDOW_START) { seq.push({ ts: it.dropTs, drop: true }); seq.sort((a, b) => a.ts - b.ts); }
    let dropped = it.dropTs !== undefined && it.dropTs <= WINDOW_START;
    const cur = { pcc: null, ext: null };
    const check = (ts, cause) => {
      for (const k of ['pcc', 'ext']) {
        const mem = !dropped && (k === 'pcc' ? isPCC(st) : isExt(st));
        if (mem && !cur[k]) cur[k] = { id: it.id, sc: (sc || "Unassigned").split(",")[0].trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase()), team, in: ts, out: null };
        else if (!mem && cur[k]) { cur[k].out = ts; cur[k].cause = dropped ? 'dropped' : cause(k); out[k].push(cur[k]); cur[k] = null; }
      }
    };
    cur.pcc = null; cur.ext = null;
    // initial membership (entry time unknown = -Infinity)
    for (const k of ['pcc', 'ext']) if (!dropped && (k === 'pcc' ? isPCC(st) : isExt(st))) cur[k] = { id: it.id, sc: (sc || "Unassigned").split(",")[0].trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase()), team, in: -Infinity, out: null };
    for (const e of seq) {
      if (e.drop) dropped = true; else st[e.col] = e.val;
      check(e.ts, k => k === 'pcc' ? (st.status91 === 'Done' ? 'done' : 'other')
        : (st.status91 === 'Done' || st.status55 === 'Done' || SEDA_OUT.has(st.status96) ? 'cleared' : (isPCC(st) ? 'pcc' : 'other')));
    }
    for (const k of ['pcc', 'ext']) if (cur[k]) out[k].push(cur[k]);
    // sanity: reconstructed end state vs live
    it.endMemberPCC = !!cur.pcc; it.livePCC = !it.dropGroup && it.c.status91 === PCC;
    it.endMemberExt = !!cur.ext; it.liveExt = !it.dropGroup && isExt(it.c);
  }
  return out;
}

// ---- 4. Aggregate
const weekStart = ts => { const d = new Date(ts + 8 * 3600e3); const dow = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) - 8 * 3600e3; };
const iso = ts => new Date(ts + 8 * 3600e3).toISOString().slice(0, 10);

function nobBucket(it) {
  if (!it) return 'unknown';
  if (it.dropGroup || it.c.status96 === 'Drop' || it.c.status32) return 'dropped';
  if (it.c.status91 !== 'Done') return 'reopened';
  return ['2. Submitted', '3. Payment Made', 'Done'].includes(it.c.status96) ? 'potential' : 'awaiting';
}

function aggregate(ivs, items, weeks, now, withNob) {
  const rows = weeks.map(w => {
    const end = Math.min(w + 7 * 864e5, now);
    const inW = t => t >= w && t < w + 7 * 864e5;
    const entered = ivs.filter(i => i.in !== -Infinity && inW(i.in));
    const exited = ivs.filter(i => i.out !== null && inW(i.out));
    const pool = ivs.filter(i => i.in < end && (i.out === null || i.out >= end)).length;
    const row = {
      week: iso(w), partial: w + 7 * 864e5 > now, entered: entered.length,
      outDone: exited.filter(i => i.cause === 'done' || i.cause === 'cleared').length,
      outOther: exited.filter(i => i.cause === 'other' || i.cause === 'pcc').length,
      outDropped: exited.filter(i => i.cause === 'dropped').length, pool
    };
    if (withNob) {
      const done = exited.filter(i => i.cause === 'done');
      const days = done.filter(i => i.in !== -Infinity).map(i => (i.out - i.in) / 864e5);
      row.days = days; // temporary, summarised below
      row.nob = { potential: [0, 0], awaiting: [0, 0], dropped: [0, 0], reopened: [0, 0] };
      for (const i of done) { const it = items.get(i.id); const b = nobBucket(it); if (!row.nob[b]) continue; row.nob[b][0]++; row.nob[b][1] += Number(it.c.numbers8) || 0; }
    }
    return row;
  });
  return rows;
}

function summarise(rows, from, to) {
  const r = rows.filter(x => x.week >= from && x.week <= to && !x.partial);
  const days = r.flatMap(x => x.days || []);
  const n = r.length || 1;
  const sum = f => r.reduce((a, x) => a + f(x), 0);
  return {
    weeks: r.length, from: r[0] && r[0].week, to: r.length && r[r.length - 1].week,
    avgEntered: +(sum(x => x.entered) / n).toFixed(1), avgOutDone: +(sum(x => x.outDone) / n).toFixed(1),
    avgPool: +(sum(x => x.pool) / n).toFixed(1), endPool: r.length ? r[r.length - 1].pool : null,
    clearedWithDays: days.length, medianDays: med(days), meanDays: mean(days),
    pctWithin3d: pct(days, d => d <= 3), pctWithin7d: pct(days, d => d <= 7), pctOver14d: pct(days, d => d > 14),
    nobPotentialRM: sum(x => x.nob ? x.nob.potential[1] : 0), nobPotentialCases: sum(x => x.nob ? x.nob.potential[0] : 0),
    nobPotentialRMPerWeek: Math.round(sum(x => x.nob ? x.nob.potential[1] : 0) / n)
  };
}

(async () => {
  const now = Date.now();
  const items = await fetchItems(); process.stderr.write(`items ${items.size}\n`);
  const evs = await fetchEvents(now); process.stderr.write(`events ${evs.length}\n`);
  const iv = replay(items, evs, now);
  const weeks = []; for (let w = weekStart(WINDOW_START + 7 * 864e5); w <= weekStart(now); w += 7 * 864e5) weeks.push(w);

  // reconstruction check vs live board
  const live = [...items.values()].filter(i => i.team);
  const chk = {
    pccLive: live.filter(i => i.livePCC).length, pccReplay: live.filter(i => i.endMemberPCC).length,
    extLive: live.filter(i => i.liveExt).length, extReplay: live.filter(i => i.endMemberExt).length,
    pccMismatch: live.filter(i => i.livePCC !== i.endMemberPCC).length, extMismatch: live.filter(i => i.liveExt !== i.endMemberExt).length
  };
  process.stderr.write('check ' + JSON.stringify(chk) + '\n');

  const teams = ['Northern', 'Southern', 'Central 1', 'Central 2', 'Unassigned (Central)', 'East Coast', 'East Malaysia'];
  const result = { generatedAt: new Date(now).toISOString(), launch: LAUNCH, movementStart: MOVEMENT_START, windows: { beforeFrom: BEFORE_FROM, beforeTo: BEFORE_TO, afterFrom: AFTER_FROM }, check: chk };
  for (const k of ['pcc', 'ext']) {
    const rows = aggregate(iv[k], items, weeks, now, k === 'pcc');
    const o = { weekly: rows.map(r => { const c = { ...r }; if (c.days) { c.medDays = med(c.days); c.nCleared = c.days.length; c.le7 = c.days.filter(d => d <= 7).length; } delete c.days; return c; }) };
    o.before = summarise(rows, BEFORE_FROM, BEFORE_TO); o.after = summarise(rows, AFTER_FROM, '9999');
    o.poolNow = iv[k].filter(i => i.out === null).length;
    o.byTeam = {};
    for (const t of teams) {
      const sub = iv[k].filter(i => i.team === t); if (!sub.length) continue;
      const tr = aggregate(sub, items, weeks, now, k === 'pcc');
      o.byTeam[t] = { poolNow: sub.filter(i => i.out === null).length, before: summarise(tr, BEFORE_FROM, BEFORE_TO), after: summarise(tr, AFTER_FROM, '9999'),
        weekly: tr.map(r => ({ week: r.week, entered: r.entered, outDone: r.outDone, outOther: r.outOther, pool: r.pool })) };
    }
    result[k] = o;
  }
  // since-launch totals (PCC)
  const L = Date.parse(LAUNCH + 'T00:00:00+08:00');
  const done = iv.pcc.filter(i => i.cause === 'done' && i.out >= L);
  const bucket = { potential: [0, 0], awaiting: [0, 0], dropped: [0, 0], reopened: [0, 0] };
  const seenC = new Set();
  for (const i of done.sort((a, b) => b.out - a.out)) { if (seenC.has(i.id)) continue; seenC.add(i.id); const it = items.get(i.id); const b = nobBucket(it); bucket[b][0]++; bucket[b][1] += Number(it.c.numbers8) || 0; }
  result.sinceLaunch = { pccEntered: iv.pcc.filter(i => i.in >= L).length, pccClearedEvents: done.length, pccClearedCases: seenC.size, nob: bucket,
    daysMedian: med(done.filter(i => i.in !== -Infinity).map(i => (i.out - i.in) / 864e5)) };
  // Per-SC PCC duration KPI: only cases that ENTERED PCC on/after 1 Jul 2026 (earlier entries not counted), up to 31 Dec 2026.
  const K0 = Date.parse('2026-07-01T00:00:00+08:00'), K1 = Date.parse('2027-01-01T00:00:00+08:00');
  const kp = iv.pcc.filter(i => i.in >= K0 && i.in < K1);
  const by = {};
  for (const i of kp) (by[i.sc] = by[i.sc] || []).push(i);
  const dur = i => ((i.out === null ? now : i.out) - i.in) / 864e5;
  const scRows = Object.entries(by).map(([sc, a]) => {
    const all = a.map(dur);
    const cl = a.filter(i => i.cause === 'done' && i.out !== null).map(dur);
    const open = a.filter(i => i.out === null).map(dur);
    return { sc, team: a[0].team, entered: a.length, settled: cl.length, open: open.length, otherExit: a.length - cl.length - open.length,
      avgAll: mean(all), medianAll: med(all), medianSettled: med(cl), openMedianAge: med(open), pctSettled7d: pct(cl, d => d <= 7) };
  }).sort((x, y) => x.medianAll - y.medianAll);
  const allD = kp.map(dur), allCl = kp.filter(i => i.cause === 'done' && i.out !== null).map(dur);
  result.scKpi = { from: '2026-07-01', to: '2026-12-31', rule: 'Cases that entered PCC on/after 1 Jul 2026. All = settled + other exits + still open (open measured to today). Settled = PCC to Done.', team: { avgAll: mean(allD), medianAll: med(allD), medianSettled: med(allCl), entered: kp.length, settled: allCl.length, open: kp.filter(i => i.out === null).length }, rows: scRows };
  fs.writeFileSync(path.join(__dirname, 'history.json'), JSON.stringify(result));
  console.log(JSON.stringify({ check: chk, since: result.sinceLaunch, pccBefore: result.pcc.before, pccAfter: result.pcc.after, extBefore: result.ext.before, extAfter: result.ext.after, poolNow: [result.pcc.poolNow, result.ext.poolNow] }, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
