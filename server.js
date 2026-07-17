/**
 * Kaylee's Dog Walking Service — website + booking system
 *
 * Runs the whole site: static pages out of /public and a JSON API for
 * bookings, returning clients, referral credits, payment preferences,
 * a notification log, and a lightweight CRM with email templates.
 * Everything persists to JSON files under DATA_DIR so nothing is lost
 * between restarts.
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
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');
const EMAIL_TEMPLATES_FILE = path.join(DATA_DIR, 'email-templates.json');
const EMAIL_LOG_FILE = path.join(DATA_DIR, 'email-log.json');

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

// Referral credit, in cents, given to BOTH the new client and the referrer
// when a valid referral code is used ("$10 credit for both sides").
const REFERRAL_CREDIT = 1000;

// Kaylee walks at most three dogs at once.
const MAX_DOGS_PER_WALK = 3;

const DOG_SIZES = ['Small (under 25 lb)', 'Medium (25–60 lb)', 'Large (over 60 lb)'];

const STATUS = { BOOKED: 'booked', DONE: 'done', CANCELLED: 'cancelled' };

const PAYMENT_METHOD_LABELS = {
  etransfer: 'e-Transfer',
  cash: 'Cash',
  stripe: 'Card (Stripe)',
};

const REGULAR_AFTER_WALKS = 3;

// ---------------------------------------------------------------------------
// Storage — one small JSON file per collection, written atomically.
// ---------------------------------------------------------------------------

let bookings = [];
let clients = [];
let settings = { paymentMethods: { etransfer: true, cash: true, stripe: false } };
let notifications = [];
let emailTemplates = [];
let emailLog = [];

function makeStore(file, initial) {
  return {
    load() {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error(`Could not read ${path.basename(file)}, starting fresh:`, err.message);
        }
        return initial;
      }
    },
    save(data) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    },
  };
}

const bookingsStore = makeStore(DATA_FILE, []);
const clientsStore = makeStore(CLIENTS_FILE, []);
const settingsStore = makeStore(SETTINGS_FILE, settings);
const notificationsStore = makeStore(NOTIFICATIONS_FILE, []);
const emailTemplatesStore = makeStore(EMAIL_TEMPLATES_FILE, []);
const emailLogStore = makeStore(EMAIL_LOG_FILE, []);

function saveBookings() { bookingsStore.save(bookings); }
function saveClients() { clientsStore.save(clients); }
function saveSettings() { settingsStore.save(settings); }
function saveNotifications() { notificationsStore.save(notifications); }
function saveEmailTemplates() { emailTemplatesStore.save(emailTemplates); }
function saveEmailLog() { emailLogStore.save(emailLog); }

const DEFAULT_EMAIL_TEMPLATES = [
  {
    id: 'welcome',
    name: 'Welcome message',
    subject: "Welcome to Kaylee's Dog Walking Service!",
    body:
      "Hi {{ownerName}},\n\nThanks so much for booking with Kaylee's Dog Walking Service! " +
      "{{dogName}} is officially on the schedule and I can't wait to meet them.\n\n" +
      "A few quick notes: I'll text a photo after every walk, and if you ever have a " +
      "neighbour who wants to join a slot, you both get a discount.\n\n" +
      "See you soon!\nKaylee",
  },
  {
    id: 'walk-confirmation',
    name: 'Walk confirmation',
    subject: 'Your walk with {{dogName}} is confirmed',
    body:
      "Hi {{ownerName}},\n\nJust confirming {{dogName}}'s walk on {{date}} at {{slot}}. " +
      "I'll pick up right at your door and text a photo when we're done.\n\n" +
      "See you then!\nKaylee",
  },
  {
    id: 'monthly-promo',
    name: 'Monthly promotion',
    subject: 'A little something for {{dogName}} this month',
    body:
      "Hi {{ownerName}},\n\nHope {{dogName}} has been loving the walks! Just a heads up — " +
      "if you refer a neighbour this month, you both get a $10 credit once they book their " +
      "first walk. Their referral code is your name + the last 4 digits of your phone " +
      "number: {{referralCode}}.\n\nThanks for being part of the pack!\nKaylee",
  },
];

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

function normalizePhone(phone) {
  return String(phone).replace(/\D/g, '');
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

/** "6:00 PM" -> 1080 (minutes since midnight), for overlap math. */
function slotToMinutes(slot) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(slot).trim());
  if (!m) return null;
  let hours = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) hours += 12;
  return hours * 60 + Number(m[2]);
}

