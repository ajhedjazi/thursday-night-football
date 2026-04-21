require("dotenv").config();

const express = require("express");
const path = require("path");
const Stripe = require("stripe");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY in .env");
}

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

console.log("Stripe key prefix:", process.env.STRIPE_SECRET_KEY?.slice(0, 7));
console.log("Stripe key suffix:", process.env.STRIPE_SECRET_KEY?.slice(-6));

// -----------------------------
// Config
// -----------------------------
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";
const AUTO_GENERATE_WEEKS = Number(process.env.AUTO_GENERATE_WEEKS || 12);
const DEFAULT_SESSION_TEMPLATE = {
  title: "Thursday 7pm Kickabout",
  time: "19:00",
  location: "Goals / Astro Centre",
  pricePence: 500,
  capacity: 12,
  status: "open"
};

// Seed a few Thursdays manually for now
const DEFAULT_SESSIONS = [
  {
    id: "thursday-2026-04-23",
    title: "Thursday 7pm Kickabout",
    date: "2026-04-23",
    time: "19:00",
    location: "Goals / Astro Centre",
    pricePence: 500,
    capacity: 12,
    status: "open"
  },
  {
    id: "thursday-2026-04-30",
    title: "Thursday 7pm Kickabout",
    date: "2026-04-30",
    time: "19:00",
    location: "Goals / Astro Centre",
    pricePence: 500,
    capacity: 12,
    status: "open"
  },
  {
    id: "thursday-2026-05-07",
    title: "Thursday 7pm Kickabout",
    date: "2026-05-07",
    time: "19:00",
    location: "Goals / Astro Centre",
    pricePence: 500,
    capacity: 12,
    status: "open"
  }
];

// -----------------------------
// Database
// -----------------------------
const dbPath = path.resolve(__dirname, process.env.DB_PATH || "bookings.db");
const db = new Database(dbPath);

// Create sessions table
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    location TEXT NOT NULL,
    price_pence INTEGER NOT NULL,
    capacity INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    is_featured INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Create bookings table
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    stripe_session_id TEXT NOT NULL,
    payment_status TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT,
    customer_phone TEXT,
    player_count INTEGER NOT NULL DEFAULT 1,
    guest_names TEXT,
    is_manual INTEGER NOT NULL DEFAULT 0,
    is_credited INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Safe upgrades for older DBs
try {
  db.exec(`ALTER TABLE bookings ADD COLUMN player_count INTEGER NOT NULL DEFAULT 1;`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE bookings ADD COLUMN guest_names TEXT;`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE bookings ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0;`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE bookings ADD COLUMN is_credited INTEGER NOT NULL DEFAULT 0;`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE sessions ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0;`);
} catch (e) {}

// Prepared statements
const insertSessionStmt = db.prepare(`
  INSERT OR IGNORE INTO sessions (
    id,
    title,
    date,
    time,
    location,
    price_pence,
    capacity,
    status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const getNextOpenSessionStmt = db.prepare(`
  SELECT *
  FROM sessions
  WHERE status = 'open'
  ORDER BY date ASC, time ASC
  LIMIT 1
`);

const getFeaturedSessionStmt = db.prepare(`
  SELECT *
  FROM sessions
  WHERE is_featured = 1
  LIMIT 1
`);

const getSessionByIdStmt = db.prepare(`
  SELECT *
  FROM sessions
  WHERE id = ?
`);

const getNextOpenSessionAfterStmt = db.prepare(`
  SELECT *
  FROM sessions
  WHERE status = 'open'
    AND (date > ? OR (date = ? AND time > ?))
  ORDER BY date ASC, time ASC
  LIMIT 1
`);

const getLatestSessionStmt = db.prepare(`
  SELECT *
  FROM sessions
  ORDER BY date DESC, time DESC
  LIMIT 1
`);

const updateSessionStatusStmt = db.prepare(`
  UPDATE sessions
  SET status = ?
  WHERE id = ?
`);

const clearFeaturedSessionsStmt = db.prepare(`
  UPDATE sessions
  SET is_featured = 0
`);

const setFeaturedSessionStmt = db.prepare(`
  UPDATE sessions
  SET is_featured = 1
  WHERE id = ?
`);

const ACTIVE_BOOKING_WHERE = `
  payment_status = 'paid'
    AND (
      is_credited = 0
      OR stripe_session_id LIKE 'credit-%'
      OR stripe_session_id LIKE 'carry-%'
    )
`;

const countConfirmedBookingsStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM bookings
  WHERE session_id = ?
    AND ${ACTIVE_BOOKING_WHERE}
`);

