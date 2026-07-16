/**
 * Kaylee's Dog Walking Service — website + booking system
 *
 * Runs the whole site: static pages out of /public and a small JSON API
 * for bookings. Bookings persist to data/bookings.json so nothing is
 * lost between restarts.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// Kaylee's schedule passcode. Override with the KAYLEE_PASSCODE env var.
const PASSCODE = process.env.KAYLEE_PASSCODE || 'goldenpaws';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bookings.json');

// ---------------------------------------------------------------------------
// Business rules (single source of truth — the booking form reads these
// from /api/config so the site can never drift from the server).
// ---------------------------------------------------------------------------

const TIME_SLOTS = [
  '7:00 AM',
  '9:00 AM',
  '11:00 AM',
  '1:00 PM',
  '4:00 PM',
  '5:00 PM',
  '6:00 PM',
  '7:00 PM',
];

// Prices in cents, keyed by walk length in minutes.
const PRICES = { 30: 2000, 60: 3500 };

// Neighbour group walk discount, in cents per dog, when two or more dogs
// from the same street book the same time slot.
const NEIGHBOUR_DISCOUNT = 500;

// Kaylee walks at most three dogs at once.
const MAX_DOGS_PER_WALK = 3;

const DOG_SIZES = ['Small (under 25 lb)', 'Medium (25–60 lb)', 'Large (over 60 lb)'];

const STATUS = { BOOKED: 'booked', DONE: 'done', CANCELLED: 'cancelled' };

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

let bookings = [];

function loadBookings() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      bookings = parsed;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Could not read bookings file, starting empty:', err.message);
    }
    bookings = [];
  }
}

function saveBookings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(bookings, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "128 Prestwick Ave SE" -> "prestwick ave se" so neighbours match. */
function normalizeStreet(address) {
  return String(address)
    .toLowerCase()
    .replace(/^[\s#\-\d,.]+/, '') // strip the house number / unit
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nicely cased street name for display, e.g. "Prestwick Ave Se" -> keep raw slice. */
function displayStreet(address) {
  const street = String(address).replace(/^[\s#\-\d,.]+/, '').replace(/\s+/g, ' ').trim();
  return street || String(address).trim();
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** Today as YYYY-MM-DD in the server's local time. */
function todayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function slotIndex(slot) {
  return TIME_SLOTS.indexOf(slot);
}

function walkKey(b) {
  return `${b.date}|${b.slot}|${b.duration}`;
}

function isActive(b) {
  return b.status === STATUS.BOOKED || b.status === STATUS.DONE;
}

function requirePasscode(req, res, next) {
  const supplied = req.get('x-passcode') || req.query.passcode || '';
  if (supplied !== PASSCODE) {
    res.status(401).json({ error: 'Wrong passcode.' });
    return;
  }
  next();
}

/**
 * Build the schedule: group active bookings that share a date, time slot and
 * walk length into a single walk (max three dogs, enforced at booking time),
 * sort the dogs within each walk by street for an efficient route, and price
 * each dog with the neighbour discount applied when two or more dogs in the
 * walk come from the same street.
 */
function buildSchedule() {
  const groups = new Map();
  for (const b of bookings) {
    if (!isActive(b)) continue;
    const key = walkKey(b);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  const walks = [];
  for (const group of groups.values()) {
    const streetCounts = new Map();
    for (const b of group) {
      const street = normalizeStreet(b.address);
      streetCounts.set(street, (streetCounts.get(street) || 0) + 1);
    }

    const dogs = group
      .map((b) => {
        const base = PRICES[b.duration];
        const neighbourGroup = (streetCounts.get(normalizeStreet(b.address)) || 0) >= 2;
        const priceCents = neighbourGroup ? base - NEIGHBOUR_DISCOUNT : base;
        return {
          id: b.id,
          ownerName: b.ownerName,
          dogName: b.dogName,
          dogSize: b.dogSize,
          phone: b.phone,
          address: b.address,
          street: displayStreet(b.address),
          notes: b.notes || '',
          status: b.status,
          priceCents,
          neighbourDiscount: neighbourGroup,
          photoOptOut: !!b.photoOptOut,
        };
      })
      .sort(
        (a, b) =>
          normalizeStreet(a.address).localeCompare(normalizeStreet(b.address)) ||
          a.address.localeCompare(b.address)
      );

    const first = group[0];
    walks.push({
      date: first.date,
      slot: first.slot,
      duration: first.duration,
      status: dogs.every((d) => d.status === STATUS.DONE) ? STATUS.DONE : STATUS.BOOKED,
      dogs,
      totalCents: dogs.reduce((sum, d) => sum + d.priceCents, 0),
    });
  }

  walks.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      slotIndex(a.slot) - slotIndex(b.slot) ||
      a.duration - b.duration
  );

  let earnedCents = 0;
  let upcomingCents = 0;
  let completedWalks = 0;
  let dogsWalked = 0;
  for (const walk of walks) {
    if (walk.status === STATUS.DONE) {
      completedWalks += 1;
    }
    for (const dog of walk.dogs) {
      if (dog.status === STATUS.DONE) {
        earnedCents += dog.priceCents;
        dogsWalked += 1;
      } else {
        upcomingCents += dog.priceCents;
      }
    }
  }

  return {
    walks,
    stats: { earnedCents, upcomingCents, completedWalks, dogsWalked },
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    slots: TIME_SLOTS,
    durations: Object.keys(PRICES).map((minutes) => ({
      minutes: Number(minutes),
      priceCents: PRICES[minutes],
    })),
    neighbourDiscountCents: NEIGHBOUR_DISCOUNT,
    maxDogsPerWalk: MAX_DOGS_PER_WALK,
    dogSizes: DOG_SIZES,
  });
});

app.post('/api/bookings', (req, res) => {
  const body = req.body || {};

  const ownerName = String(body.ownerName || '').trim();
  const dogName = String(body.dogName || '').trim();
  const dogSize = String(body.dogSize || '').trim();
  const phone = String(body.phone || '').trim();
  const address = String(body.address || '').trim();
  const date = String(body.date || '').trim();
  const slot = String(body.slot || '').trim();
  const duration = Number(body.duration);
  const notes = String(body.notes || '').trim().slice(0, 500);
  const waiverAgreed = body.waiverAgreed === true;
  const photoOptOut = body.photoOptOut === true;

  const problems = [];
  if (!ownerName) problems.push('your name');
  if (!dogName) problems.push("your dog's name");
  if (!DOG_SIZES.includes(dogSize)) problems.push("your dog's size");
  if (phone.replace(/\D/g, '').length < 7) problems.push('a phone number');
  if (!address || !normalizeStreet(address)) problems.push('your street address');
  if (!isValidDateString(date)) problems.push('a date');
  if (!TIME_SLOTS.includes(slot)) problems.push('a time slot');
  if (!PRICES[duration]) problems.push('a walk length');

  if (problems.length > 0) {
    res.status(400).json({
      error: `Almost there! Please double-check: ${problems.join(', ')}.`,
    });
    return;
  }

  if (date < todayString()) {
    res.status(400).json({
      error: 'That date has already passed — please pick today or a future date.',
    });
    return;
  }

  if (!waiverAgreed) {
    res.status(400).json({
      error: 'Please check the box agreeing to the terms before booking.',
    });
    return;
  }

  // Kaylee can only be in one place at a time: a slot holds one walk of up
  // to three dogs, and every dog in it walks for the same length.
  const sameSlot = bookings.filter(
    (b) => isActive(b) && b.date === date && b.slot === slot
  );
  if (sameSlot.length >= MAX_DOGS_PER_WALK) {
    res.status(409).json({
      error: `That time is already full — three dogs is my max for one walk! Please pick another slot and I'll see you then.`,
    });
    return;
  }
  const differentLength = sameSlot.find((b) => b.duration !== duration);
  if (differentLength) {
    res.status(409).json({
      error: `That slot already has a ${differentLength.duration}-minute walk booked. Pick the ${differentLength.duration}-minute option to join it, or choose a different time.`,
    });
    return;
  }

  const booking = {
    id: crypto.randomUUID(),
    ownerName,
    dogName,
    dogSize,
    phone,
    address,
    date,
    slot,
    duration,
    notes,
    waiverAgreed,
    photoOptOut,
    status: STATUS.BOOKED,
    createdAt: new Date().toISOString(),
  };

  bookings.push(booking);
  saveBookings();

  const joinedNeighbours = sameSlot.some(
    (b) => normalizeStreet(b.address) === normalizeStreet(address)
  );

  res.status(201).json({
    ok: true,
    id: booking.id,
    neighbourDiscount: joinedNeighbours,
    message: joinedNeighbours
      ? `You're booked — and a neighbour on your street has the same slot, so you both get the group discount!`
      : `You're booked! I'll text ${phone} to confirm.`,
  });
});

app.get('/api/schedule', requirePasscode, (req, res) => {
  res.json(buildSchedule());
});

app.patch('/api/bookings/:id', requirePasscode, (req, res) => {
  const action = String((req.body || {}).action || '');
  if (action !== 'done' && action !== 'cancel') {
    res.status(400).json({ error: 'Action must be "done" or "cancel".' });
    return;
  }

  const booking = bookings.find((b) => b.id === req.params.id);
  if (!booking) {
    res.status(404).json({ error: 'Booking not found.' });
    return;
  }
  if (booking.status === STATUS.CANCELLED) {
    res.status(409).json({ error: 'That booking was already cancelled.' });
    return;
  }

  booking.status = action === 'done' ? STATUS.DONE : STATUS.CANCELLED;
  saveBookings();
  res.json({ ok: true, status: booking.status });
});

// Friendly 404 for unknown API routes (static pages fall through to express.static).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

loadBookings();

app.listen(PORT, () => {
  console.log(`Kaylee's Dog Walking Service is up at http://localhost:${PORT}`);
});
