// Cloudflare Worker: looks up a facility name with Google Places and returns addresses.
// The Google key lives only in this Worker's settings (GOOGLE_API_KEY secret), never in the web page.
//
// Settings (Cloudflare → Worker → Settings → Variables and Secrets):
//   GOOGLE_API_KEY   Secret  Your Google Places API key
//   ALLOWED_ORIGINS  Text    Comma-separated sites allowed to use this, e.g. https://yourname.github.io
//                            Add "null" temporarily to test from index.html opened straight from disk.
//
// Request:  GET https://<worker>.workers.dev/?q=Puget%20Sound%20Transitional%20Care
// Response: {"results":[{"name":"...","address":"..."}]}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET',
      'Vary': 'Origin',
    };

    if (!allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return json({ error: 'Use GET' }, 405, cors);

    const q = (new URL(request.url).searchParams.get('q') || '').trim().slice(0, 200);
    if (!q) return json({ error: 'Missing q' }, 400, cors);
    if (!env.GOOGLE_API_KEY) return json({ error: 'Worker has no GOOGLE_API_KEY' }, 500, cors);

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
    if (!g.ok) return json({ error: 'Google returned ' + g.status }, 502, cors);

    const data = await g.json();
    const results = (data.places || []).map(p => ({
      name: (p.displayName && p.displayName.text) || '',
      address: (p.formattedAddress || '').replace(/, USA$/, ''),
    })).filter(r => r.address);
    return json({ results }, 200, cors);
  },
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
  });
}
