// Cloudflare Worker: the Facility Visit Tracker's server.
//   - Accounts are an employee ID plus a 4-digit PIN. Signing in returns a session key that the
//     browser keeps until it signs out or its site data is cleared.
//   - Stores each person's tracker in a D1 database, plus their last HISTORY_KEEP saved versions
//     so an admin can undo damage to one person's tracker without touching anyone else's
//   - Looks up facility addresses with Google Places (signed-in users only)
// Secrets live only in Cloudflare, never in the web page or on GitHub.
//
// Settings (Cloudflare → Worker → Settings):
//   GOOGLE_API_KEY   Secret       Google Places API (New) key
//   TEAM_CODE        Secret       Needed once, to create an account (not case-sensitive)
//   PIN_PEPPER       Secret       Long random string mixed into every PIN hash. Changing it invalidates every PIN.
//   ALLOWED_ORIGINS  Text         Comma-separated sites allowed to call this, e.g. https://yourname.github.io
//                                 (add "null" temporarily to test from index.html opened straight from disk)
//   DB               D1 binding   The database; tables are created automatically on first use
//
// Routes. Everything except signup/signin/reset needs header  Authorization: Bearer <session key>
//   POST /signup   {eeid, name, pin, teamCode}  → {token}
//   POST /signin   {eeid, pin}                  → {token}   (403 + {needCode} if an admin reset the PIN)
//   POST /reset    {eeid, code, pin}            → {token}   (one-time code from an admin; sets a new PIN)
//   POST /signout  {all}                        → {}        (all: true signs out every device)
//   POST /pin      {pin, newPin}                → {}        (change PIN; signs out the other devices)
//   GET  /data                                  → {eeid, name, admin, data, version}   (version 0: new account)
//   PUT  /data     {data, baseVersion}          → {version} (409 + {data, version} if changed elsewhere)
//   GET  /lookup?q=TEXT                         → {results:[{name, address}]}
//   Admins only:
//   GET  /admin/users                           → {users:[{eeid, name, admin, pinSet, resetPending, version, updatedAt, lastSeen}]}
//   POST /admin/reset    {eeid}                 → {code}    (clears their PIN and signs them out everywhere)
//   POST /admin/delete   {eeid}                 → {}
//   POST /admin/role     {eeid, admin}          → {}
//   GET  /admin/history?eeid=ID                 → {versions:[{version, savedAt, by, bytes}]}
//   POST /admin/restore  {eeid, version}        → {version}

const MAX_DATA_BYTES = 1500000;
const HISTORY_KEEP = 50;            // saved versions kept per person
const PIN_FAILS_PER_ID = 5;         // wrong PINs or reset codes for one employee ID…
const PIN_LOCK_MS = 15 * 60000;     // …within this window locks that ID until the oldest one ages out
const FAILS_PER_IP = 20;            // wrong PINs, codes or unknown IDs from one network per hour
const TEAM_CODE_FAILS_PER_IP = 10;  // wrong team codes from one network per hour
const SIGNUPS_PER_HOUR = 40;        // new accounts per hour from everyone
const RESET_CODE_MS = 24 * 3600000;
const HOUR = 3600000;

