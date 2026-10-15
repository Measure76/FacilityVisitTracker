# Facility Visit Tracker

A single-page app for planning and logging facility visits.

- **Schedule** – the tab the app opens on. A Sunday-to-Saturday calendar (narrow weekends, office days and team holidays marked). The sidebar lists every facility, soonest due first (a booking counts as a visit); drag one onto a day to book it. Anything placed by hand is solid and locked to its day; drag it back onto the sidebar (it says *Drop here to clear the day* while you drag) to clear the day. Several facilities can share a day: drop one onto another visit to put it above or below it, and the day's stops are numbered in driving order, carried through to the email, Visit log and CSV (a **Stop** column) for Concur mileage. Only the top facility on a day counts toward its rotation; the stops after it are quick stops (drawn lighter, tagged in the Visit log) that count for mileage but don't reset a due date. Drag a stop to the top to make it the visit. An ancillary facility on top doesn't take the slot. **Fill next 4 weeks** fills the open days through the email's four tentative weeks with gray dashed tentative entries, earliest-due first, redoing any earlier gray ones; click one to lock it, or **Lock all** to lock them all. A count by **Copy for email** says how many gray entries the email would leave out. Gray entries stay out of the email, .ics, log and visit history, and vanish once their day passes. Team meeting/project, PTO, Bank Day and Travel Day buttons sit above the calendar (Bank Days show as PTO in the email and .ics), or tap it and then tap a day on a phone; drag anything on the calendar to move it. Each week shows how many visit days are left. One click copies the schedule for email or downloads a calendar (.ics) file. **Phone calendar** makes a private link, shown as a QR code, that a phone's calendar app subscribes to; it serves the same entries as the .ics from the last 60 days on, straight from the saved tracker, so it keeps itself up to date. **New link** replaces it and **Turn off** removes it.
- **Status** – every facility, sorted by how soon it is due. Drive facilities are due every 6 weeks and fly facilities every 8 weeks (both adjustable). Overdue, due soon, and "due but not scheduled in time" are flagged.
- **Facilities** – each has a nickname (shown on the calendar and lists) and an optional business name used to look up its address. **Add Facilities** takes a list of nicknames, one per line; tap a facility to add its business name and address, or to change anything else.
- **Trips** – facilities always visited together on set weekdays, with travel days (e.g. Tue Park Manor → Wed Travel Day). Fill keeps a trip together and starts it on its usual weekday; drag a trip onto the calendar, or click a gray one, to lock every day at once. A bar with the trip's name runs across its days on the calendar (striped while gray) wherever every one of its days is in place; moving one day off by hand breaks the link.
- **Tutorial** – four setup steps: add facilities, record last month's visits, build the schedule, and set up trips.
- **Visit log** – completed visits by date range with addresses, an "entered in Concur" checkbox, and CSV export for expense reconciliation.

## Address lookup

**Fill address** looks up the facility name and fills in the first address it finds, using Google Places and falling back to OpenStreetMap.

## Server

Accounts, data storage and Google lookups go through a Cloudflare Worker ([worker/worker.js](worker/worker.js)), which holds the Google Places API key, the team code, the PIN pepper and a D1 database. The comments at the top of that file list its settings. The Worker's address is set in `SERVER_URL` at the top of `index.html`.

## Accounts

Each person signs in with their 9-digit employee ID and a 4-digit PIN they choose. A browser that isn't signed in first asks for the company name (the Worker's `TEAM_CODE`, matched loosely so "The Ensign Group" works); once answered, that browser goes straight to sign-in from then on. A browser stays signed in until **Sign out** or until its site data is cleared; **Data & settings** has **Change PIN** and **Sign out everywhere**.

Five wrong PINs lock that employee ID for 15 minutes, and 20 wrong tries from one network lock that network for an hour.

**Admins** get an **Admin** tab listing every account. From there they can:
- **Reset PIN** – signs the person out everywhere and shows a one-time 6-digit code (valid 24 hours) to pass on. The person taps "enter it here" under *Forgot your PIN?* and chooses a new PIN.
- **History** – each person's last 50 saves, with who made them. **Restore** puts a tracker back to an earlier save without touching anyone else's.
- **Make admin / Remove admin** and **Delete** for other accounts.

## Your data

Each tracker is saved automatically to the team server, so it's available on any device and survives a cleared browser. The browser keeps a copy so unsaved changes survive a dropped connection. **Data & settings → Export** saves a copy as a file at any time.

## Hosting on the Worker

The Worker also serves the app itself at `https://facility-lookup.measure-717.workers.dev/`, for networks that block github.io. `index.html` is bundled into the Worker when it's deployed, so **any change to `index.html` needs `npx wrangler@4 deploy` from the `worker` folder** as well as a push, or the Worker keeps serving the old page. Calls from that page are same-origin, so it needs no `ALLOWED_ORIGINS` entry.

## Hosting on GitHub Pages

1. Create a repository and add `index.html`.
2. Go to **Settings → Pages → Deploy from a branch**, then choose `main` and `/ (root)`.
3. Add `https://<user>.github.io` to the Worker's `ALLOWED_ORIGINS`, then share the `https://<user>.github.io/<repo>/` link.

