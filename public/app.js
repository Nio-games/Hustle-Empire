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
    throw Error(data.error || "Request failed");
  }

  return data;
}

function showGame() {
  $("auth").hidden = true;
  $("game").hidden = false;
  refresh();
}

async function register() {
  try {
    const data = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({
        username: $("u").value,
        password: $("p").value
      })
    });

    token = data.token;
    localStorage.setItem("he_token", token);
    showGame();
  } catch (error) {
    $("msg").textContent = error.message;
  }
}

async function login() {
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("u").value,
        password: $("p").value
      })
    });

    token = data.token;
    localStorage.setItem("he_token", token);
    showGame();
  } catch (error) {
    $("msg").textContent = error.message;
  }
}

function logout() {
  localStorage.removeItem("he_token");
  token = null;
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
    $("msg").textContent = error.message;
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