let schemaReady = false;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (!allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const send = (body, status) => json(body, status || 200, cors);

    try {
      if (!env.DB) return send({ error: 'Worker has no DB binding' }, 500);
      if (!env.PIN_PEPPER) return send({ error: 'Worker has no PIN_PEPPER' }, 500);
      await ensureSchema(env.DB);
      const db = env.DB;
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const body = request.method === 'POST' || request.method === 'PUT'
        ? await request.json().catch(() => null) || {} : {};

      // ---------- signing in ----------
      if (path === '/signup' && request.method === 'POST') {
        const eeid = cleanId(body.eeid), name = cleanName(body.name), pin = String(body.pin || '');
        if (!eeid) return send({ error: 'Employee IDs are 9 digits.' }, 400);
        if (!name) return send({ error: 'Enter your name.' }, 400);
        if (!/^\d{4}$/.test(pin)) return send({ error: 'PINs are 4 digits.' }, 400);
        if (await recent(db, 'team:' + ip, HOUR) >= TEAM_CODE_FAILS_PER_IP)
          return send({ error: 'Too many wrong team codes. Try again in an hour.' }, 429);
        if (!env.TEAM_CODE || !sameText(String(body.teamCode || '').trim().toLowerCase(), env.TEAM_CODE.trim().toLowerCase())) {
          await note(db, 'team:' + ip);
          return send({ error: 'That team code isn’t right.' }, 401);
        }
        if (await recent(db, 'signup', HOUR) >= SIGNUPS_PER_HOUR)
          return send({ error: 'Lots of people are signing up right now. Try again in an hour.' }, 429);
        const salt = randomHex(16), now = iso();
        const res = await db.prepare(`INSERT INTO accounts (eeid, name, pin_hash, pin_salt, admin, data, version, created_at, updated_at, last_seen)
          VALUES (?, ?, ?, ?, 0, '{}', 0, ?, ?, ?) ON CONFLICT(eeid) DO NOTHING`)
          .bind(eeid, name, await hashPin(env, salt, pin), salt, now, now, now).run();
        if (res.meta.changes !== 1) return send({ error: 'That employee ID already has an account. Sign in instead, or ask an admin to reset its PIN.' }, 409);
        await note(db, 'signup');
        return send({ token: await newSession(db, eeid) });
      }

      if ((path === '/signin' || path === '/reset') && request.method === 'POST') {
        const eeid = cleanId(body.eeid), pin = String(body.pin || ''), isReset = path === '/reset';
        if (!eeid) return send({ error: 'Employee IDs are 9 digits.' }, 400);
        if (!/^\d{4}$/.test(pin)) return send({ error: isReset ? 'Your new PIN must be 4 digits.' : 'PINs are 4 digits.' }, 400);
        const locked = await lockedFor(db, eeid, ip);
        if (locked) return send({ error: locked }, 429);
        const acc = await db.prepare('SELECT pin_hash, pin_salt, reset_hash, reset_expires FROM accounts WHERE eeid = ?').bind(eeid).first();
        if (!acc) {
          await note(db, 'ip:' + ip);
          return send({ error: 'No account has that employee ID. Check it, or create an account.' }, 404);
        }
        if (isReset) {
          const code = String(body.code || '').trim();
          if (!acc.reset_hash || acc.reset_expires < Date.now())
            return send({ error: 'There’s no active reset code for that ID. Ask an admin for a new one.' }, 400);
          if (!sameText(await hashPin(env, 'reset:' + eeid, code), acc.reset_hash)) return send({ error: await wrong(db, eeid, ip, 'code') }, 401);
          const salt = randomHex(16);
          await db.batch([
            db.prepare('UPDATE accounts SET pin_hash = ?, pin_salt = ?, reset_hash = NULL, reset_expires = NULL WHERE eeid = ?')
              .bind(await hashPin(env, salt, pin), salt, eeid),
            db.prepare('DELETE FROM sessions WHERE eeid = ?').bind(eeid),
            db.prepare('DELETE FROM attempts WHERE k = ?').bind('pin:' + eeid),
          ]);
          return send({ token: await newSession(db, eeid) });
        }
        if (!acc.pin_hash) return send({ error: 'Your PIN was reset. Enter the code your admin gave you.', needCode: true }, 403);
        if (!sameText(await hashPin(env, acc.pin_salt, pin), acc.pin_hash)) return send({ error: await wrong(db, eeid, ip, 'PIN') }, 401);
        await db.prepare('DELETE FROM attempts WHERE k = ?').bind('pin:' + eeid).run();
        return send({ token: await newSession(db, eeid) });
      }

      // ---------- everything below needs a session ----------
      const me = await sessionFor(request, db);
      if (!me) return send({ error: 'Signed out' }, 401);

      if (path === '/signout' && request.method === 'POST') {
        await (body.all
          ? db.prepare('DELETE FROM sessions WHERE eeid = ?').bind(me.eeid)
          : db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(me.tokenHash)).run();
        return send({});
      }

      if (path === '/pin' && request.method === 'POST') {
        const pin = String(body.pin || ''), newPin = String(body.newPin || '');
        if (!/^\d{4}$/.test(newPin)) return send({ error: 'Your new PIN must be 4 digits.' }, 400);
        const locked = await lockedFor(db, me.eeid, ip);
        if (locked) return send({ error: locked }, 429);
        const acc = await db.prepare('SELECT pin_hash, pin_salt FROM accounts WHERE eeid = ?').bind(me.eeid).first();
        if (!sameText(await hashPin(env, acc.pin_salt, pin), acc.pin_hash || '')) return send({ error: await wrong(db, me.eeid, ip, 'PIN') }, 403);
        const salt = randomHex(16);
        await db.batch([
          db.prepare('UPDATE accounts SET pin_hash = ?, pin_salt = ? WHERE eeid = ?').bind(await hashPin(env, salt, newPin), salt, me.eeid),
          db.prepare('DELETE FROM sessions WHERE eeid = ? AND token_hash != ?').bind(me.eeid, me.tokenHash),
        ]);
        return send({});
      }

      if (path === '/data' && request.method === 'GET') {
        const row = await db.prepare('SELECT name, admin, data, version FROM accounts WHERE eeid = ?').bind(me.eeid).first();
        return send({ eeid: me.eeid, name: row.name, admin: !!row.admin, data: JSON.parse(row.data), version: row.version });
      }

      if (path === '/data' && request.method === 'PUT') {
        if (typeof body.data !== 'object' || !body.data || !Number.isInteger(body.baseVersion))
          return send({ error: 'Body must be {data, baseVersion}' }, 400);
        const text = JSON.stringify(body.data);
        if (text.length > MAX_DATA_BYTES) return send({ error: 'Data too large' }, 413);
        // Optimistic concurrency: only write if nobody else saved since this device last loaded.
        const res = await db.prepare('UPDATE accounts SET data = ?, version = version + 1, updated_at = ? WHERE eeid = ? AND version = ?')
          .bind(text, iso(), me.eeid, body.baseVersion).run();
        if (res.meta.changes === 1) {
          await keepVersion(db, me.eeid, body.baseVersion + 1, text, me.eeid);
          return send({ version: body.baseVersion + 1 });
        }
        const row = await db.prepare('SELECT data, version FROM accounts WHERE eeid = ?').bind(me.eeid).first();
        return send({ error: 'Changed on another device', data: JSON.parse(row.data), version: row.version }, 409);
      }

      // "/" kept for the original lookup-only version of the app
      if ((path === '/lookup' || path === '/') && request.method === 'GET') {
        return send(await lookup(url.searchParams.get('q'), env));
      }

      // ---------- admin ----------
      if (path.startsWith('/admin/')) {
        if (!me.admin) return send({ error: 'Admins only' }, 403);
        const eeid = cleanId(request.method === 'GET' ? url.searchParams.get('eeid') : body.eeid);
        const self = eeid === me.eeid;

        if (path === '/admin/users' && request.method === 'GET') {
          const { results } = await db.prepare(`SELECT eeid, name, admin, pin_hash IS NOT NULL AS pin_set,
              COALESCE(reset_expires, 0) > ? AS reset_pending, version, updated_at, last_seen
            FROM accounts ORDER BY name COLLATE NOCASE`).bind(Date.now()).all();
          return send({ users: results.map(r => ({ eeid: r.eeid, name: r.name, admin: !!r.admin, pinSet: !!r.pin_set,
            resetPending: !!r.reset_pending, version: r.version, updatedAt: r.updated_at, lastSeen: r.last_seen })) });
        }
        if (!eeid) return send({ error: 'Missing employee ID' }, 400);
        const target = await db.prepare('SELECT version FROM accounts WHERE eeid = ?').bind(eeid).first();
        if (!target) return send({ error: 'No account has that employee ID' }, 404);

        if (path === '/admin/reset' && request.method === 'POST') {
          const code = String(randomInt(1000000)).padStart(6, '0');
          await db.batch([
            db.prepare('UPDATE accounts SET pin_hash = NULL, reset_hash = ?, reset_expires = ? WHERE eeid = ?')
              .bind(await hashPin(env, 'reset:' + eeid, code), Date.now() + RESET_CODE_MS, eeid),
            db.prepare('DELETE FROM sessions WHERE eeid = ?').bind(eeid),
            db.prepare('DELETE FROM attempts WHERE k = ?').bind('pin:' + eeid),
          ]);
          return send({ code });
        }
        if (path === '/admin/delete' && request.method === 'POST') {
          if (self) return send({ error: 'You can’t delete your own account.' }, 400);
          await db.batch([
            db.prepare('DELETE FROM accounts WHERE eeid = ?').bind(eeid),
            db.prepare('DELETE FROM sessions WHERE eeid = ?').bind(eeid),
            db.prepare('DELETE FROM history WHERE eeid = ?').bind(eeid),
          ]);
          return send({});
        }
        if (path === '/admin/role' && request.method === 'POST') {
          if (self) return send({ error: 'You can’t change your own admin role.' }, 400);
          await db.prepare('UPDATE accounts SET admin = ? WHERE eeid = ?').bind(body.admin ? 1 : 0, eeid).run();
          return send({});
        }
        if (path === '/admin/history' && request.method === 'GET') {
          const { results } = await db.prepare(`SELECT h.version, h.saved_at, h.by, a.name AS by_name, length(h.data) AS bytes
            FROM history h LEFT JOIN accounts a ON a.eeid = h.by WHERE h.eeid = ? ORDER BY h.version DESC`).bind(eeid).all();
          return send({ versions: results.map(r => ({ version: r.version, savedAt: r.saved_at, by: r.by_name || r.by, bytes: r.bytes })) });
        }
        if (path === '/admin/restore' && request.method === 'POST') {
          const old = await db.prepare('SELECT data FROM history WHERE eeid = ? AND version = ?').bind(eeid, body.version).first();
          if (!old) return send({ error: 'That version is no longer kept' }, 404);
          const res = await db.prepare('UPDATE accounts SET data = ?, version = version + 1, updated_at = ? WHERE eeid = ? AND version = ?')
            .bind(old.data, iso(), eeid, target.version).run();
          if (res.meta.changes !== 1) return send({ error: 'They saved a change just now. Try again.' }, 409);
          await keepVersion(db, eeid, target.version + 1, old.data, me.eeid);
          return send({ version: target.version + 1 });
        }
      }

      return send({ error: 'Not found' }, 404);
    } catch (e) {
      return send({ error: 'Server error: ' + e.message }, 500);
    }
  },
};

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS accounts (
      eeid TEXT PRIMARY KEY, name TEXT NOT NULL, pin_hash TEXT, pin_salt TEXT, admin INTEGER NOT NULL DEFAULT 0,
      reset_hash TEXT, reset_expires INTEGER, data TEXT NOT NULL, version INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, eeid TEXT NOT NULL, created_at TEXT NOT NULL, last_used INTEGER NOT NULL)`),
    db.prepare('CREATE INDEX IF NOT EXISTS sessions_eeid ON sessions (eeid)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS history (
      eeid TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, saved_at TEXT NOT NULL, by TEXT NOT NULL,
      PRIMARY KEY (eeid, version))`),
    db.prepare('CREATE TABLE IF NOT EXISTS attempts (k TEXT NOT NULL, ts INTEGER NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS attempts_k_ts ON attempts (k, ts)'),
  ]);
  schemaReady = true;
}

