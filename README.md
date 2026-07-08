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

## Business rules baked into the server

- Prices: 30 min = $20, 60 min = $35 (`PRICES` in `server.js`)
- Neighbour group discount: $5 off per dog, applied automatically when two or
  more dogs from the same street share a time slot
- Max three dogs per walk; a shared slot only accepts one walk length
- Bookings can't be made for past dates
