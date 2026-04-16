require("dotenv").config();

const express = require("express");
const path = require("path");
const Stripe = require("stripe");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// -----------------------------
// Config
// -----------------------------
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";

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
const dbPath = process.env.DB_PATH || "bookings.db";
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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Create bookings table
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    stripe_session_id TEXT NOT NULL UNIQUE,
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

const updateSessionStatusStmt = db.prepare(`
  UPDATE sessions
  SET status = ?
  WHERE id = ?
`);

const countConfirmedBookingsStmt = db.prepare(`
  SELECT COALESCE(SUM(player_count), 0) AS count
  FROM bookings
  WHERE session_id = ?
    AND payment_status = 'paid'
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

const findBookingByStripeSessionStmt = db.prepare(`
  SELECT *
  FROM bookings
  WHERE stripe_session_id = ?
`);

const listBookingsStmt = db.prepare(`
  SELECT *
  FROM bookings
  WHERE session_id = ?
  ORDER BY created_at DESC
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

function requireAdmin(req, res) {
  const password = req.headers["x-admin-password"];
  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
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

async function sendConfirmationEmail({ name, email, session, playerCount, guestNames }) {
  const subject = `You're booked ⚽ ${session.title}`;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: email,
    subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: auto; padding: 20px;">
        <h2 style="margin-bottom: 10px;">You're in ⚽</h2>

        <p style="margin: 0 0 16px;">
          Hi ${name}, your spot is confirmed.
        </p>

        <div style="padding: 16px; border-radius: 12px; background: #f5f3ef; border: 1px solid #e2ddd5; margin-bottom: 16px;">
          <strong>${session.title}</strong><br/>
          ${session.date}<br/>
          ${session.time}<br/>
          ${session.location}<br/>
          Players booked: ${playerCount}
        </div>

        ${
          guestNames.length
            ? `<p><strong>Players:</strong><br/>${[name, ...guestNames].join("<br/>")}</p>`
            : ""
        }

        <p style="margin-top: 16px;">
          If you can't make it, let me know early and I’ll try to fill your spot.
        </p>

        <p style="margin-top: 24px; color: #6b6b6b;">
          See you there ⚽
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

        const existing = findBookingByStripeSessionStmt.get(checkoutSession.id);
        if (existing) {
          return res.json({ received: true });
        }

        const bookingSessionId = checkoutSession.metadata?.sessionId;
        if (!bookingSessionId) {
          return res.json({ received: true });
        }

        const customerName = checkoutSession.metadata?.playerName || "Player";
        const customerEmail = checkoutSession.metadata?.playerEmail || "";
        const customerPhone = checkoutSession.metadata?.playerPhone || "";
        const playerCount = Number(checkoutSession.metadata?.playerCount || 1);

        let guestNames = [];
        try {
          guestNames = JSON.parse(checkoutSession.metadata?.guestNames || "[]");
        } catch (e) {
          guestNames = [];
        }

        const bookedSession = getAvailabilityForSession(bookingSessionId);
        if (!bookedSession) {
          return res.json({ received: true });
        }

        if (bookedSession.booked + playerCount > bookedSession.capacity) {
          console.warn("Booking paid after session reached capacity:", checkoutSession.id);
          return res.json({ received: true });
        }

        insertBookingStmt.run(
          bookingSessionId,
          checkoutSession.id,
          "paid",
          customerName,
          customerEmail,
          customerPhone,
          playerCount,
          JSON.stringify(guestNames),
          0,
          0
        );

        if (customerEmail) {
          try {
            await sendConfirmationEmail({
              name: customerName,
              email: customerEmail,
              session: bookedSession,
              playerCount,
              guestNames
            });
          } catch (emailErr) {
            console.error("Failed to send confirmation email:", emailErr.message);
          }
        }
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
  const session = getNextAvailableSession();

  if (!session) {
    return res.status(404).json({ error: "No open session available." });
  }

  res.json(session);
});

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { name, email, phone, playerCount, guestNames } = req.body || {};

    const count = Number(playerCount || 1);
    const safeGuestNames = Array.isArray(guestNames) ? guestNames : [];

    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required." });
    }

    if (!Number.isInteger(count) || count < 1 || count > 4) {
      return res.status(400).json({ error: "Invalid number of players." });
    }

    if (count > 1 && safeGuestNames.length !== count - 1) {
      return res.status(400).json({ error: "Please enter all guest names." });
    }

    const availability = getNextAvailableSession();

    if (!availability) {
      return res.status(400).json({ error: "No open session available." });
    }

    if (availability.remaining < count) {
      return res.status(400).json({
        error: `Only ${availability.remaining} space(s) left.`
      });
    }

    const totalAmount = availability.pricePence * count;

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${BASE_URL}/success.html`,
      cancel_url: `${BASE_URL}/cancel.html`,
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: availability.title,
              description: `${availability.date} • ${availability.time} • ${count} player(s)`
            },
            unit_amount: totalAmount
          },
          quantity: 1
        }
      ],
      metadata: {
        sessionId: availability.id,
        playerName: name,
        playerEmail: email,
        playerPhone: phone || "",
        playerCount: String(count),
        guestNames: JSON.stringify(safeGuestNames)
      }
    });

    return res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not create checkout session." });
  }
});

// -----------------------------
// Admin routes
// -----------------------------
app.get("/api/admin/bookings", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const currentSession = getNextAvailableSession();

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

  const currentSession = getNextAvailableSession();
  if (!currentSession) {
    return res.status(400).json({ error: "No open session available." });
  }

  updateSessionStatusStmt.run("closed", currentSession.id);
  res.json({ ok: true });
});

app.post("/api/admin/session/cancel", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const currentSession = getNextAvailableSession();
  if (!currentSession) {
    return res.status(400).json({ error: "No open session available." });
  }

  updateSessionStatusStmt.run("cancelled", currentSession.id);
  res.json({ ok: true });
});

app.post("/api/admin/manual-booking", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { name, email, phone } = req.body || {};

  if (!name) {
    return res.status(400).json({ error: "Name is required." });
  }

  const currentSession = getNextAvailableSession();
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
      const session = await stripe.checkout.sessions.retrieve(booking.stripe_session_id, {
        expand: ["payment_intent"]
      });

      const paymentIntentId = session.payment_intent?.id;
      if (paymentIntentId) {
        await stripe.refunds.create({
          payment_intent: paymentIntentId
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

  const { bookingId } = req.body || {};
  const booking = getBookingByIdStmt.get(bookingId);

  if (!booking) {
    return res.status(404).json({ error: "Booking not found." });
  }

  if (booking.is_credited) {
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

  if (nextSession.remaining < booking.player_count) {
    return res.status(400).json({ error: "Not enough spaces in next session." });
  }

  insertBookingStmt.run(
    nextSession.id,
    `credit-${Date.now()}-${booking.id}`,
    "paid",
    booking.customer_name,
    booking.customer_email || "",
    booking.customer_phone || "",
    booking.player_count,
    booking.guest_names || JSON.stringify([]),
    booking.is_manual || 0,
    1
  );

  markBookingCreditedStmt.run(bookingId);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running on ${BASE_URL}`);
});