function walkKey(b) {
  return `${b.date}|${b.slot}|${b.duration}`;
}

function isActive(b) {
  return b.status === STATUS.BOOKED || b.status === STATUS.DONE;
}

// ---------------------------------------------------------------------------
// Minimal in-memory rate limiting — protects the passcode gate from brute
// force and the public client-lookup endpoint from phone-number enumeration.
// Resets on server restart; that's fine for a single-operator local site.
// ---------------------------------------------------------------------------

const rateBuckets = new Map();

function clientIp(req) {
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

function underRateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  rateBuckets.set(key, hits);
  return hits.length <= max;
}

function requirePasscode(req, res, next) {
  const supplied = req.get('x-passcode') || req.query.passcode || '';
  if (supplied !== PASSCODE) {
    if (!underRateLimit('passcode-fail:' + clientIp(req), 20, 15 * 60 * 1000)) {
      res.status(429).json({ error: 'Too many attempts — please wait a few minutes and try again.' });
      return;
    }
    res.status(401).json({ error: 'Wrong passcode.' });
    return;
  }
  next();
}

/** First name, letters only, uppercased — for referral codes. */
function firstNameSlug(name) {
  const first = String(name).trim().split(/\s+/)[0] || 'FRIEND';
  return first.replace(/[^a-zA-Z]/g, '').toUpperCase() || 'FRIEND';
}

function generateReferralCode(ownerName, phone) {
  const base = firstNameSlug(ownerName) + normalizePhone(phone).slice(-4);
  let code = base;
  let n = 1;
  const existing = new Set(clients.map((c) => c.referralCode));
  while (existing.has(code)) {
    n += 1;
    code = base + n;
  }
  return code;
}

function findClientByPhone(phone) {
  const key = normalizePhone(phone);
  return clients.find((c) => c.normalizedPhone === key);
}

/**
 * Create or refresh a client profile from a booking, applying referral
 * credit on both sides when a valid, non-self referral code is supplied.
 * Returns { client, referralDiscountCents }.
 */
function upsertClientForBooking({ ownerName, dogName, dogSize, phone, email, address, dogBirthday, referralCode }) {
  const key = normalizePhone(phone);
  let client = clients.find((c) => c.normalizedPhone === key);
  let referralDiscountCents = 0;

  if (!client) {
    client = {
      id: crypto.randomUUID(),
      normalizedPhone: key,
      phone,
      email: email || '',
      ownerName,
      dogName,
      dogSize,
      address,
      dogBirthday: dogBirthday || '',
      notes: '',
      tags: ['new'],
      referralCode: generateReferralCode(ownerName, phone),
      referredByClientId: null,
      pendingCreditCents: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    clients.push(client);
  } else {
    client.ownerName = ownerName;
    client.dogName = dogName;
    client.dogSize = dogSize;
    client.address = address;
    client.phone = phone;
    if (email) client.email = email;
    if (dogBirthday) client.dogBirthday = dogBirthday;
    client.updatedAt = new Date().toISOString();
  }

  const suppliedCode = String(referralCode || '').trim().toUpperCase();
  if (suppliedCode && !client.referredByClientId) {
    const referrer = clients.find(
      (c) => c.referralCode === suppliedCode && c.id !== client.id
    );
    if (referrer) {
      referralDiscountCents = REFERRAL_CREDIT;
      client.referredByClientId = referrer.id;
      if (!client.tags.includes('referred')) client.tags.push('referred');
      referrer.pendingCreditCents = (referrer.pendingCreditCents || 0) + REFERRAL_CREDIT;
      referrer.updatedAt = new Date().toISOString();
    }
  }

  saveClients();
  return { client, referralDiscountCents };
}

/** Auto-tag "regular" once a client has enough completed walks. Manual tags are left alone. */
function refreshRegularTag(client) {
  const doneCount = bookings.filter(
    (b) => b.normalizedPhone === client.normalizedPhone && b.status === STATUS.DONE
  ).length;
  if (doneCount >= REGULAR_AFTER_WALKS && !client.tags.includes('regular')) {
    client.tags.push('regular');
    client.updatedAt = new Date().toISOString();
    saveClients();
  }
}

function fillTemplate(text, vars) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m
  );
}