const insertBookingStmt = db.prepare(`
  INSERT INTO bookings (
    session_id,
    stripe_session_id,
    payment_status,
    customer_name,
    customer_email,
    customer_phone,
    player_count,
    guest_names,
    is_manual,
    is_credited
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const findAnyBookingByStripeSessionStmt = db.prepare(`
  SELECT *
  FROM bookings
  WHERE stripe_session_id = ?
  LIMIT 1
`);

const listBookingsStmt = db.prepare(`
  SELECT *
  FROM bookings
  WHERE session_id = ?
  ORDER BY created_at DESC, id DESC
`);

const getBookingByIdStmt = db.prepare(`
  SELECT *
  FROM bookings
  WHERE id = ?
`);

const markBookingRefundedStmt = db.prepare(`
  UPDATE bookings
  SET payment_status = 'refunded'
  WHERE id = ?
`);

const markBookingCreditedStmt = db.prepare(`
  UPDATE bookings
  SET is_credited = 1
  WHERE id = ?
`);

const listActiveBookingsBySessionStmt = db.prepare(`
  SELECT *
  FROM bookings
  WHERE session_id = ?
    AND ${ACTIVE_BOOKING_WHERE}
  ORDER BY id ASC
`);

// Seed default sessions
for (const s of DEFAULT_SESSIONS) {
  insertSessionStmt.run(
    s.id,
    s.title,
    s.date,
    s.time,
    s.location,
    s.pricePence,
    s.capacity,
    s.status
  );
}

ensureFutureThursdaySessions();

// -----------------------------
// Helpers
// -----------------------------
function mapSessionRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    date: row.date,
    time: row.time,
    location: row.location,
    pricePence: row.price_pence,
    capacity: row.capacity,
    status: row.status,
    isFeatured: Boolean(row.is_featured),
    description: `${row.capacity} spaces • ${row.location} • ${row.time}`
  };
}

function getAvailabilityForSession(sessionId) {
  const row = getSessionByIdStmt.get(sessionId);
  const session = mapSessionRow(row);

  if (!session) return null;

  const booked = countConfirmedBookingsStmt.get(session.id).count;
  const remaining = Math.max(session.capacity - booked, 0);

  return {
    ...session,
    booked,
    remaining,
    isFull: remaining <= 0
  };
}

function getNextAvailableSession() {
  const row = getNextOpenSessionStmt.get();
  if (!row) return null;
  return getAvailabilityForSession(row.id);
}

function parseIsoDate(dateString) {
  const [year, month, day] = String(dateString || "").split("-").map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

function addDays(dateString, days) {
  const date = parseIsoDate(dateString);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getWeekdayUtc(dateString) {
  return parseIsoDate(dateString).getUTCDay();
}

function toSessionId(dateString) {
  return `thursday-${dateString}`;
}

function buildSessionSeed(dateString) {
  return {
    id: toSessionId(dateString),
    title: DEFAULT_SESSION_TEMPLATE.title,
    date: dateString,
    time: DEFAULT_SESSION_TEMPLATE.time,
    location: DEFAULT_SESSION_TEMPLATE.location,
    pricePence: DEFAULT_SESSION_TEMPLATE.pricePence,
    capacity: DEFAULT_SESSION_TEMPLATE.capacity,
    status: DEFAULT_SESSION_TEMPLATE.status
  };
}

function getAutoGenerationStartDate() {
  const latestRow = getLatestSessionStmt.get();
  if (latestRow?.date) {
    return latestRow.date;
  }

  const todayIso = getLondonTodayIso();
  let candidate = todayIso;

  while (getWeekdayUtc(candidate) !== 4) {
    candidate = addDays(candidate, 1);
  }

  return candidate;
}

function ensureFutureThursdaySessions(minOpenSessions = AUTO_GENERATE_WEEKS) {
  let openCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sessions
    WHERE status = 'open'
  `).get().count;

  let cursorDate = getAutoGenerationStartDate();

  while (openCount < minOpenSessions) {
    cursorDate = addDays(cursorDate, 7);

    if (getWeekdayUtc(cursorDate) !== 4) {
      continue;
    }

    const session = buildSessionSeed(cursorDate);

    insertSessionStmt.run(
      session.id,
      session.title,
      session.date,
      session.time,
      session.location,
      session.pricePence,
      session.capacity,
      session.status
    );

    const insertedRow = getSessionByIdStmt.get(session.id);
    if (insertedRow?.status === "open") {
      openCount += 1;
    }
  }
}

function getLondonTodayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function isSessionBookableToday(session, todayIso = getLondonTodayIso()) {
  if (!session || session.status !== "open") {
    return false;
  }

  return todayIso <= session.date;
}

function shouldArchiveSession(session, todayIso = getLondonTodayIso()) {
  if (!session) {
    return false;
  }

  const rolloverDate = addDays(session.date, 3);
  return todayIso >= rolloverDate;
}

function getFeaturedAvailableSession() {
  ensureFutureThursdaySessions();
  const featuredRow = getFeaturedSessionStmt.get();

  if (featuredRow && featuredRow.status === "open") {
    return getAvailabilityForSession(featuredRow.id);
  }

  if (featuredRow && featuredRow.status !== "open") {
    clearFeaturedSessionsStmt.run();
  }

  const nextSession = getNextAvailableSession();

  if (!nextSession) {
    return null;
  }

  clearFeaturedSessionsStmt.run();
  setFeaturedSessionStmt.run(nextSession.id);
  return getAvailabilityForSession(nextSession.id);
}

function syncFeaturedSession(todayIso = getLondonTodayIso()) {
  let featured = getFeaturedAvailableSession();

  while (featured && shouldArchiveSession(featured, todayIso)) {
    updateSessionStatusStmt.run("archived", featured.id);
    featured = advanceFeaturedSession(featured);
  }

  return featured;
}

function getPublicBookingSession() {
  const todayIso = getLondonTodayIso();
  const featured = syncFeaturedSession(todayIso);

  if (!featured || !isSessionBookableToday(featured, todayIso)) {
    return null;
  }

  return featured;
}

function getPublicBookingErrorMessage() {
  const todayIso = getLondonTodayIso();
  const featured = syncFeaturedSession(todayIso);

  if (featured && !isSessionBookableToday(featured, todayIso)) {
    return "Bookings for next Thursday go live on Sunday.";
  }

  return "No open session available.";
}

function advanceFeaturedSession(currentSession) {
  const nextSessionRow = currentSession
    ? getNextOpenSessionAfterStmt.get(currentSession.date, currentSession.date, currentSession.time)
    : null;
  const nextSession = nextSessionRow
    ? getAvailabilityForSession(nextSessionRow.id)
    : getNextAvailableSession();

  clearFeaturedSessionsStmt.run();

  if (!nextSession) {
    return null;
  }

  setFeaturedSessionStmt.run(nextSession.id);
  return getAvailabilityForSession(nextSession.id);
}

function moveCancelledBookingsToNextSession(currentSession, nextSession) {
  const bookingsToMove = listActiveBookingsBySessionStmt.all(currentSession.id);

  if (!bookingsToMove.length) {
    return 0;
  }

  if (nextSession.remaining < bookingsToMove.length) {
    throw new Error("Not enough spaces in the following week to move every player.");
  }

  const moveBookings = db.transaction(() => {
    for (const booking of bookingsToMove) {
      insertBookingStmt.run(
        nextSession.id,
        `carry-${Date.now()}-${booking.id}`,
        "paid",
        booking.customer_name,
        booking.customer_email || "",
        booking.customer_phone || "",
        booking.player_count || 1,
        booking.guest_names || JSON.stringify([]),
        booking.is_manual || 0,
        1
      );

      markBookingCreditedStmt.run(booking.id);
    }
  });

  moveBookings();
  return bookingsToMove.length;
}

function parsePlayersMetadata(rawPlayers) {
  let players = [];

  try {
    players = JSON.parse(rawPlayers || "[]");
  } catch (e) {
    players = [];
  }

  return Array.isArray(players)
    ? players.filter((p) => p && typeof p.name === "string" && p.name.trim())
    : [];
}

