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
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const GCAL_FILE = path.join(DATA_DIR, 'gcal.json');

// Walks live in Kaylee's local timezone regardless of where the server runs.
const CAL_TIMEZONE = 'America/Edmonton';

// ---------------------------------------------------------------------------
// Client accounts / authentication configuration
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'kdw_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_TTL_SEC = Math.floor(SESSION_TTL_MS / 1000);
const MIN_PASSWORD_LENGTH = 8;
const MAX_DOGS_PER_ACCOUNT = 20;
const MAX_DOG_PHOTO_BYTES = 2_000_000; // ~2MB data URL cap per dog photo

// Google OAuth — only active when these env vars are set. Without them the
// "Continue with Google" button is hidden and the routes return 503. To turn
// it on: create an OAuth 2.0 Client ID in the Google Cloud console, set the
// authorized redirect URI to <BASE_URL>/api/auth/google/callback, then set
// GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and BASE_URL (your deployed https
// origin) in the environment. Email + password sign-in works without any of
// this.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
function googleEnabled() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

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
let accounts = [];
let sessions = [];
let gcal = { refreshToken: null, accessToken: null, accessTokenExpiry: 0, email: '', lastSyncAt: null, lastError: null };

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
const accountsStore = makeStore(ACCOUNTS_FILE, []);
const sessionsStore = makeStore(SESSIONS_FILE, []);
const gcalStore = makeStore(GCAL_FILE, gcal);

function saveBookings() { bookingsStore.save(bookings); }
function saveClients() { clientsStore.save(clients); }
function saveSettings() { settingsStore.save(settings); }
function saveNotifications() { notificationsStore.save(notifications); }
function saveEmailTemplates() { emailTemplatesStore.save(emailTemplates); }
function saveEmailLog() { emailLogStore.save(emailLog); }
function saveAccounts() { accountsStore.save(accounts); }
function saveSessions() { sessionsStore.save(sessions); }
function saveGcal() { gcalStore.save(gcal); }

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

