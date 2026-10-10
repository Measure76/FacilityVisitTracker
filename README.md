# Facility Visit Tracker

A single-page app for planning and logging facility visits.

- **Status** – every facility, sorted by how soon it is due. Drive facilities are due every 6 weeks and fly facilities every 8 weeks (both adjustable). Overdue, due soon, and "due but not scheduled in time" are flagged.
- **Schedule** – plan visits and multi-day team meetings/projects. Each week shows how many visit days are left after the office day (Monday by default) and team events. One click copies a schedule for email or downloads a calendar (.ics) file for managers and facilities.
- **Visit log** – completed visits by date range with addresses, an "entered in Concur" checkbox, and CSV export for expense reconciliation.

## Address lookup

**Fill address** looks up the facility name and fills in the first address it finds. Out of the box it uses OpenStreetMap, which is free but misses many businesses. Google lookups and data storage go through a Cloudflare Worker that holds the Google Places API key, the team passcode and a D1 database (see the comments at the top of [worker/worker.js](worker/worker.js)). The Worker's address is set in `GOOGLE_LOOKUP_URL` at the top of `index.html`; leave it empty to use OpenStreetMap only.

## Your data

Each person signs in with the team passcode and their name. Their tracker is saved automatically to the team server, so it's available on any device and survives a cleared browser. The browser keeps a copy so unsaved changes survive a dropped connection. **Data & settings → Export** saves a copy as a file at any time.

## Hosting on GitHub Pages

1. Create a repository and add `index.html`.
2. Go to **Settings → Pages → Deploy from a branch**, then choose `main` and `/ (root)`.
3. Share the `https://<user>.github.io/<repo>/` link. Each coworker gets their own empty tracker.

You can also just open `index.html` straight from disk.
