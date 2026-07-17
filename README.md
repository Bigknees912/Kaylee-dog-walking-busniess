# Kaylee's Dog Walking Service 🐾

Website and booking system for Kaylee's dog walking business in McKenzie Towne, Calgary.

## Running it

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

## What's inside

- **Home** — hero ("Your dog's new best friend"), trust row, how it works
- **About** — Kaylee's bio
- **Services** — 30 min / $20, 60 min / $35, neighbour group walk discount ($5 off per dog when two or more dogs from the same street book the same time slot)
- **Reviews** — sample testimonial cards, clearly marked as placeholders
- **Book a walk** (`/book.html`) — clients enter owner name, dog name, dog size, phone, street address, date, time slot and walk length
- **Kaylee's schedule** (`/schedule.html`) — passcode-protected view that groups bookings at the same date, time and duration into walks of up to three dogs, sorted by street for an efficient route. Kaylee can mark walks done or cancel them, and sees running earnings and completed-walk counts.

## Kaylee's passcode

The schedule passcode defaults to **`goldenpaws`**. Change it by setting an
environment variable before starting the server:

```bash
KAYLEE_PASSCODE=your-secret npm start
```

## Where bookings live

Bookings are saved to `data/bookings.json` (created automatically, not
committed to git). Back that file up if you move the site to a new machine.
The whole `data/` folder is gitignored — it also holds client accounts
(`accounts.json`) and login sessions (`sessions.json`), which contain
password hashes and session tokens and must never be committed.

## Client accounts & login

Clients can create an account at `/account.html` and, once logged in, manage:

- **Account settings** — name, phone, address, and password.
- **Dog profiles** — add multiple dogs (name, breed, age, size, photo,
  behaviour notes, vet contact, allergies); these autofill at booking time.
- **Bookings** — their own upcoming and past walks, pulled automatically.

Authentication is real, not a front-end trick: passwords are hashed with
scrypt, sessions are random tokens stored server-side (only their SHA-256
hash is persisted) and delivered as `HttpOnly`, `SameSite=Lax` cookies that
survive restarts and work across devices. Failed logins and signups are
rate-limited per IP.

### Google sign-in (optional)

"Continue with Google" stays hidden until you configure OAuth. To turn it on:

1. In the [Google Cloud console](https://console.cloud.google.com/), create an
   OAuth 2.0 Client ID (type: Web application).
2. Set the authorized redirect URI to
   `https://YOUR-DOMAIN/api/auth/google/callback`.
3. Set these environment variables on your host:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `BASE_URL` — your deployed origin, e.g. `https://kaylees-dog-walking.onrender.com`

Google sign-in needs a deployed HTTPS origin to work — it can't run on plain
`localhost`. Email + password sign-in works everywhere with no setup.

### Password reset

Clients can request a reset link from the login screen. Tokens are single-use,
stored hashed, and expire after 1 hour; a successful reset signs the account
out everywhere. Because no email provider is connected yet, the reset email is
queued into the dashboard's **Messages** tab — Kaylee copies the link and
texts it to the client. Once an email provider is wired into the email queue,
delivery becomes automatic with no code changes to this flow.

## Google Calendar sync (Kaylee's dashboard)

The dashboard's Calendar tab can connect to Kaylee's real Google Calendar:

- Every new booking (online or manually added) creates a calendar event with
  the dog's name, owner, phone, address, and duration.
- Marking a walk **done** updates the event (✓ prefix); **cancelling** removes it.
- **Sync now** pulls changes back the other way: deleting an event in Google
  Calendar cancels the walk here, and moving an event moves the booking — if
  the new time maps to a valid free slot; otherwise the app's time wins and
  the event is pushed back.

Setup (same Google Cloud project as sign-in):

1. Enable the **Google Calendar API** on the project.
2. On the OAuth client, add a second authorized redirect URI:
   `https://YOUR-DOMAIN/api/gcal/callback`.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `BASE_URL` (as for
   sign-in). Then open the dashboard → Calendar tab → **Connect Google
   Calendar** and approve access.

The refresh token lives in `data/gcal.json` (gitignored). Until the
credentials are configured, the Calendar tab says so plainly — nothing is
faked.

## Admin extras

- **Add a walk manually** (List tab) — for phone or in-person bookings; same
  capacity/overlap rules as the public form, marked `source: manual-admin`,
  and flagged to cover the waiver in person.
- **Add a client manually** (Clients tab) — for people met at the park who
  haven't booked yet.
- **Dog-profile change alerts** — when a client adds, edits, or removes a dog
  in their account, a note appears in the Messages tab so Kaylee sees changes
  without checking manually.
- **Pause account** — clients going away can pause from their account page;
  they keep all history, show as "⏸ paused" in the CRM and email lists, and
  automatically un-pause the next time they book.

## Business rules baked into the server

- Prices: 30 min = $20, 60 min = $35 (`PRICES` in `server.js`)
- Neighbour group discount: $5 off per dog, applied automatically when two or
  more dogs from the same street share a time slot
- Max three dogs per walk; a shared slot only accepts one walk length
- Bookings can't be made for past dates

## Marketing materials (print at home)

With the server running, open these pages and hit Print (margins: Default,
scale: 100%):

- `/print/business-cards.html` — a letter-size sheet of 10 business cards.
  Cut along the dashed lines.
- `/print/poster.html` — a letter-size tear-off poster with 8 phone-number
  tabs. Snip between the tabs so they tear easily.

Both pieces carry a QR code (`public/img/qr-site.svg`) that points to
`https://kaylees-dog-walking.onrender.com/` — the address the site gets when
deployed with the included `render.yaml`. If you deploy somewhere else or buy
a custom domain, regenerate the QR code for the new address (e.g. with the
`qrcode` npm package: `npx qrcode -t svg -o public/img/qr-site.svg "https://your-domain.com/"`).

Tip from the marketing plan: as soon as there's a real photo of Kaylee with a
dog, swap it into the round photo slot on the poster — a real person beats a
logo.

## Deploying so the QR code works

1. Push this repo to GitHub (already done if you're reading this there).
2. Sign in at [render.com](https://render.com) → **New** → **Blueprint** →
   connect this repo → **Apply**. The included `render.yaml` names the service
   `kaylees-dog-walking`, which gives it the URL above.
3. Set `KAYLEE_PASSCODE` when prompted (don't use the default).
4. Free plan note: bookings reset when the service restarts. For permanent
   storage, use the starter plan and uncomment the disk section in
   `render.yaml`.

To use a custom domain later (e.g. `kayleesdogwalking.ca`), buy it at any
registrar, add it under the Render service's **Settings → Custom Domains**,
and point the DNS `CNAME` where Render tells you. Then regenerate the QR code
and reprint.