/** Constant-time string compare (hash first so lengths never leak). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkPasscode(supplied, req, res) {
  if (!safeEqual(supplied || '', PASSCODE)) {
    if (!underRateLimit('passcode-fail:' + clientIp(req), 20, 15 * 60 * 1000)) {
      res.status(429).json({ error: 'Too many attempts — please wait a few minutes and try again.' });
      return false;
    }
    res.status(401).json({ error: 'Wrong passcode.' });
    return false;
  }
  return true;
}

// Used by JSON API routes: header-only, so the passcode never ends up in a URL,
// server access log, browser history, or Referer header.
function requirePasscode(req, res, next) {
  if (!checkPasscode(req.get('x-passcode'), req, res)) return;
  next();
}

// Used only by plain <a href> navigations (like the Google Calendar connect
// link) that can't attach a custom header. Keep this off JSON API routes.
function requirePasscodeQuery(req, res, next) {
  if (!checkPasscode(req.get('x-passcode') || req.query.passcode, req, res)) return;
  next();
}

// ---------------------------------------------------------------------------
// Authentication helpers — real password hashing (scrypt), server-side
// sessions delivered as signed-random httpOnly cookies, persisted to disk so
// they survive restarts and work across devices. Only a SHA-256 hash of each
// session token is stored, so a leaked sessions.json can't be used to log in.
// ---------------------------------------------------------------------------

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const [, salt, hash] = parts;
  let derived;
  try {
    derived = crypto.scryptSync(password, salt, 64).toString('hex');
  } catch (err) {
    return false;
  }
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(derived, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createSession(accountId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.push({
    tokenHash: hashToken(token),
    accountId,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  saveSessions();
  return token;
}

function findSession(token) {
  if (!token) return null;
  const th = hashToken(token);
  const s = sessions.find((x) => x.tokenHash === th);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions = sessions.filter((x) => x !== s);
    saveSessions();
    return null;
  }
  return s;
}

function destroySession(token) {
  if (!token) return;
  const th = hashToken(token);
  const before = sessions.length;
  sessions = sessions.filter((s) => s.tokenHash !== th);
  if (sessions.length !== before) saveSessions();
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  });
  return out;
}

function sessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE];
}

/** Build a Set-Cookie string, adding Secure only when the request is https. */
function cookieString(req, name, value, maxAgeSec) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  const parts = [`${name}=${value}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function currentAccount(req) {
  const s = findSession(sessionToken(req));
  if (!s) return null;
  return accounts.find((a) => a.id === s.accountId) || null;
}

function requireAuth(req, res, next) {
  const account = currentAccount(req);
  if (!account) {
    res.status(401).json({ error: 'Please log in to continue.' });
    return;
  }
  req.account = account;
  next();
}

/** Public-safe view of an account — never exposes the password hash. */
function safeAccount(a) {
  return {
    id: a.id,
    name: a.name || '',
    email: a.email,
    phone: a.phone || '',
    address: a.address || '',
    hasPassword: Boolean(a.passwordHash),
    hasGoogle: Boolean(a.googleId),
    paused: Boolean(a.paused),
    dogs: Array.isArray(a.dogs) ? a.dogs : [],
    createdAt: a.createdAt,
  };
}

/** Tell Kaylee (via the dashboard notification log) that a client changed a dog profile. */
function notifyDogChange(account, verb, dogName) {
  queueNotification({
    bookingId: null,
    type: 'profile-update',
    to: 'Kaylee (dashboard)',
    message: `${account.name || account.email} (${account.phone || 'no phone'}) ${verb} dog profile: ${dogName || 'unnamed'}.`,
    scheduledFor: new Date().toISOString(),
  });
}

/** Validate + clamp a dog profile from user input, merging onto an existing one. */
function sanitizeDog(input, existing) {
  const d = existing || { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  input = input || {};
  if (typeof input.name === 'string') d.name = input.name.trim().slice(0, 80);
  if (typeof input.breed === 'string') d.breed = input.breed.trim().slice(0, 80);
  if (typeof input.age === 'string') d.age = input.age.trim().slice(0, 40);
  if (typeof input.size === 'string') {
    d.size = DOG_SIZES.includes(input.size) ? input.size : d.size || '';
  }
  if (typeof input.behaviorNotes === 'string') d.behaviorNotes = input.behaviorNotes.trim().slice(0, 1000);
  if (typeof input.vetContact === 'string') d.vetContact = input.vetContact.trim().slice(0, 200);
  if (typeof input.allergies === 'string') d.allergies = input.allergies.trim().slice(0, 500);
  if (typeof input.photo === 'string') {
    if (input.photo === '') {
      d.photo = '';
    } else if (
      /^data:image\/(png|jpe?g|webp|gif);base64,/.test(input.photo) &&
      input.photo.length <= MAX_DOG_PHOTO_BYTES
    ) {
      d.photo = input.photo;
    }
  }
  d.updatedAt = new Date().toISOString();
  return d;
}

/**
 * When a new account's phone matches an existing CRM client, pull over their
 * street address and seed a first dog profile so a returning customer's info
 * is already there the first time they log in.
 */
function linkAccountToClient(account) {
  if (!account.phone) return;
  const client = findClientByPhone(account.phone);
  if (!client) return;
  if (!account.address && client.address) account.address = client.address;
  if ((!account.dogs || account.dogs.length === 0) && client.dogName) {
    account.dogs = [sanitizeDog({ name: client.dogName, size: client.dogSize }, undefined)];
  }
}

// ---------------------------------------------------------------------------
// Booking conflict rules — shared by the public form, Kaylee's manual add,
// and the Google Calendar pull-sync so every path enforces the same schedule.
// Returns { status, error } or null when the slot works.
// ---------------------------------------------------------------------------

function findBookingConflict({ date, slot, duration, phone, dogName, ignoreId }) {
  const normPhone = normalizePhone(phone);
  const others = bookings.filter((b) => isActive(b) && b.id !== ignoreId);

  const duplicate = others.find(
    (b) => b.date === date && b.slot === slot && b.normalizedPhone === normPhone
  );
  if (duplicate) {
    return {
      status: 409,
      error: `Looks like ${dogName || 'this dog'} is already booked for ${date} at ${slot}. If you need to change something, text Kaylee at 587-433-2199.`,
    };
  }

  const sameSlot = others.filter((b) => b.date === date && b.slot === slot);
  if (sameSlot.length >= MAX_DOGS_PER_WALK) {
    return {
      status: 409,
      error: `That time is already full — three dogs is my max for one walk! Please pick another slot and I'll see you then.`,
    };
  }
  const differentLength = sameSlot.find((b) => b.duration !== duration);
  if (differentLength) {
    return {
      status: 409,
      error: `That slot already has a ${differentLength.duration}-minute walk booked. Pick the ${differentLength.duration}-minute option to join it, or choose a different time.`,
    };
  }

  // A walk's actual duration can run into the next slot — block anything
  // that would put Kaylee in two places at once, across walk groups.
  const newStart = slotToMinutes(slot);
  const newEnd = newStart + duration;
  const seen = new Set();
  for (const other of others) {
    if (other.date !== date) continue;
    const key = walkKey(other);
    if (seen.has(key)) continue;
    seen.add(key);
    if (other.slot === slot && other.duration === duration) continue;
    const otherStart = slotToMinutes(other.slot);
    if (otherStart === null || newStart === null) continue;
    const otherEnd = otherStart + other.duration;
    if (newStart < otherEnd && otherStart < newEnd) {
      return {
        status: 409,
        error: `That overlaps with a walk already booked at ${other.slot} (${other.duration} min) — Kaylee can't be two places at once! Please pick a time that doesn't overlap.`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Google Calendar sync (Kaylee's own calendar).
// Uses the same GOOGLE_CLIENT_ID/SECRET as Google sign-in, with the
// calendar.events scope and an offline refresh token stored in data/gcal.json.
// Bookings push events on create/done/cancel; gcalPullSync() pulls
// calendar-side deletions and moves back into the app.
// ---------------------------------------------------------------------------

async function gcalAccessToken() {
  if (!gcal.refreshToken || !googleEnabled()) return null;
  if (gcal.accessToken && gcal.accessTokenExpiry > Date.now() + 60_000) {
    return gcal.accessToken;
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: gcal.refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const json = await res.json();
  if (!json.access_token) {
    throw new Error('Google token refresh failed: ' + (json.error || res.status));
  }
  gcal.accessToken = json.access_token;
  gcal.accessTokenExpiry = Date.now() + (json.expires_in || 3600) * 1000;
  saveGcal();
  return gcal.accessToken;
}

async function gcalApi(method, pathname, body) {
  const token = await gcalAccessToken();
  if (!token) throw new Error('Google Calendar is not connected');
  const res = await fetch('https://www.googleapis.com/calendar/v3' + pathname, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      'Google Calendar API ' + res.status + ': ' + ((json.error && json.error.message) || 'request failed')
    );
    err.status = res.status;
    throw err;
  }
  return json;
}

function bookingEventBody(b) {
  const pad = (n) => String(n).padStart(2, '0');
  const startMin = slotToMinutes(b.slot);
  const endMin = startMin + b.duration;
  const stamp = (min) => `${b.date}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00`;
  return {
    summary: (b.status === STATUS.DONE ? '✓ ' : '') + `Dog walk: ${b.dogName} (${b.duration} min)`,
    description:
      `Owner: ${b.ownerName}\nPhone: ${b.phone}\nDog: ${b.dogName} — ${b.dogSize}` +
      (b.notes ? `\nNotes: ${b.notes}` : '') +
      `\n\nBooked via Kaylee's Dog Walking Service`,
    location: b.address,
    start: { dateTime: stamp(startMin), timeZone: CAL_TIMEZONE },
    end: { dateTime: stamp(endMin), timeZone: CAL_TIMEZONE },
  };
}

/** Fire-and-forget wrapper: calendar hiccups must never break a booking. */
function gcalPush(fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      gcal.lastError = err.message;
      saveGcal();
      console.error('Google Calendar sync:', err.message);
    });
}

function gcalOnBookingCreated(booking) {
  if (!gcal.refreshToken) return;
  gcalPush(async () => {
    const ev = await gcalApi('POST', '/calendars/primary/events', bookingEventBody(booking));
    if (ev && ev.id) {
      booking.gcalEventId = ev.id;
      saveBookings();
    }
  });
}

function gcalOnBookingStatusChange(booking) {
  if (!gcal.refreshToken || !booking.gcalEventId) return;
  gcalPush(async () => {
    if (booking.status === STATUS.CANCELLED) {
      try {
        await gcalApi('DELETE', '/calendars/primary/events/' + booking.gcalEventId);
      } catch (err) {
        if (err.status !== 404 && err.status !== 410) throw err;
      }
      booking.gcalEventId = null;
      saveBookings();
    } else {
      await gcalApi('PATCH', '/calendars/primary/events/' + booking.gcalEventId, bookingEventBody(booking));
    }
  });
}

/** An event's RFC3339 start → { date, minutes } in Kaylee's timezone. */
function edmontonParts(iso) {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: CAL_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

function slotForMinutes(min) {
  return TIME_SLOTS.find((s) => slotToMinutes(s) === min) || null;
}

/**
 * Two-way pull: for every active upcoming booking, make sure a calendar
 * event exists; adopt calendar-side deletions (cancel the booking) and moves
 * (update the booking when the new time maps to a valid free slot, otherwise
 * push the app's time back to the calendar — the schedule's rules win).
 */
async function gcalPullSync() {
  const summary = { created: 0, cancelledFromCalendar: 0, movedFromCalendar: 0, pushedBack: 0 };
  if (!gcal.refreshToken) return summary;
  const today = todayString();
  let dirty = false;

  for (const b of bookings) {
    if (!isActive(b) || b.date < today) continue;

    if (!b.gcalEventId) {
      const ev = await gcalApi('POST', '/calendars/primary/events', bookingEventBody(b));
      if (ev && ev.id) {
        b.gcalEventId = ev.id;
        summary.created += 1;
        dirty = true;
      }
      continue;
    }

    let ev;
    try {
      ev = await gcalApi('GET', '/calendars/primary/events/' + b.gcalEventId);
    } catch (err) {
      if (err.status === 404 || err.status === 410) ev = null;
      else throw err;
    }

    if (!ev || ev.status === 'cancelled') {
      b.status = STATUS.CANCELLED;
      b.gcalEventId = null;
      summary.cancelledFromCalendar += 1;
      dirty = true;
      continue;
    }

    if (ev.start && ev.start.dateTime) {
      const p = edmontonParts(ev.start.dateTime);
      const slot = slotForMinutes(p.minutes);
      const moved = p.date !== b.date || (slot && slot !== b.slot) || (!slot && true);
      if (moved) {
        const fits =
          slot &&
          isValidDateString(p.date) &&
          !findBookingConflict({ date: p.date, slot, duration: b.duration, phone: b.phone, dogName: b.dogName, ignoreId: b.id });
        if (fits) {
          b.date = p.date;
          b.slot = slot;
          summary.movedFromCalendar += 1;
          dirty = true;
        } else {
          await gcalApi('PATCH', '/calendars/primary/events/' + b.gcalEventId, bookingEventBody(b));
          summary.pushedBack += 1;
        }
      }
    }
  }

  if (dirty) saveBookings();
  gcal.lastSyncAt = new Date().toISOString();
  gcal.lastError = null;
  saveGcal();
  return summary;
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
// Behind Render/other proxies, trust X-Forwarded-Proto so req.secure is
// accurate and session cookies get the Secure flag over https.
app.set('trust proxy', true);
app.disable('x-powered-by'); // don't advertise the framework

// ---------------------------------------------------------------------------
// Security headers on every response.
// The CSP hash allows exactly one inline script (the html.js class toggle
// used for the animation system); everything else must come from this origin
// or Google Fonts. That blocks injected <script> tags outright, and
// frame-ancestors 'none' stops the site being embedded for clickjacking.
// ---------------------------------------------------------------------------

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'sha256-/x7W7R75k8Roq0WaVRQX9blP4OufE5xbAdzklGxsgpw='",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ---------------------------------------------------------------------------
// CSRF backstop: state-changing API requests must come from this site.
// SameSite=Lax session cookies already stop classic cross-site form posts;
// this rejects anything whose Origin header points somewhere else entirely.
// (Requests without an Origin header — curl, same-origin fetches in older
// browsers — pass through; they can't ride a victim's cookies cross-site.)
// ---------------------------------------------------------------------------

app.use('/api', (req, res, next) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin) {
      let host = null;
      try {
        host = new URL(origin).host;
      } catch (err) {
        host = null;
      }
      if (!host || host !== req.get('host')) {
        res.status(403).json({ error: 'Cross-origin request blocked.' });
        return;
      }
    }
  }
  next();
});

// Broad per-IP ceiling across the whole API — generous for real use, but
// stops scripted flooding (of bookings, signups, anything) cold.
app.use('/api', (req, res, next) => {
  if (!underRateLimit('api:' + clientIp(req), 300, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many requests — please slow down and try again in a few minutes.' });
    return;
  }
  next();
});

app.use(express.json({ limit: '3mb' })); // room for base64 dog photos
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
    googleAuthEnabled: googleEnabled(),
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
  // Bookings mutate data and send notifications — cap how fast one IP can fire them.
  if (!underRateLimit('book:' + clientIp(req), 8, 10 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many bookings from this connection — please wait a few minutes, or text Kaylee at 587-433-2199.' });
    return;
  }
  const body = req.body || {};

  const ownerName = String(body.ownerName || '').trim().slice(0, 80);
  const dogName = String(body.dogName || '').trim().slice(0, 80);
  const dogSize = String(body.dogSize || '').trim();
  const phone = String(body.phone || '').trim().slice(0, 25);
  const email = String(body.email || '').trim().slice(0, 200);
  const address = String(body.address || '').trim().slice(0, 120);
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

  // Duplicate, capacity, duration-mismatch, and overlap rules — shared with
  // Kaylee's manual add and the Google Calendar pull-sync.
  const conflict = findBookingConflict({ date, slot, duration, phone, dogName });
  if (conflict) {
    res.status(conflict.status).json({ error: conflict.error });
    return;
  }

  const sameSlot = bookings.filter(
    (b) => isActive(b) && b.date === date && b.slot === slot
  );

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

  const bookingAccount = currentAccount(req);

  const booking = {
    id: crypto.randomUUID(),
    accountId: bookingAccount ? bookingAccount.id : null,
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
  gcalOnBookingCreated(booking);

  // Booking a walk is the clearest possible "I'm back" — unpause the account.
  if (bookingAccount && bookingAccount.paused) {
    bookingAccount.paused = false;
    saveAccounts();
    if (client && client.paused) {
      client.paused = false;
      saveClients();
    }
  }

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
  gcalOnBookingStatusChange(booking);

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

// ---------------------------------------------------------------------------
// Client accounts — signup / login / logout / me
// ---------------------------------------------------------------------------

app.post('/api/auth/signup', (req, res) => {
  if (!underRateLimit('signup:' + clientIp(req), 10, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many attempts — please wait a few minutes and try again.' });
    return;
  }
  const body = req.body || {};
  const email = normalizeEmail(body.email);
  const name = String(body.name || '').trim().slice(0, 80);
  const phone = String(body.phone || '').trim().slice(0, 25);
  const password = String(body.password || '');

  if (!name) {
    res.status(400).json({ error: 'Please tell me your name.' });
    return;
  }
  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Please enter a valid email address.' });
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    return;
  }
  if (accounts.some((a) => a.email === email)) {
    res.status(409).json({ error: 'An account with that email already exists — try logging in instead.' });
    return;
  }

  const account = {
    id: crypto.randomUUID(),
    email,
    name,
    phone,
    address: '',
    passwordHash: hashPassword(password),
    googleId: null,
    dogs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  linkAccountToClient(account);
  accounts.push(account);
  saveAccounts();

  const token = createSession(account.id);
  res.setHeader('Set-Cookie', cookieString(req, SESSION_COOKIE, token, SESSION_TTL_SEC));
  res.status(201).json({ ok: true, account: safeAccount(account) });
});

app.post('/api/auth/login', (req, res) => {
  if (!underRateLimit('login:' + clientIp(req), 15, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many attempts — please wait a few minutes and try again.' });
    return;
  }
  const body = req.body || {};
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');

  // Per-account limit on top of the per-IP one, so a distributed guesser
  // can't hammer a single mailbox from many addresses.
  if (email && !underRateLimit('login-email:' + email, 10, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many attempts — please wait a few minutes and try again.' });
    return;
  }

  const account = accounts.find((a) => a.email === email);
  // Same generic error whether the email is unknown or the password is wrong,
  // so this can't be used to discover which emails have accounts.
  if (!account || !verifyPassword(password, account.passwordHash)) {
    res.status(401).json({ error: 'Wrong email or password.' });
    return;
  }

  const token = createSession(account.id);
  res.setHeader('Set-Cookie', cookieString(req, SESSION_COOKIE, token, SESSION_TTL_SEC));
  res.json({ ok: true, account: safeAccount(account) });
});

app.post('/api/auth/logout', (req, res) => {
  destroySession(sessionToken(req));
  res.setHeader('Set-Cookie', cookieString(req, SESSION_COOKIE, '', 0));
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const account = currentAccount(req);
  res.json({
    account: account ? safeAccount(account) : null,
    googleAuthEnabled: googleEnabled(),
  });
});

// ---------------------------------------------------------------------------
// Google OAuth (authorization-code flow). Inactive until GOOGLE_CLIENT_ID /
// GOOGLE_CLIENT_SECRET / BASE_URL are configured — see the notes at the top.
// ---------------------------------------------------------------------------

app.get('/api/auth/google', (req, res) => {
  if (!googleEnabled()) {
    res.status(503).json({ error: "Google sign-in isn't set up yet." });
    return;
  }
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', cookieString(req, 'kdw_gstate', state, 600));
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: BASE_URL + '/api/auth/google/callback',
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

app.get('/api/auth/google/callback', async (req, res) => {
  if (!googleEnabled()) {
    res.redirect('/account.html?error=google_unavailable');
    return;
  }
  const code = req.query.code;
  const state = req.query.state;
  const cookies = parseCookies(req);
  if (!code || !state || state !== cookies.kdw_gstate) {
    res.redirect('/account.html?error=google_state');
    return;
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: BASE_URL + '/api/auth/google/callback',
        grant_type: 'authorization_code',
      }).toString(),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenJson.access_token) throw new Error('no access token from Google');

    const profRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenJson.access_token },
    });
    const prof = await profRes.json();
    const email = normalizeEmail(prof.email);
    const googleId = prof.sub;
    const name = String(prof.name || '').slice(0, 80);
    if (!email || !googleId) throw new Error('Google profile missing email');

    // Only auto-link a Google identity to an existing account by email when that
    // account has no password set. A password-protected account's email was never
    // proven to belong to whoever set the password, so merging here would let an
    // attacker who pre-registered a victim's email hijack the victim's real Google
    // sign-in into the attacker's account.
    let account =
      accounts.find((a) => a.googleId === googleId) ||
      accounts.find((a) => a.email === email && !a.passwordHash);
    if (!account) {
      account = {
        id: crypto.randomUUID(),
        email,
        name,
        phone: '',
        address: '',
        passwordHash: null,
        googleId,
        dogs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      linkAccountToClient(account);
      accounts.push(account);
    } else {
      if (!account.googleId) account.googleId = googleId;
      if (!account.name) account.name = name;
      account.updatedAt = new Date().toISOString();
    }
    saveAccounts();

    const token = createSession(account.id);
    res.setHeader('Set-Cookie', [
      cookieString(req, SESSION_COOKIE, token, SESSION_TTL_SEC),
      cookieString(req, 'kdw_gstate', '', 0),
    ]);
    res.redirect('/account.html');
  } catch (err) {
    console.error('Google OAuth failed:', err.message);
    res.redirect('/account.html?error=google_failed');
  }
});

// ---------------------------------------------------------------------------
// Account settings, password, dog profiles, and the client's own bookings
// (all require a logged-in session).
// ---------------------------------------------------------------------------

app.patch('/api/account', requireAuth, (req, res) => {
  const body = req.body || {};
  const account = req.account;
  if (typeof body.name === 'string') account.name = body.name.trim().slice(0, 80);
  if (typeof body.phone === 'string') account.phone = body.phone.trim().slice(0, 25);
  if (typeof body.address === 'string') account.address = body.address.trim().slice(0, 120);
  account.updatedAt = new Date().toISOString();
  saveAccounts();
  res.json({ ok: true, account: safeAccount(account) });
});

app.post('/api/account/password', requireAuth, (req, res) => {
  const body = req.body || {};
  const account = req.account;
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    return;
  }
  // If they already have a password, the current one must match. Accounts that
  // only ever signed in with Google can set a password without a current one.
  if (account.passwordHash) {
    if (!verifyPassword(String(body.currentPassword || ''), account.passwordHash)) {
      res.status(401).json({ error: 'Your current password is incorrect.' });
      return;
    }
  }
  account.passwordHash = hashPassword(newPassword);
  account.updatedAt = new Date().toISOString();
  saveAccounts();
  res.json({ ok: true, account: safeAccount(account) });
});

app.get('/api/account/dogs', requireAuth, (req, res) => {
  res.json({ dogs: req.account.dogs || [] });
});

app.post('/api/account/dogs', requireAuth, (req, res) => {
  const account = req.account;
  if (!Array.isArray(account.dogs)) account.dogs = [];
  if (account.dogs.length >= MAX_DOGS_PER_ACCOUNT) {
    res.status(400).json({ error: `You can save up to ${MAX_DOGS_PER_ACCOUNT} dogs.` });
    return;
  }
  const dog = sanitizeDog(req.body || {}, undefined);
  if (!dog.name) {
    res.status(400).json({ error: "Please give your dog a name." });
    return;
  }
  account.dogs.push(dog);
  account.updatedAt = new Date().toISOString();
  saveAccounts();
  notifyDogChange(account, 'added a', dog.name);
  res.status(201).json({ ok: true, dog });
});

app.patch('/api/account/dogs/:id', requireAuth, (req, res) => {
  const account = req.account;
  const dog = (account.dogs || []).find((d) => d.id === req.params.id);
  if (!dog) {
    res.status(404).json({ error: 'Dog not found.' });
    return;
  }
  sanitizeDog(req.body || {}, dog);
  if (!dog.name) {
    res.status(400).json({ error: "Please give your dog a name." });
    return;
  }
  account.updatedAt = new Date().toISOString();
  saveAccounts();
  notifyDogChange(account, 'updated the', dog.name);
  res.json({ ok: true, dog });
});

app.delete('/api/account/dogs/:id', requireAuth, (req, res) => {
  const account = req.account;
  const removed = (account.dogs || []).find((d) => d.id === req.params.id);
  account.dogs = (account.dogs || []).filter((d) => d.id !== req.params.id);
  if (!removed) {
    res.status(404).json({ error: 'Dog not found.' });
    return;
  }
  account.updatedAt = new Date().toISOString();
  saveAccounts();
  notifyDogChange(account, 'removed the', removed.name);
  res.json({ ok: true });
});

app.get('/api/account/bookings', requireAuth, (req, res) => {
  const account = req.account;
  const key = normalizePhone(account.phone);
  // Match this account's own bookings by accountId. Fall back to phone ONLY
  // for bookings that aren't already tied to any account (i.e. legacy walks
  // booked before this person had an account) — so setting your phone to a
  // stranger's number can never surface bookings that belong to their account.
  const mine = bookings.filter(
    (b) => b.accountId === account.id || (!b.accountId && key && b.normalizedPhone === key)
  );
  const today = todayString();
  const view = (b) => ({
    id: b.id,
    date: b.date,
    slot: b.slot,
    duration: b.duration,
    dogName: b.dogName,
    dogSize: b.dogSize,
    address: b.address,
    notes: b.notes || '',
    status: b.status,
  });
  const upcoming = mine
    .filter((b) => b.status === STATUS.BOOKED && b.date >= today)
    .sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot))
    .map(view);
  const past = mine
    .filter((b) => !(b.status === STATUS.BOOKED && b.date >= today))
    .sort((a, b) => (b.date + b.slot).localeCompare(a.date + a.slot))
    .map(view);
  res.json({ upcoming, past });
});

// ---------------------------------------------------------------------------
// Google Calendar connection (Kaylee only — passcode protected).
// Needs the same Google Cloud OAuth client as sign-in, with the extra
// redirect URI <BASE_URL>/api/gcal/callback authorized and the Calendar API
// enabled on the project. Until GOOGLE_CLIENT_ID/SECRET are set these
// routes report "not configured" rather than pretending to work.
// ---------------------------------------------------------------------------

app.get('/api/gcal/status', requirePasscode, (req, res) => {
  res.json({
    configured: googleEnabled(),
    connected: Boolean(gcal.refreshToken),
    email: gcal.email || '',
    lastSyncAt: gcal.lastSyncAt,
    lastError: gcal.lastError,
  });
});

app.get('/api/gcal/connect', requirePasscodeQuery, (req, res) => {
  if (!googleEnabled()) {
    res.status(503).json({ error: 'Google credentials are not configured yet — see the README.' });
    return;
  }
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', cookieString(req, 'kdw_calstate', state, 600));
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: BASE_URL + '/api/gcal/callback',
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.events openid email',
    state,
    access_type: 'offline',
    prompt: 'consent', // force a refresh token even on re-connect
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

app.get('/api/gcal/callback', async (req, res) => {
  if (!googleEnabled()) {
    res.redirect('/schedule.html?gcal=unavailable');
    return;
  }
  const code = req.query.code;
  const state = req.query.state;
  if (!code || !state || state !== parseCookies(req).kdw_calstate) {
    res.redirect('/schedule.html?gcal=state_error');
    return;
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: BASE_URL + '/api/gcal/callback',
        grant_type: 'authorization_code',
      }).toString(),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenJson.refresh_token && !tokenJson.access_token) {
      throw new Error('no tokens from Google');
    }
    if (tokenJson.refresh_token) gcal.refreshToken = tokenJson.refresh_token;
    gcal.accessToken = tokenJson.access_token || null;
    gcal.accessTokenExpiry = Date.now() + (tokenJson.expires_in || 3600) * 1000;

    if (tokenJson.access_token) {
      const profRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: 'Bearer ' + tokenJson.access_token },
      });
      const prof = await profRes.json();
      if (prof.email) gcal.email = prof.email;
    }
    gcal.lastError = null;
    saveGcal();

    // First sync in the background so existing upcoming walks get events.
    gcalPush(() => gcalPullSync());

    res.setHeader('Set-Cookie', cookieString(req, 'kdw_calstate', '', 0));
    res.redirect('/schedule.html?gcal=connected');
  } catch (err) {
    console.error('Google Calendar connect failed:', err.message);
    res.redirect('/schedule.html?gcal=failed');
  }
});

