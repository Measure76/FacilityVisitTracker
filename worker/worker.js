// Cloudflare Worker: the Facility Visit Tracker's server.
//   - Stores each person's tracker data in a D1 database, keyed by their name
//   - Looks up facility addresses with Google Places
// When TEAM_PASSCODE is set, everything requires it; when it isn't, the server is open.
// Secrets live only in Cloudflare, never in the web page or on GitHub.
//
// Settings (Cloudflare → Worker → Settings):
//   GOOGLE_API_KEY   Secret       Google Places API (New) key
//   TEAM_PASSCODE    Secret       Optional. Passcode everyone enters once per browser
//   ALLOWED_ORIGINS  Text         Comma-separated sites allowed to call this, e.g. https://yourname.github.io
//                                 (add "null" temporarily to test from index.html opened straight from disk)
//   DB               D1 binding   The database; tables are created automatically on first use
//
// Routes (all need header X-Team-Passcode when a passcode is set):
//   GET  /users              → {users:[{name, updatedAt}]}
//   GET  /data?user=NAME     → {name, data, version}   (404 if no such user)
//   PUT  /data?user=NAME     body {data, baseVersion}  → {version}   (409 + {data, version} if changed elsewhere)
//   GET  /lookup?q=TEXT      → {results:[{name, address}]}

const MAX_FAILS_PER_IP = 10;     // wrong passcodes per IP per hour before locking that IP out
const MAX_FAILS_TOTAL = 300;     // wrong passcodes per hour from everyone before locking everyone out
const MAX_DATA_BYTES = 1500000;

let schemaReady = false;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Team-Passcode',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (!allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const send = (body, status) => json(body, status || 200, cors);

    try {
      if (!env.DB) return send({ error: 'Worker has no DB binding' }, 500);
      await ensureSchema(env.DB);

      const auth = await checkPasscode(request, env);
      if (auth === 'locked') return send({ error: 'Too many wrong passcodes. Try again in an hour.' }, 429);
      if (auth !== 'ok') return send({ error: 'Wrong passcode' }, 401);

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (path === '/users' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT name, updated_at FROM users ORDER BY name COLLATE NOCASE').all();
        return send({ users: results.map(r => ({ name: r.name, updatedAt: r.updated_at })) });
      }

      if (path === '/data') {
        const name = cleanName(url.searchParams.get('user'));
        if (!name) return send({ error: 'Missing or invalid user name' }, 400);
        const key = name.toLowerCase();

        if (request.method === 'GET') {
          const row = await env.DB.prepare('SELECT name, data, version FROM users WHERE name_key = ?').bind(key).first();
          if (!row) return send({ error: 'No such user' }, 404);
          return send({ name: row.name, data: JSON.parse(row.data), version: row.version });
        }

        if (request.method === 'PUT') {
          const body = await request.json().catch(() => null);
          if (!body || typeof body.data !== 'object' || !Number.isInteger(body.baseVersion))
            return send({ error: 'Body must be {data, baseVersion}' }, 400);
          const text = JSON.stringify(body.data);
          if (text.length > MAX_DATA_BYTES) return send({ error: 'Data too large' }, 413);
          const now = new Date().toISOString();

          // Optimistic concurrency: only write if nobody else saved since this device last loaded.
          const res = body.baseVersion === 0
            ? await env.DB.prepare('INSERT INTO users (name_key, name, data, version, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(name_key) DO NOTHING')
                .bind(key, name, text, now).run()
            : await env.DB.prepare('UPDATE users SET data = ?, version = version + 1, updated_at = ? WHERE name_key = ? AND version = ?')
                .bind(text, now, key, body.baseVersion).run();

          if (res.meta.changes === 1) return send({ version: body.baseVersion + 1 });
          const row = await env.DB.prepare('SELECT data, version FROM users WHERE name_key = ?').bind(key).first();
          if (!row) return send({ error: 'No such user' }, 404);
          return send({ error: 'Changed on another device', data: JSON.parse(row.data), version: row.version }, 409);
        }
      }

      // "/" kept for the original lookup-only version of the app
      if ((path === '/lookup' || path === '/') && request.method === 'GET') {
        return send(await lookup(url.searchParams.get('q'), env));
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
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      name_key TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL,
      version INTEGER NOT NULL, updated_at TEXT NOT NULL)`),
    db.prepare('CREATE TABLE IF NOT EXISTS auth_fail (ip TEXT NOT NULL, ts INTEGER NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS auth_fail_ts ON auth_fail (ts)'),
  ]);
  schemaReady = true;
}

// Returns 'ok', 'bad' or 'locked'. Lockout is checked even for a correct passcode,
// otherwise a locked-out guesser would still learn when they hit the right one.
async function checkPasscode(request, env) {
  if (!env.TEAM_PASSCODE) return 'ok';
  const given = request.headers.get('X-Team-Passcode') || '';
  if (!given) return 'bad';   // nothing entered yet; not a guess, so don't count it
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const hourAgo = Date.now() - 3600000;
  const counts = await env.DB.prepare(
    'SELECT SUM(ip = ?) AS mine, COUNT(*) AS total FROM auth_fail WHERE ts > ?').bind(ip, hourAgo).first();
  if ((counts.mine || 0) >= MAX_FAILS_PER_IP || (counts.total || 0) >= MAX_FAILS_TOTAL) return 'locked';

  if (sameText(given, env.TEAM_PASSCODE)) return 'ok';

  await env.DB.batch([
    env.DB.prepare('INSERT INTO auth_fail (ip, ts) VALUES (?, ?)').bind(ip, Date.now()),
    env.DB.prepare('DELETE FROM auth_fail WHERE ts < ?').bind(Date.now() - 86400000),   // keep the table small
  ]);
  return 'bad';
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cleanName(s) {
  const name = (s || '').trim().replace(/\s+/g, ' ');
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