function isTransferBookingRow(booking) {
  return typeof booking?.stripe_session_id === "string" && (
    booking.stripe_session_id.startsWith("credit-")
    || booking.stripe_session_id.startsWith("carry-")
  );
}

async function finalizeCheckoutSession(checkoutSession) {
  const existing = findAnyBookingByStripeSessionStmt.get(checkoutSession.id);
  if (existing) {
    return { ok: true, inserted: false };
  }

  if (checkoutSession.payment_status !== "paid") {
    return { ok: false, error: "Payment not completed." };
  }

  const bookingSessionId = checkoutSession.metadata?.sessionId;
  if (!bookingSessionId) {
    return { ok: false, error: "Missing booking session." };
  }

  const players = parsePlayersMetadata(checkoutSession.metadata?.players);
  if (!players.length) {
    return { ok: false, error: "No players found on payment." };
  }

  const bookedSession = getAvailabilityForSession(bookingSessionId);
  if (!bookedSession) {
    return { ok: false, error: "Booked session not found." };
  }

  if (bookedSession.booked + players.length > bookedSession.capacity) {
    console.warn("Booking paid after session reached capacity:", checkoutSession.id);
    return { ok: false, error: "Session is already full." };
  }

  const insertMany = db.transaction((playersToInsert) => {
    for (const player of playersToInsert) {
      insertBookingStmt.run(
        bookingSessionId,
        checkoutSession.id,
        "paid",
        player.name.trim(),
        player.email || "",
        player.phone || "",
        1,
        JSON.stringify([]),
        0,
        0
      );
    }
  });

  insertMany(players);

  const leadPlayer = players[0];
  if (leadPlayer?.email) {
    try {
      await sendConfirmationEmail({
        name: leadPlayer.name,
        email: leadPlayer.email,
        session: bookedSession,
        players
      });
    } catch (emailErr) {
      console.error("Failed to send confirmation email:", emailErr.message);
    }
  }

  return {
    ok: true,
    inserted: true,
    session: getAvailabilityForSession(bookingSessionId)
  };
}

async function finalizeCheckoutSessionById(checkoutSessionId) {
  const checkoutSession = await stripe.checkout.sessions.retrieve(checkoutSessionId);
  return finalizeCheckoutSession(checkoutSession);
}

if (!getFeaturedSessionStmt.get()) {
  const nextSession = getNextAvailableSession();
  if (nextSession) {
    setFeaturedSessionStmt.run(nextSession.id);
  }
}