app.post('/api/gcal/disconnect', requirePasscode, (req, res) => {
  gcal = { refreshToken: null, accessToken: null, accessTokenExpiry: 0, email: '', lastSyncAt: null, lastError: null };
  saveGcal();
  res.json({ ok: true });
});

app.post('/api/gcal/sync', requirePasscode, async (req, res) => {
  if (!gcal.refreshToken) {
    res.status(409).json({ error: 'Google Calendar is not connected.' });
    return;
  }
  try {
    const summary = await gcalPullSync();
    res.json({ ok: true, summary });
  } catch (err) {
    gcal.lastError = err.message;
    saveGcal();
    res.status(502).json({ error: 'Sync failed: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// Password reset. No email provider is connected yet, so the reset link is
// queued into the email log — Kaylee can open Messages and text the link to
// the client. Once a provider is wired into the email queue, this flow
// delivers automatically with no further changes.
// ---------------------------------------------------------------------------

app.post('/api/auth/forgot', (req, res) => {
  if (!underRateLimit('forgot:' + clientIp(req), 5, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many attempts — please wait a few minutes and try again.' });
    return;
  }
  const email = normalizeEmail((req.body || {}).email);
  // Always the same response, so this can't be used to discover accounts.
  const generic = {
    ok: true,
    message: "If that email has an account, a reset link is on its way. It's valid for 1 hour.",
  };
  const account = accounts.find((a) => a.email === email);
  if (!account) {
    res.json(generic);
    return;
  }

  const token = crypto.randomBytes(24).toString('hex');
  account.resetTokenHash = hashToken(token);
  account.resetTokenExpiry = Date.now() + 60 * 60 * 1000;
  saveAccounts();

  const link = `${BASE_URL}/account.html?reset=${token}`;
  emailLog.push({
    id: crypto.randomUUID(),
    templateId: 'password-reset',
    clientId: null,
    to: `${account.name || 'Client'} <${account.email}>`,
    subject: 'Reset your Kaylee’s Dog Walking password',
    body:
      `Hi ${account.name || 'there'},\n\nSomeone asked to reset the password for this account. ` +
      `If that was you, open this link within 1 hour:\n\n${link}\n\n` +
      `If it wasn't you, you can ignore this — your password is unchanged.`,
    status: 'queued — not sent (no email provider connected)',
    createdAt: new Date().toISOString(),
  });
  saveEmailLog();
  queueNotification({
    bookingId: null,
    type: 'password-reset',
    to: 'Kaylee (dashboard)',
    message: `${account.name || account.email} requested a password reset. No email provider is connected, so open the Messages tab, copy the reset link from the email log, and text it to them.`,
    scheduledFor: new Date().toISOString(),
  });

  res.json(generic);
});

app.post('/api/auth/reset', (req, res) => {
  if (!underRateLimit('reset:' + clientIp(req), 10, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many attempts — please wait a few minutes and try again.' });
    return;
  }
  const body = req.body || {};
  const token = String(body.token || '');
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    return;
  }
  const th = hashToken(token);
  const account = accounts.find(
    (a) => a.resetTokenHash === th && a.resetTokenExpiry && a.resetTokenExpiry > Date.now()
  );
  if (!account) {
    res.status(400).json({ error: 'That reset link is invalid or has expired — request a new one.' });
    return;
  }
  account.passwordHash = hashPassword(newPassword);
  account.resetTokenHash = null;
  account.resetTokenExpiry = null;
  account.updatedAt = new Date().toISOString();
  saveAccounts();

  // A reset means the old password may be compromised — sign out everywhere,
  // then start a fresh session for this browser.
  sessions = sessions.filter((s) => s.accountId !== account.id);
  saveSessions();
  const sessionTok = createSession(account.id);
  res.setHeader('Set-Cookie', cookieString(req, SESSION_COOKIE, sessionTok, SESSION_TTL_SEC));
  res.json({ ok: true, account: safeAccount(account) });
});

// ---------------------------------------------------------------------------
// Admin manual add (Kaylee only) — for phone and in-person bookings that
// never touch the public form, and for adding a client directly.
// ---------------------------------------------------------------------------

app.post('/api/admin/bookings', requirePasscode, (req, res) => {
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

  const problems = [];
  if (!ownerName) problems.push('owner name');
  if (!dogName) problems.push('dog name');
  if (!DOG_SIZES.includes(dogSize)) problems.push('dog size');
  if (phone.replace(/\D/g, '').length < 7) problems.push('phone');
  if (!address || !normalizeStreet(address)) problems.push('address');
  if (!isValidDateString(date)) problems.push('date');
  if (!TIME_SLOTS.includes(slot)) problems.push('time slot');
  if (!PRICES[duration]) problems.push('walk length');
  if (problems.length > 0) {
    res.status(400).json({ error: `Missing or invalid: ${problems.join(', ')}.` });
    return;
  }
  if (date < todayString()) {
    res.status(400).json({ error: 'That date has already passed.' });
    return;
  }
  const conflict = findBookingConflict({ date, slot, duration, phone, dogName });
  if (conflict) {
    res.status(conflict.status).json({ error: conflict.error });
    return;
  }

  const booking = {
    id: crypto.randomUUID(),
    accountId: null,
    source: 'manual-admin',
    ownerName,
    dogName,
    dogSize,
    phone,
    email: '',
    normalizedPhone: normalizePhone(phone),
    address,
    date,
    slot,
    duration,
    notes,
    dogBirthday: '',
    // Recorded by Kaylee, not the client — the waiver wasn't checked online.
    vaccinatedAgreed: false,
    waiverAgreed: false,
    waiverAgreedAt: null,
    photoConsent: true,
    referralCodeUsed: null,
    referralDiscountCents: 0,
    status: STATUS.BOOKED,
    createdAt: new Date().toISOString(),
  };

  upsertClientForBooking({ ownerName, dogName, dogSize, phone, email: '', address, dogBirthday: '', referralCode: '' });
  bookings.push(booking);
  saveBookings();
  gcalOnBookingCreated(booking);

  queueNotification({
    bookingId: booking.id,
    type: 'confirmation',
    to: phone,
    message: `Hi ${ownerName}, ${dogName}'s walk is booked for ${date} at ${slot} (${duration} min). — Kaylee`,
    scheduledFor: booking.createdAt,
  });
  queueNotification({
    bookingId: booking.id,
    type: 'reminder',
    to: phone,
    message: `Hi ${ownerName}, just a reminder — ${dogName}'s walk with Kaylee is today at ${slot}!`,
    scheduledFor: reminderTimeFor(date),
  });

  res.status(201).json({ ok: true, id: booking.id, note: 'Remember to cover the waiver with them in person — this booking is marked as manually added.' });
});

app.post('/api/admin/clients', requirePasscode, (req, res) => {
  const body = req.body || {};
  const ownerName = String(body.ownerName || '').trim().slice(0, 80);
  const phone = String(body.phone || '').trim().slice(0, 25);
  if (!ownerName || phone.replace(/\D/g, '').length < 7) {
    res.status(400).json({ error: 'A name and a valid phone number are required.' });
    return;
  }
  if (findClientByPhone(phone)) {
    res.status(409).json({ error: 'A client with that phone number already exists.' });
    return;
  }
  const client = {
    id: crypto.randomUUID(),
    normalizedPhone: normalizePhone(phone),
    phone,
    email: String(body.email || '').trim().slice(0, 200),
    ownerName,
    dogName: String(body.dogName || '').trim().slice(0, 80),
    dogSize: DOG_SIZES.includes(body.dogSize) ? body.dogSize : '',
    address: String(body.address || '').trim().slice(0, 120),
    dogBirthday: String(body.dogBirthday || '').trim().slice(0, 60),
    notes: String(body.notes || '').trim().slice(0, 2000),
    tags: ['new'],
    referralCode: generateReferralCode(ownerName, phone),
    referredByClientId: null,
    pendingCreditCents: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  clients.push(client);
  saveClients();
  res.status(201).json({ ok: true, client });
});

// ---------------------------------------------------------------------------
// Pause / resume account (client). Paused clients stay in the CRM with all
// their history — they're just flagged so Kaylee knows they're away.
// ---------------------------------------------------------------------------

app.post('/api/account/pause', requireAuth, (req, res) => {
  const paused = (req.body || {}).paused === true;
  const account = req.account;
  account.paused = paused;
  account.updatedAt = new Date().toISOString();
  saveAccounts();
  const client = findClientByPhone(account.phone);
  if (client) {
    client.paused = paused;
    client.updatedAt = new Date().toISOString();
    saveClients();
  }
  queueNotification({
    bookingId: null,
    type: 'account-status',
    to: 'Kaylee (dashboard)',
    message: `${account.name || account.email} ${paused ? 'paused their account (away for a while)' : 'resumed their account'}.`,
    scheduledFor: new Date().toISOString(),
  });
  res.json({ ok: true, account: safeAccount(account) });
});

// Friendly 404 for unknown API routes (static pages fall through to express.static).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Last-resort error handler: log the real error server-side, never leak
// stack traces or internals to the client (covers bad JSON bodies too).
app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('Unhandled error:', err.message);
  res.status(status).json({
    error: status === 400 ? 'That request could not be read — please try again.' : 'Something went wrong — please try again.',
  });
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
accounts = accountsStore.load();
sessions = sessionsStore.load();
gcal = Object.assign(gcal, gcalStore.load());
// Drop any sessions that expired while the server was down.
const nowMs = Date.now();
const livingSessions = sessions.filter((s) => s.expiresAt > nowMs);
if (livingSessions.length !== sessions.length) {
  sessions = livingSessions;
  saveSessions();
}

app.listen(PORT, () => {
  console.log(`Kaylee's Dog Walking Service is up at http://localhost:${PORT}`);
});