function queueNotification({ bookingId, type, to, message, scheduledFor }) {
  const note = {
    id: crypto.randomUUID(),
    bookingId,
    type, // 'confirmation' | 'reminder'
    to,
    message,
    scheduledFor,
    status: 'queued', // never becomes "sent" until a real provider is wired in
    createdAt: new Date().toISOString(),
  };
  notifications.push(note);
  saveNotifications();
  return note;
}

/** 8am the morning of the walk, in server-local time, as an ISO string. */
function reminderTimeFor(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  return new Date(y, m - 1, d, 8, 0, 0).toISOString();
}

/**
 * Build the schedule: group active bookings that share a date, time slot and
 * walk length into a single walk (max three dogs, enforced at booking time),
 * sort the dogs within each walk by street for an efficient route, and price
 * each dog with the neighbour discount and any referral credit applied.
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
        const priceCents = Math.max(
          0,
          base - (neighbourGroup ? NEIGHBOUR_DISCOUNT : 0) - (b.referralDiscountCents || 0)
        );
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
          referralDiscount: !!b.referralDiscountCents,
          photoConsent: b.photoConsent !== false,
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

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const isoOf = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const weekStartIso = isoOf(weekStart);
  const monthStartIso = isoOf(monthStart);

  let walksThisWeek = 0;
  let earnedThisWeekCents = 0;
  let walksThisMonth = 0;
  let earnedThisMonthCents = 0;

  for (const walk of walks) {
    if (walk.status === STATUS.DONE) {
      completedWalks += 1;
    }
    const inThisWeek = walk.date >= weekStartIso;
    const inThisMonth = walk.date >= monthStartIso;
    if (inThisWeek) walksThisWeek += 1;
    if (inThisMonth) walksThisMonth += 1;

    for (const dog of walk.dogs) {
      if (dog.status === STATUS.DONE) {
        earnedCents += dog.priceCents;
        dogsWalked += 1;
        if (inThisWeek) earnedThisWeekCents += dog.priceCents;
        if (inThisMonth) earnedThisMonthCents += dog.priceCents;
      } else {
        upcomingCents += dog.priceCents;
      }
    }
  }

  return {
    walks,
    stats: {
      earnedCents,
      upcomingCents,
      completedWalks,
      dogsWalked,
      walksThisWeek,
      earnedThisWeekCents,
      walksThisMonth,
      earnedThisMonthCents,
    },
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  const activeMethods = Object.entries(settings.paymentMethods)
    .filter(([, on]) => on)
    .map(([key]) => ({ key, label: PAYMENT_METHOD_LABELS[key] || key }));

  res.json({
    slots: TIME_SLOTS,
    durations: Object.keys(PRICES).map((minutes) => ({
      minutes: Number(minutes),
      priceCents: PRICES[minutes],
    })),
    neighbourDiscountCents: NEIGHBOUR_DISCOUNT,
    referralCreditCents: REFERRAL_CREDIT,
    maxDogsPerWalk: MAX_DOGS_PER_WALK,
    dogSizes: DOG_SIZES,
    paymentMethods: activeMethods,
  });
});

// Returning-client lookup so the booking form can autofill dog details.
// Only returns booking-relevant fields — never notes, tags or credit balance.
// Rate-limited per IP so this can't be used to enumerate other clients'
// names and addresses by guessing phone numbers.
app.get('/api/clients/lookup', (req, res) => {
  if (!underRateLimit('lookup:' + clientIp(req), 30, 10 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many lookups — please wait a bit and try again.' });
    return;
  }
  const phone = String(req.query.phone || '');
  if (normalizePhone(phone).length < 7) {
    res.json({ found: false });
    return;
  }
  const client = findClientByPhone(phone);
  if (!client) {
    res.json({ found: false });
    return;
  }
  res.json({
    found: true,
    ownerName: client.ownerName,
    dogName: client.dogName,
    dogSize: client.dogSize,
    address: client.address,
    email: client.email || '',
    dogBirthday: client.dogBirthday || '',
  });
});

app.post('/api/bookings', (req, res) => {
  const body = req.body || {};

  const ownerName = String(body.ownerName || '').trim();
  const dogName = String(body.dogName || '').trim();
  const dogSize = String(body.dogSize || '').trim();
  const phone = String(body.phone || '').trim();
  const email = String(body.email || '').trim().slice(0, 200);
  const address = String(body.address || '').trim();
  const date = String(body.date || '').trim();
  const slot = String(body.slot || '').trim();
  const duration = Number(body.duration);
  const notes = String(body.notes || '').trim().slice(0, 500);
  const dogBirthday = String(body.dogBirthday || '').trim().slice(0, 60);
  const referralCode = String(body.referralCode || '').trim();
  const vaccinatedAgreed = body.vaccinatedAgreed === true;
  const waiverAgreed = body.waiverAgreed === true;
  const photoConsent = body.photoConsent !== false; // opt-out checkbox; default true

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

  if (!vaccinatedAgreed || !waiverAgreed) {
    res.status(400).json({
      error: 'Please check both required boxes (vaccination/temperament and the waiver) before booking.',
    });
    return;
  }

  // Guard against duplicate submissions (double-click, a retried request, or
  // an intentional repeat) — the same dog can't book the identical slot twice.
  const duplicate = bookings.find(
    (b) =>
      isActive(b) &&
      b.date === date &&
      b.slot === slot &&
      b.normalizedPhone === normalizePhone(phone)
  );
  if (duplicate) {
    res.status(409).json({
      error: `Looks like ${dogName} is already booked for ${date} at ${slot}. If you need to change something, text Kaylee at 587-433-2199.`,
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

  // A walk's actual duration can run into the next slot (e.g. a 60-minute
  // walk at 6:00 PM runs until 7:00 PM) — block anything that would put
  // Kaylee in two places at once, even across different walk groups.
  const newStart = slotToMinutes(slot);
  const newEnd = newStart + duration;
  const otherWalksOnDate = new Map();
  for (const b of bookings) {
    if (!isActive(b) || b.date !== date) continue;
    otherWalksOnDate.set(walkKey(b), b);
  }
  for (const other of otherWalksOnDate.values()) {
    if (other.slot === slot && other.duration === duration) continue; // same walk group, already handled above
    const otherStart = slotToMinutes(other.slot);
    const otherEnd = otherStart + other.duration;
    if (otherStart === null || newStart === null) continue;
    if (newStart < otherEnd && otherStart < newEnd) {
      res.status(409).json({
        error: `That overlaps with a walk already booked at ${other.slot} (${other.duration} min) — Kaylee can't be two places at once! Please pick a time that doesn't overlap.`,
      });
      return;
    }
  }

  let referralDiscountCents = 0;
  let referralApplied = false;
  if (referralCode) {
    const match = clients.find(
      (c) => c.referralCode === referralCode.toUpperCase() && c.normalizedPhone !== normalizePhone(phone)
    );
    if (!match) {
      res.status(400).json({ error: `"${referralCode}" isn't a code I recognize — double-check it, or leave it blank.` });
      return;
    }
  }

  const booking = {
    id: crypto.randomUUID(),
    ownerName,
    dogName,
    dogSize,
    phone,
    email,
    normalizedPhone: normalizePhone(phone),
    address,
    date,
    slot,
    duration,
    notes,
    dogBirthday,
    vaccinatedAgreed,
    waiverAgreed,
    waiverAgreedAt: new Date().toISOString(),
    photoConsent,
    referralCodeUsed: referralCode || null,
    referralDiscountCents: 0,
    status: STATUS.BOOKED,
    createdAt: new Date().toISOString(),
  };

  const { client, referralDiscountCents: creditCents } = upsertClientForBooking({
    ownerName,
    dogName,
    dogSize,
    phone,
    email,
    address,
    dogBirthday,
    referralCode,
  });
  booking.referralDiscountCents = creditCents;
  referralDiscountCents = creditCents;
  referralApplied = creditCents > 0;

  bookings.push(booking);
  saveBookings();

  const joinedNeighbours = sameSlot.some(
    (b) => normalizeStreet(b.address) === normalizeStreet(address)
  );

  const activePaymentMethods = Object.entries(settings.paymentMethods)
    .filter(([, on]) => on)
    .map(([key]) => PAYMENT_METHOD_LABELS[key] || key);

  const confirmationLines = [
    `Hi ${ownerName}, ${dogName}'s walk is booked for ${date} at ${slot} (${duration} min).`,
  ];
  if (joinedNeighbours) confirmationLines.push('A neighbour on your street joined the same slot, so you both get $5 off!');
  if (referralApplied) confirmationLines.push(`Your referral code was applied — $${(referralDiscountCents / 100).toFixed(0)} off this walk.`);
  if (activePaymentMethods.length) confirmationLines.push(`Payment accepted: ${activePaymentMethods.join(', ')}.`);
  confirmationLines.push("I'll text a photo after the walk!");

  queueNotification({
    bookingId: booking.id,
    type: 'confirmation',
    to: phone,
    message: confirmationLines.join(' '),
    scheduledFor: booking.createdAt,
  });
  queueNotification({
    bookingId: booking.id,
    type: 'reminder',
    to: phone,
    message: `Hi ${ownerName}, just a reminder — ${dogName}'s walk with Kaylee is today at ${slot}!`,
    scheduledFor: reminderTimeFor(date),
  });

  const messageParts = [];
  messageParts.push(
    joinedNeighbours
      ? `You're booked — and a neighbour on your street has the same slot, so you both get the group discount!`
      : `You're booked! I'll text ${phone} to confirm.`
  );
  if (referralApplied) messageParts.push(`Your referral code saved you $${(referralDiscountCents / 100).toFixed(0)}.`);
  if (activePaymentMethods.length) messageParts.push(`Accepted payment: ${activePaymentMethods.join(', ')}.`);

  res.status(201).json({
    ok: true,
    id: booking.id,
    neighbourDiscount: joinedNeighbours,
    referralApplied,
    referralDiscountCents,
    paymentMethods: activePaymentMethods,
    message: messageParts.join(' '),
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

  if (action === 'done') {
    const client = findClientByPhone(booking.phone);
    if (client) refreshRegularTag(client);
  }

  res.json({ ok: true, status: booking.status });
});

// ---------------------------------------------------------------------------
// CRM: client profiles (passcode-protected — this is Kaylee's private data)
// ---------------------------------------------------------------------------

app.get('/api/clients', requirePasscode, (req, res) => {
  const list = clients.map((c) => {
    const history = bookings
      .filter((b) => b.normalizedPhone === c.normalizedPhone)
      .sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot));
    return {
      ...c,
      bookingCount: history.length,
      completedCount: history.filter((b) => b.status === STATUS.DONE).length,
      upcoming: history.filter((b) => b.status === STATUS.BOOKED),
      past: history.filter((b) => b.status !== STATUS.BOOKED),
    };
  });
  res.json({ clients: list });
});

app.get('/api/clients/:id', requirePasscode, (req, res) => {
  const client = clients.find((c) => c.id === req.params.id);
  if (!client) {
    res.status(404).json({ error: 'Client not found.' });
    return;
  }
  const history = bookings
    .filter((b) => b.normalizedPhone === client.normalizedPhone)
    .sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot));
  res.json({
    ...client,
    bookings: history,
  });
});

app.patch('/api/clients/:id', requirePasscode, (req, res) => {
  const client = clients.find((c) => c.id === req.params.id);
  if (!client) {
    res.status(404).json({ error: 'Client not found.' });
    return;
  }
  const body = req.body || {};
  if (typeof body.notes === 'string') client.notes = body.notes.slice(0, 2000);
  if (Array.isArray(body.tags)) {
    client.tags = body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10);
  }
  client.updatedAt = new Date().toISOString();
  saveClients();
  res.json({ ok: true, client });
});

// ---------------------------------------------------------------------------
// Backup export — a full dump of clients + bookings so Kaylee never loses
// her client list even if this server/disk goes away. Passcode-protected.
// ---------------------------------------------------------------------------

app.get('/api/export', requirePasscode, (req, res) => {
  const exportedAt = new Date().toISOString();
  const filename = `kaylees-dog-walking-backup-${exportedAt.slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json({ exportedAt, clients, bookings });
});

// ---------------------------------------------------------------------------
// Payment preferences
// ---------------------------------------------------------------------------

app.get('/api/settings/payment-methods', requirePasscode, (req, res) => {
  res.json({ paymentMethods: settings.paymentMethods, labels: PAYMENT_METHOD_LABELS });
});

app.patch('/api/settings/payment-methods', requirePasscode, (req, res) => {
  const body = req.body || {};
  for (const key of Object.keys(PAYMENT_METHOD_LABELS)) {
    if (typeof body[key] === 'boolean') settings.paymentMethods[key] = body[key];
  }
  saveSettings();
  res.json({ ok: true, paymentMethods: settings.paymentMethods });
});

// ---------------------------------------------------------------------------
// Notification log (booking confirmations + day-of reminders).
// NOTE: nothing here actually sends an SMS or email yet — see the
// "notConnected" flag returned below. Wiring in a real provider (e.g.
// Twilio for SMS, or SendGrid/Postmark/Resend for email) means calling
// their API at the point queueNotification()/POST /api/emails/send is
// called, then flipping the log entry's status to "sent".
// ---------------------------------------------------------------------------

app.get('/api/notifications', requirePasscode, (req, res) => {
  res.json({
    notConnected: true,
    notice: 'No SMS provider is wired in yet (e.g. Twilio) — these messages are logged but not actually delivered.',
    notifications: notifications.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  });
});

// ---------------------------------------------------------------------------
// Email templates + one-off/bulk send log.
// NOTE: same caveat as above — no email provider is connected. "Sending"
// here writes a log entry so the interface and data model are ready; wire
// a real provider into POST /api/emails/send to actually deliver mail.
// ---------------------------------------------------------------------------

app.get('/api/email-templates', requirePasscode, (req, res) => {
  res.json({ templates: emailTemplates });
});

app.patch('/api/email-templates/:id', requirePasscode, (req, res) => {
  const tpl = emailTemplates.find((t) => t.id === req.params.id);
  if (!tpl) {
    res.status(404).json({ error: 'Template not found.' });
    return;
  }
  const body = req.body || {};
  if (typeof body.subject === 'string') tpl.subject = body.subject.slice(0, 200);
  if (typeof body.body === 'string') tpl.body = body.body.slice(0, 5000);
  if (typeof body.name === 'string') tpl.name = body.name.slice(0, 80);
  saveEmailTemplates();
  res.json({ ok: true, template: tpl });
});

app.get('/api/email-log', requirePasscode, (req, res) => {
  res.json({
    notConnected: true,
    notice: 'No email provider is wired in yet (e.g. SendGrid, Postmark, Resend) — sends below are logged, not delivered.',
    log: emailLog.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  });
});

app.post('/api/emails/send', requirePasscode, (req, res) => {
  const body = req.body || {};
  const templateId = String(body.templateId || '');
  const clientIds = Array.isArray(body.clientIds) ? body.clientIds : [];
  const subjectOverride = typeof body.subject === 'string' ? body.subject : null;
  const bodyOverride = typeof body.body === 'string' ? body.body : null;

  const template = emailTemplates.find((t) => t.id === templateId);
  if (!template && !(subjectOverride && bodyOverride)) {
    res.status(400).json({ error: 'Pick a template or supply a custom subject and body.' });
    return;
  }
  const recipients = clients.filter((c) => clientIds.includes(c.id));
  if (recipients.length === 0) {
    res.status(400).json({ error: 'Select at least one client to send to.' });
    return;
  }

  const entries = recipients.map((client) => {
    const vars = {
      ownerName: client.ownerName,
      dogName: client.dogName,
      referralCode: client.referralCode,
      date: '',
      slot: '',
    };
    const subject = fillTemplate(subjectOverride ?? template.subject, vars);
    const text = fillTemplate(bodyOverride ?? template.body, vars);
    const entry = {
      id: crypto.randomUUID(),
      templateId: template ? template.id : 'custom',
      clientId: client.id,
      to: client.email ? `${client.ownerName} <${client.email}>` : `${client.ownerName} (no email on file)`,
      subject,
      body: text,
      status: 'queued — not sent (no email provider connected)',
      createdAt: new Date().toISOString(),
    };
    emailLog.push(entry);
    return entry;
  });

  saveEmailLog();
  res.status(201).json({ ok: true, notConnected: true, queued: entries.length, entries });
});

// Friendly 404 for unknown API routes (static pages fall through to express.static).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

bookings = bookingsStore.load();
clients = clientsStore.load();
settings = Object.assign({ paymentMethods: { etransfer: true, cash: true, stripe: false } }, settingsStore.load());
notifications = notificationsStore.load();
emailTemplates = emailTemplatesStore.load();
if (!Array.isArray(emailTemplates) || emailTemplates.length === 0) {
  emailTemplates = DEFAULT_EMAIL_TEMPLATES.map((t) => ({ ...t }));
  saveEmailTemplates();
}
emailLog = emailLogStore.load();

app.listen(PORT, () => {
  console.log(`Kaylee's Dog Walking Service is up at http://localhost:${PORT}`);
});
