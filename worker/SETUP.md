# Google address lookup: setup

The app's **Fill address** button uses OpenStreetMap by default. This guide connects it to Google Places through a small Cloudflare Worker. The Google key lives only in Cloudflare's settings. It never goes in the web page or on GitHub.

```
App (GitHub Pages) ──name──▶ Cloudflare Worker (holds the key) ──▶ Google Places
                  ◀─address─                                     ◀──
```

You need two free accounts: Google Cloud (requires a billing card) and Cloudflare (no card).

---

## Part 1: Google Cloud (about 15 minutes)

1. Go to <https://console.cloud.google.com> and sign in.
2. **Create a project.** Use the project picker at the top of the page → **New project**. Name it something like `facility-visit-tracker`.
3. **Turn on billing.** Go to **Billing** and link a billing account to the project. Google requires this even for usage within the free monthly allowance.
4. **Enable the API.** Go to **APIs & Services → Library**, search for **Places API (New)**, and click **Enable**.
   Choose *Places API (New)*, not the older *Places API*. The Worker uses the new one.
5. **Create the key.** Go to **APIs & Services → Credentials → Create credentials → API key**. Copy it somewhere temporary.
6. **Restrict the key.** Click the key to edit it:
   - **API restrictions** → *Restrict key* → tick only **Places API (New)**.
   - **Application restrictions** → leave as **None**. The calls come from Cloudflare's servers, whose addresses change, and the key is never exposed to browsers anyway.
   - Save.
7. **Cap daily use (your safety net).** Go to **APIs & Services → Places API (New) → Quotas & system limits**. Find the per-day request limit for **Text Search** (the exact wording varies) and set it to **100**. If anything ever went wrong, this caps the damage at 100 lookups a day.
8. **Optional: add a budget alert.** Go to **Billing → Budgets & alerts**. Create a $5 budget that emails you. Note that this only alerts; it doesn't stop charges. The quota in step 7 is what actually stops them.

Pricing: each Fill address click is one Text Search call. Google gives a free monthly allowance per SKU, so check its current Places pricing page for the exact number. A few dozen lookups a month should cost nothing.

---

## Part 2: Cloudflare Worker (about 10 minutes)

1. Sign up at <https://dash.cloudflare.com>. The free plan is fine.
2. Go to **Workers & Pages → Create → Create Worker**. Start from the "Hello World" template.
3. Name it `facility-lookup` and click **Deploy**.
4. Click **Edit code**. Delete everything in the editor, paste in the contents of `worker.js` from this folder, and click **Deploy**.
5. Go back to the Worker → **Settings → Variables and Secrets** and add:

   | Name | Type | Value |
   |---|---|---|
   | `GOOGLE_API_KEY` | **Secret** | the key from Part 1 |
   | `ALLOWED_ORIGINS` | Text | `https://YOURNAME.github.io` |

   `YOURNAME` is your GitHub username. Use only the site address, with no repo path after it. Save and deploy.
6. Copy the Worker's address from its overview page. It looks like `https://facility-lookup.SOMETHING.workers.dev`.

### Test it

In PowerShell, replace the two capitalised parts and run:

```powershell
curl.exe -H "Origin: https://YOURNAME.github.io" "https://facility-lookup.SOMETHING.workers.dev/?q=Puget%20Sound%20Transitional%20Care"
```

You should get back something like `{"results":[{"name":"Puget Sound Transitional Care","address":"…"}]}`.

| You see | Meaning |
|---|---|
| `Origin not allowed` | `ALLOWED_ORIGINS` doesn't match the Origin in the command exactly |
| `Worker has no GOOGLE_API_KEY` | The secret wasn't saved, or wasn't deployed |
| `Google returned 403` | The Places API (New) isn't enabled, billing isn't linked, or the key restriction is wrong |
| `Google returned 429` | You hit the daily cap from step 7 |

---

## Part 3: Point the app at it

At the top of the script in `index.html`, set:

```js
const GOOGLE_LOOKUP_URL = 'https://facility-lookup.SOMETHING.workers.dev';
```

From then on, **Fill address** tries Google first and falls back to OpenStreetMap if Google finds nothing or can't be reached.

**Testing from `index.html` opened straight from disk:** browsers send the origin `null` for local files. Temporarily set `ALLOWED_ORIGINS` to `https://YOURNAME.github.io,null`, then remove `,null` once you're done testing.

The Worker address isn't secret, so it's fine for it to be in the public page. The Worker only answers requests from your site. Someone determined could still fake that, which is why the daily cap in Google is there as the backstop.
