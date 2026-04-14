const titleEl = document.getElementById("title");
const metaEl = document.getElementById("meta");
const availabilityEl = document.getElementById("availability");
const formEl = document.getElementById("booking-form");
const messageEl = document.getElementById("message");
const submitBtn = document.getElementById("submit-btn");

async function loadSession() {
  const res = await fetch("/api/session");
  const session = await res.json();

  titleEl.textContent = session.title;
  metaEl.textContent = `${session.capacity} spaces • £${(session.pricePence / 100).toFixed(2)} • ${session.location}`;
  availabilityEl.textContent = session.isFull
    ? "This session is now full."
    : `${session.remaining} space(s) left`;

  if (session.isFull) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Session full";
  }
}

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  messageEl.textContent = "";
  submitBtn.disabled = true;
  submitBtn.textContent = "Please wait...";

  const payload = {
    name: document.getElementById("name").value.trim(),
    email: document.getElementById("email").value.trim(),
    phone: document.getElementById("phone").value.trim()
  };

  try {
    const res = await fetch("/api/create-checkout-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Something went wrong.");
    }

    window.location.href = data.url;
  } catch (err) {
    messageEl.textContent = err.message;
    submitBtn.disabled = false;
    submitBtn.textContent = "Book & Pay";
    await loadSession();
  }
});

loadSession();