function requireAdmin(req, res) {
  const password = req.headers["x-admin-password"];
  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function bookingSessionAmountPence(sessionId) {
  const row = getSessionByIdStmt.get(sessionId);
  if (!row) return 0;
  return Number(row.price_pence || 0);
}

// -----------------------------
// Email
// -----------------------------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendConfirmationEmail({ name, email, session, players }) {
  const subject = `Booking confirmed - ${session.title}`;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: email,
    subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: auto; padding: 20px;">
        <h2 style="margin-bottom: 10px;">Your booking is confirmed</h2>

        <p style="margin: 0 0 16px;">
          Hi ${name}, your place for Thursday football is confirmed.
        </p>

        <div style="padding: 16px; border-radius: 12px; background: #f5f3ef; border: 1px solid #e2ddd5; margin-bottom: 16px;">
          <strong>${session.title}</strong><br/>
          Date: ${session.date}<br/>
          Time: ${session.time}<br/>
          Venue: ${session.location}<br/>
          Players booked: ${players.length}
        </div>

        <p><strong>Players:</strong><br/>${players.map((p) => p.name).join("<br/>")}</p>

        <p style="margin-top: 16px;">
          If you cannot make it, let me know as early as possible and I will try to fill your spot.
        </p>

        <p style="margin-top: 16px; padding: 14px 16px; border-radius: 12px; background: #edf6eb; border: 1px solid #cfe0cf; color: #214933;">
          If you do not see future emails from us, please check your junk or spam folder and mark them as safe.
        </p>

        <p style="margin-top: 24px; color: #6b6b6b;">
          See you there.
        </p>
      </div>
    `
  });
}

// -----------------------------
// Webhook
// -----------------------------
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("Webhook received");

    const signature = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === "checkout.session.completed") {
        const checkoutSession = event.data.object;
        await finalizeCheckoutSession(checkoutSession);
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("Webhook processing error:", err);
      return res.status(500).json({ error: "Webhook processing failed" });
    }
  }
);

// -----------------------------
// Standard middleware
// -----------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// -----------------------------
// Public routes
// -----------------------------
app.get("/api/session", (req, res) => {
  const session = getPublicBookingSession();

  if (!session) {
    return res.status(404).json({ error: getPublicBookingErrorMessage() });
  }

  res.json(session);
});

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    let { players } = req.body || {};

    players = Array.isArray(players) ? players : [];

    players = players
      .map((player) => ({
        name: String(player?.name || "").trim(),
        email: String(player?.email || "").trim(),
        phone: String(player?.phone || "").trim()
      }))
      .filter((player) => player.name);

    if (!players.length) {
      return res.status(400).json({ error: "At least one player is required." });
    }

    if (!players[0].email) {
      return res.status(400).json({ error: "Lead player email is required." });
    }

    if (players.length > 4) {
      return res.status(400).json({ error: "Invalid number of players." });
    }

    const availability = getPublicBookingSession();

    if (!availability) {
      return res.status(400).json({ error: getPublicBookingErrorMessage() });
    }

    if (availability.remaining < players.length) {
      return res.status(400).json({
        error: `Only ${availability.remaining} space(s) left.`
      });
    }

    const totalAmount = availability.pricePence * players.length;

    console.log("Creating checkout session...");
    console.log("Stripe key prefix:", process.env.STRIPE_SECRET_KEY.slice(0, 7));
    console.log("Base URL:", BASE_URL);

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancel.html`,
      customer_email: players[0].email,
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: availability.title,
              description: `${availability.date} • ${availability.time} • ${players.length} player(s)`
            },
            unit_amount: totalAmount
          },
          quantity: 1
        }
      ],
      metadata: {
        sessionId: availability.id,
        players: JSON.stringify(players)
      }
    });

    return res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    return res.status(500).json({
      error: err?.message || "Could not create checkout session."
    });
  }
});

app.post("/api/checkout/confirm", async (req, res) => {
  try {
    const checkoutSessionId = String(req.body?.sessionId || "").trim();

    if (!checkoutSessionId) {
      return res.status(400).json({ error: "Checkout session ID is required." });
    }

    const result = await finalizeCheckoutSessionById(checkoutSessionId);

    if (!result.ok) {
      return res.status(400).json({ error: result.error || "Could not confirm booking." });
    }

    return res.json({
      ok: true,
      inserted: result.inserted,
      session: result.session || null
    });
  } catch (error) {
    console.error("Checkout confirmation error:", error);
    return res.status(500).json({ error: "Could not confirm booking." });
  }
});

// -----------------------------
// Admin routes
// -----------------------------
app.get("/api/admin/bookings", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const currentSession = syncFeaturedSession();

  if (!currentSession) {
    return res.json({
      session: null,
      bookings: []
    });
  }

  const bookings = listBookingsStmt.all(currentSession.id);

  res.json({
    session: currentSession,
    bookings
  });
});

app.post("/api/admin/session/close", (req, res) => {
  if (!requireAdmin(req, res)) return;

  ensureFutureThursdaySessions();
  const currentSession = syncFeaturedSession();
  if (!currentSession) {
    return res.status(400).json({ error: "No open session available." });
  }

  updateSessionStatusStmt.run("closed", currentSession.id);
  const nextSession = advanceFeaturedSession(currentSession);
  res.json({ ok: true, nextSession });
});

app.post("/api/admin/session/cancel", (req, res) => {
  if (!requireAdmin(req, res)) return;

  ensureFutureThursdaySessions();
  const currentSession = syncFeaturedSession();
  if (!currentSession) {
    return res.status(400).json({ error: "No open session available." });
  }

  const nextSessionRow = getNextOpenSessionAfterStmt.get(
    currentSession.date,
    currentSession.date,
    currentSession.time
  );

  if (!nextSessionRow) {
    return res.status(400).json({ error: "No following open session available." });
  }

  const nextSession = getAvailabilityForSession(nextSessionRow.id);
  if (!nextSession) {
    return res.status(400).json({ error: "Next session not found." });
  }

  try {
    moveCancelledBookingsToNextSession(currentSession, nextSession);
  } catch (error) {
    return res.status(400).json({ error: error.message || "Could not move players." });
  }

  updateSessionStatusStmt.run("cancelled", currentSession.id);
  clearFeaturedSessionsStmt.run();
  setFeaturedSessionStmt.run(nextSession.id);
  res.json({ ok: true, nextSession });
});