// ---------- sessions ----------
async function newSession(db, eeid) {
  const token = randomHex(32);
  await db.prepare('INSERT INTO sessions (token_hash, eeid, created_at, last_used) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), eeid, iso(), Date.now()).run();
  return token;
}
async function sessionFor(request, db) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const tokenHash = await sha256(m[1]);
  const row = await db.prepare(`SELECT s.eeid, s.last_used, a.admin FROM sessions s JOIN accounts a ON a.eeid = s.eeid
    WHERE s.token_hash = ?`).bind(tokenHash).first();
  if (!row) return null;
  // "Last active" for the admin list; at most one write a day per device
  if (Date.now() - row.last_used > 24 * HOUR) {
    await db.batch([
      db.prepare('UPDATE sessions SET last_used = ? WHERE token_hash = ?').bind(Date.now(), tokenHash),
      db.prepare('UPDATE accounts SET last_seen = ? WHERE eeid = ?').bind(iso(), row.eeid),
    ]);
  }
  return { eeid: row.eeid, admin: !!row.admin, tokenHash };
}

// ---------- rate limits ----------
async function recent(db, k, windowMs) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE k = ? AND ts > ?').bind(k, Date.now() - windowMs).first();
  return row.n;
}
async function note(db, k) {
  await db.batch([
    db.prepare('INSERT INTO attempts (k, ts) VALUES (?, ?)').bind(k, Date.now()),
    db.prepare('DELETE FROM attempts WHERE ts < ?').bind(Date.now() - 24 * HOUR),   // keep the table small
  ]);
}
// Checked before the PIN itself, so a locked-out guesser can't learn when they hit the right one.
async function lockedFor(db, eeid, ip) {
  const id = await db.prepare('SELECT COUNT(*) AS n, MIN(ts) AS first FROM attempts WHERE k = ? AND ts > ?')
    .bind('pin:' + eeid, Date.now() - PIN_LOCK_MS).first();
  if (id.n >= PIN_FAILS_PER_ID) {
    const mins = Math.max(1, Math.ceil((id.first + PIN_LOCK_MS - Date.now()) / 60000));
    return `Too many wrong tries for this employee ID. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
  }
  if (await recent(db, 'ip:' + ip, HOUR) >= FAILS_PER_IP) return 'Too many wrong tries from this network. Try again in an hour.';
  return '';
}
async function wrong(db, eeid, ip, what) {
  await note(db, 'pin:' + eeid);
  await note(db, 'ip:' + ip);
  const left = PIN_FAILS_PER_ID - await recent(db, 'pin:' + eeid, PIN_LOCK_MS);
  return left > 0
    ? `Wrong ${what}. ${left} more tr${left === 1 ? 'y' : 'ies'} before this ID is locked for ${PIN_LOCK_MS / 60000} minutes.`
    : `Wrong ${what}. This ID is locked for ${PIN_LOCK_MS / 60000} minutes.`;
}

async function keepVersion(db, eeid, version, text, by) {
  await db.batch([
    db.prepare('INSERT OR REPLACE INTO history (eeid, version, data, saved_at, by) VALUES (?, ?, ?, ?, ?)').bind(eeid, version, text, iso(), by),
    db.prepare('DELETE FROM history WHERE eeid = ? AND version <= ?').bind(eeid, version - HISTORY_KEEP),
  ]);
}

// ---------- helpers ----------
// A 4-digit PIN has only 10,000 values, so the hash's strength comes from PIN_PEPPER: without it,
// a copy of the database alone isn't enough to work out anyone's PIN.
async function hashPin(env, salt, pin) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.PIN_PEPPER),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(salt + ':' + pin)));
}
async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function randomHex(bytes) { return hex(crypto.getRandomValues(new Uint8Array(bytes))); }
function randomInt(max) {   // unbiased 0..max-1
  const limit = Math.floor(0x100000000 / max) * max, a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= limit);
  return a[0] % max;
}
const iso = () => new Date().toISOString();

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cleanId(s) {
  const id = String(s || '').replace(/\s+/g, '');
  return /^\d{9}$/.test(id) ? id : '';
}
function cleanName(s) {
  const name = String(s || '').trim().replace(/\s+/g, ' ');
  return name.length >= 1 && name.length <= 60 ? name : '';
}

async function lookup(q, env) {
  q = (q || '').trim().slice(0, 200);
  if (!q) return { results: [] };
  if (!env.GOOGLE_API_KEY) throw new Error('Worker has no GOOGLE_API_KEY');
  const g = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': env.GOOGLE_API_KEY,
      // Ask only for name + address to keep each lookup in the cheapest tier that includes addresses
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress',
    },
    body: JSON.stringify({ textQuery: q, regionCode: 'US', pageSize: 5 }),
  });
  if (!g.ok) throw new Error('Google returned ' + g.status);
  const data = await g.json();
  return {
    results: (data.places || []).map(p => ({
      name: (p.displayName && p.displayName.text) || '',
      address: (p.formattedAddress || '').replace(/, USA$/, ''),
    })).filter(r => r.address),
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
  });
}
