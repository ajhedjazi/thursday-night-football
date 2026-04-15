const titleEl = document.getElementById("title");
const metaEl = document.getElementById("meta");
const availabilityEl = document.getElementById("availability");
const formEl = document.getElementById("booking-form");
const messageEl = document.getElementById("message");
const submitBtn = document.getElementById("submit-btn");
const playerCountEl = document.getElementById("player-count");
const guestFieldsEl = document.getElementById("guest-fields");
const totalPriceEl = document.getElementById("total-price");

let currentSession = null;

function renderGuestFields() {
  const count = Number(playerCountEl.value);
  guestFieldsEl.innerHTML = "";

  for (let i = 2; i <= count; i++) {
    const wrapper = document.createElement("label");
    wrapper.innerHTML = `
  Guest ${i} name
  <input type="text" id="guest-${i}" name="guest-${i}" required />
`;
    guestFieldsEl.appendChild(wrapper);
  }

  updateTotalPrice();
}

function updateTotalPrice() {
  if (!currentSession) return;
  const count = Number(playerCountEl.value);
  const total = (currentSession.pricePence * count) / 100;
  totalPriceEl.textContent = `Total to pay: £${total.toFixed(2)}`;
}

async function loadSession() {
  const res = await fetch("/api/session");
  const session = await res.json();
  currentSession = session;

  titleEl.textContent = session.title;
  metaEl.textContent = `${session.capacity} spaces • £${(session.pricePence / 100).toFixed(2)} per player • ${session.location}`;
  availabilityEl.textContent = session.isFull
    ? "This session is now full."
    : `${session.remaining} space(s) left`;

  if (session.isFull) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Session full";
  } else {
    submitBtn.disabled = false;
    submitBtn.textContent = "Book & Pay";
  }

  renderGuestFields();
}

playerCountEl.addEventListener("change", () => {
  renderGuestFields();

  if (currentSession) {
    const requested = Number(playerCountEl.value);
    if (requested > currentSession.remaining) {
      messageEl.textContent = `Only ${currentSession.remaining} space(s) left.`;
      submitBtn.disabled = true;
    } else {
      messageEl.textContent = "";
      submitBtn.disabled = false;
    }
  }
});

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  messageEl.textContent = "";

  const playerCount = Number(playerCountEl.value);

  if (currentSession && playerCount > currentSession.remaining) {
    messageEl.textContent = `Only ${currentSession.remaining} space(s) left.`;
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Please wait...";

  const guestNames = [];
  for (let i = 2; i <= playerCount; i++) {
    const input = document.getElementById(`guest-${i}`);
    if (input && input.value.trim()) {
      guestNames.push(input.value.trim());
    }
  }

  const payload = {
    name: document.getElementById("name").value.trim(),
    email: document.getElementById("email").value.trim(),
    phone: document.getElementById("phone").value.trim(),
    playerCount,
    guestNames
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