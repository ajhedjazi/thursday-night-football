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

// Change this to your actual session/game details
const SESSION = {
  id: "thursday-7pm",
  title: "Thursday 7pm Kickabout",
  description: "12 spaces • Astro • 7:00pm",
  location: "Goals / Astro Centre",
  date: "2026-04-23",
  time: "19:00",
  pricePence: 500,
  capacity: 12
};

// -----------------------------
// Database
// -----------------------------
const db = new Database("bookings.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    stripe_session_id TEXT NOT NULL UNIQUE,
    payment_status TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const countConfirmedBookingsStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM bookings
  WHERE session_id = ? AND payment_status = 'paid'
`);

const insertBookingStmt = db.prepare(`
  INSERT INTO bookings (
    session_id,
    stripe_session_id,
    payment_status,
    customer_name,
    customer_email,
    customer_phone
  ) VALUES (?, ?, ?, ?, ?, ?)
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

async function sendConfirmationEmail({ name, email }) {
  const subject = `Booking confirmed - ${SESSION.title}`;
  const text = `
Hi ${name},

Your booking is confirmed.

Session: ${SESSION.title}
Date: ${SESSION.date}
Time: ${SESSION.time}
Location: ${SESSION.location}
Paid: £${(SESSION.pricePence / 100).toFixed(2)}

See you there.
`;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: email,
    subject,
    text
  });
}

// -----------------------------
// Middleware
// -----------------------------
// Webhook route needs raw body
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

        const sessionId = checkoutSession.metadata?.sessionId;
        const customerName = checkoutSession.metadata?.playerName || "Player";
        const customerEmail = checkoutSession.metadata?.playerEmail || "";
        const customerPhone = checkoutSession.metadata?.playerPhone || "";

        if (sessionId !== SESSION.id) {
          return res.json({ received: true });
        }

        const confirmedCount = countConfirmedBookingsStmt.get(SESSION.id).count;

        // Safety check in case two people complete at the same time.
        // This sample simply stops inserting once full.
        if (confirmedCount >= SESSION.capacity) {
          console.warn("Booking paid after session reached capacity:", checkoutSession.id);
          return res.json({ received: true });
        }

        insertBookingStmt.run(
          SESSION.id,
          checkoutSession.id,
          "paid",
          customerName,
          customerEmail,
          customerPhone
        );

        if (customerEmail) {
          try {
            await sendConfirmationEmail({
              name: customerName,
              email: customerEmail
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

// Standard JSON parser for everything else
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// -----------------------------
// Helpers
// -----------------------------
function getAvailability() {
  const booked = countConfirmedBookingsStmt.get(SESSION.id).count;
  const remaining = Math.max(SESSION.capacity - booked, 0);

  return {
    ...SESSION,
    booked,
    remaining,
    isFull: remaining <= 0
  };
}

// -----------------------------
// Routes
// -----------------------------
app.get("/api/session", (req, res) => {
  res.json(getAvailability());
});

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { name, email, phone } = req.body || {};

    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required." });
    }

    const availability = getAvailability();

    if (availability.isFull) {
      return res.status(400).json({ error: "This session is full." });
    }

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
              name: SESSION.title,
              description: SESSION.description
            },
            unit_amount: SESSION.pricePence
          },
          quantity: 1
        }
      ],
      metadata: {
        sessionId: SESSION.id,
        playerName: name,
        playerEmail: email,
        playerPhone: phone || ""
      }
    });

    return res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not create checkout session." });
  }
});

app.get("/api/admin/bookings", (req, res) => {
  const password = req.headers["x-admin-password"];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const availability = getAvailability();
  const bookings = listBookingsStmt.all(SESSION.id);

  res.json({
    session: availability,
    bookings
  });
});

app.listen(PORT, () => {
  console.log(`Server running on ${BASE_URL}`);
});