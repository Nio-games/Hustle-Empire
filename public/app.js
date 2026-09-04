let token = localStorage.getItem("he_token");
let state = null;

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  opts.headers = {
    ...(opts.headers || {}),
    "Content-Type": "application/json"
  };

  if (token) {
    opts.headers.Authorization = "Bearer " + token;
  }

  const response = await fetch(path, opts);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw Error(data.error || "Something went wrong. Please try again.");
  }

  return data;
}

function showMessage(message, success = false) {
  const msg = $("msg");

  if (!msg) return;

  msg.textContent = message;
  msg.classList.toggle("success", success);
}

function showGame() {
  $("auth").hidden = true;
  $("game").hidden = false;
  refresh();
}

function validateAccount(username, password) {
  username = username.trim();

  if (!username) {
    return "Please enter a username.";
  }

  if (username.length < 3) {
    return "Username must be at least 3 characters.";
  }

  if (username.length > 24) {
    return "Username must be 24 characters or less.";
  }

  if (!/^[A-Za-z0-9_]+$/.test(username)) {
    return "Username can only use letters, numbers, and _.";
  }

  if (!password) {
    return "Please enter a password.";
  }

  if (password.length < 8) {
    return "Password must be at least 8 characters.";
  }

  return null;
}

async function register() {
  const username = $("u").value.trim();
  const password = $("p").value;

  const validationError = validateAccount(username, password);

  if (validationError) {
    showMessage(validationError);
    return;
  }

  const button = $("authButton");

  try {
    button.disabled = true;
    button.textContent = "Creating Account...";

    showMessage("Creating your empire...");

    const data = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({
        username,
        password
      })
    });

    token = data.token;

    localStorage.setItem("he_token", token);

    showMessage("Account created!", true);

    showGame();

  } catch (error) {
    showMessage(error.message || "Unable to create account.");
  } finally {
    button.disabled = false;

    if (typeof authMode === "undefined" || authMode === "register") {
      button.textContent = "Create Account";
    }
  }
}

async function login() {
  const username = $("u").value.trim();
  const password = $("p").value;

  if (!username || !password) {
    showMessage("Enter your username and password.");
    return;
  }

  const button = $("authButton");

  try {
    button.disabled = true;
    button.textContent = "Logging In...";

    showMessage("Logging you in...");

    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username,
        password
      })
    });

    token = data.token;

    localStorage.setItem("he_token", token);

    showGame();

  } catch (error) {
    showMessage(error.message || "Unable to log in.");
  } finally {
    button.disabled = false;

    if (typeof authMode === "undefined" || authMode === "login") {
      button.textContent = "Log In";
    }
  }
}

function logout() {
  localStorage.removeItem("he_token");
  token = null;
  state = null;
  location.reload();
}

async function refresh() {
  if (!token) return;

  try {
    state = await api("/api/state");
    render();

  } catch (error) {
    localStorage.removeItem("he_token");

    token = null;

    $("auth").hidden = false;
    $("game").hidden = true;

    showMessage(error.message);
  }
}

function money(value) {
  return "$" + Number(value).toLocaleString(undefined, {
    maximumFractionDigits: 0
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function render() {
  if (!state || !state.player) return;

  const player = state.player;

  const businesses = Array.isArray(state.businesses)
    ? state.businesses
    : [];

  const catalog = Array.isArray(state.catalog)
    ? state.catalog
    : [];

  $("cash").textContent = money(player.cash);
  $("rate").textContent = money(player.perSec) + "/s";
  $("rebirths").textContent = player.rebirths;
  $("businessCount").textContent = businesses.length;

  $("businesses").innerHTML = businesses.map((owned) => {
    const business = catalog.find(
      (item) => item.id === owned.business_id
    );

    if (!business) return "";

    const buyCost =
      business.baseCost * Math.pow(1.15, owned.level);

    const upgradeCost =
      business.baseCost * 2 * Math.pow(1.7, owned.upgrade);

    const employeeCost =
      business.baseCost * 0.75;

    return `
      <article class="business-card">

        <div>
          <h3>${escapeHtml(business.name)}</h3>

          <small>
            Level ${owned.level}
            · Employees ${owned.employees}
            · Upgrades ${owned.upgrade}
          </small>

          <br>

          <small>
            Base income ${money(business.income)}/s
          </small>
        </div>

        <div class="business-actions">

          <button onclick="act('/api/business/buy','${business.id}')">
            Buy ${money(buyCost)}
          </button>

          <button onclick="act('/api/business/upgrade','${business.id}')">
            Upgrade ${money(upgradeCost)}
          </button>

          <button onclick="act('/api/business/employee','${business.id}')">
            Hire ${money(employeeCost)}
          </button>

        </div>

      </article>
    `;
  }).join("");
}

async function act(path, id) {
  try {
    await api(path, {
      method: "POST",
      body: JSON.stringify({
        businessId: id
      })
    });

    await refresh();

  } catch (error) {
    alert(error.message);
  }
}

async function daily() {
  try {
    const data = await api(
      "/api/reward/daily",
      { method: "POST" }
    );

    alert("Reward: " + money(data.reward));

    await refresh();

  } catch (error) {
    alert(error.message);
  }
}

async function rebirth() {
  if (!confirm(
    "Rebirth resets businesses but increases your prestige. Continue?"
  )) {
    return;
  }

  try {
    await api("/api/rebirth", {
      method: "POST"
    });

    await refresh();

  } catch (error) {
    alert(error.message);
  }
}

async function leaderboard() {
  try {
    const data = await api("/api/leaderboard");

    const rows = Array.isArray(data)
      ? data
      : [];

    $("board").innerHTML = `
      <div class="leader-row leader-head">
        <div>#</div>
        <div>Player</div>
        <div>Rebirths</div>
        <div>Lifetime Cash</div>
      </div>

      ${rows.map((player) => `
        <div class="leader-row">
          <div>${player.rank}</div>
          <div>${escapeHtml(player.username)}</div>
          <div>${player.rebirths}</div>
          <div>${money(player.lifetimeCash)}</div>
        </div>
      `).join("")}
    `;

  } catch (error) {
    alert(error.message);
  }
}

if (token) {
  showGame();
}

setInterval(() => {
  if (token) {
    refresh();
  }
}, 5000);
window.register = register;
window.login = login;
window.logout = logout;
window.act = act;
window.daily = daily;
window.rebirth = rebirth;
window.leaderboard = leaderboard;