app.post("/api/admin/manual-booking", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { name, email, phone } = req.body || {};

  if (!name) {
    return res.status(400).json({ error: "Name is required." });
  }

  const currentSession = getPublicBookingSession();
  if (!currentSession) {
    return res.status(400).json({ error: "No open session available." });
  }

  if (currentSession.remaining < 1) {
    return res.status(400).json({ error: "Session is full." });
  }

  const manualStripeId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  insertBookingStmt.run(
    currentSession.id,
    manualStripeId,
    "paid",
    name,
    email || "",
    phone || "",
    1,
    JSON.stringify([]),
    1,
    0
  );

  res.json({ ok: true });
});

app.post("/api/admin/booking/refund", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { bookingId } = req.body || {};
  const booking = getBookingByIdStmt.get(bookingId);

  if (!booking) {
    return res.status(404).json({ error: "Booking not found." });
  }

  if (booking.payment_status === "refunded") {
    return res.status(400).json({ error: "Booking already refunded." });
  }

  if (booking.stripe_session_id && !booking.stripe_session_id.startsWith("manual-")) {
    try {
      const relatedBookings = db
        .prepare(`
          SELECT *
          FROM bookings
          WHERE stripe_session_id = ?
            AND payment_status = 'paid'
          ORDER BY id ASC
        `)
        .all(booking.stripe_session_id);

      if (!relatedBookings.length) {
        return res.status(400).json({ error: "No paid bookings found for this payment." });
      }

      const paidCount = relatedBookings.length;
      const refundAmount = Math.round(bookingSessionAmountPence(booking.session_id) / paidCount);

      const session = await stripe.checkout.sessions.retrieve(booking.stripe_session_id, {
        expand: ["payment_intent"]
      });

      const paymentIntentId = session.payment_intent?.id;
      if (paymentIntentId) {
        await stripe.refunds.create({
          payment_intent: paymentIntentId,
          amount: refundAmount
        });
      }
    } catch (err) {
      console.error("Stripe refund failed:", err.message);
      return res.status(500).json({ error: "Stripe refund failed." });
    }
  }

  markBookingRefundedStmt.run(bookingId);
  res.json({ ok: true });
});

app.post("/api/admin/booking/credit", (req, res) => {
  if (!requireAdmin(req, res)) return;

  ensureFutureThursdaySessions();
  const { bookingId } = req.body || {};
  const booking = getBookingByIdStmt.get(bookingId);

  if (!booking) {
    return res.status(404).json({ error: "Booking not found." });
  }

  if (booking.is_credited && !isTransferBookingRow(booking)) {
    return res.status(400).json({ error: "Booking already credited." });
  }

  const currentSessionRow = getSessionByIdStmt.get(booking.session_id);
  if (!currentSessionRow) {
    return res.status(400).json({ error: "Current session not found." });
  }

  const nextSessionRow = getNextOpenSessionAfterStmt.get(
    currentSessionRow.date,
    currentSessionRow.date,
    currentSessionRow.time
  );

  if (!nextSessionRow) {
    return res.status(400).json({ error: "No next open session available." });
  }

  const nextSession = getAvailabilityForSession(nextSessionRow.id);
  if (!nextSession) {
    return res.status(400).json({ error: "Next session not found." });
  }

  if (nextSession.remaining < 1) {
    return res.status(400).json({ error: "Not enough spaces in next session." });
  }

  insertBookingStmt.run(
    nextSession.id,
    `credit-${Date.now()}-${booking.id}`,
    "paid",
    booking.customer_name,
    booking.customer_email || "",
    booking.customer_phone || "",
    1,
    JSON.stringify([]),
    booking.is_manual || 0,
    1
  );

  markBookingCreditedStmt.run(bookingId);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running on ${BASE_URL}`);
  console.log("Stripe key loaded:", !!process.env.STRIPE_SECRET_KEY);
  console.log("Stripe key prefix:", process.env.STRIPE_SECRET_KEY?.slice(0, 7));
  console.log("DB path:", dbPath);
});
