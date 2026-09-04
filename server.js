import express from "express";
import pg from "pg";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const app = express();

app.use(express.json({ limit: "32kb" }));
app.use(
  express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "public"))
);

const PORT = Number(process.env.PORT || 3000);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway")
    ? { rejectUnauthorized: false }
    : undefined
});

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const SESSION_MS = Number(process.env.SESSION_DAYS || 30) * 86400000;

const BUSINESSES = [
  { id: "street-hustle", name: "Street Hustle", baseCost: 100, income: 4 },
  { id: "food-cart", name: "Food Cart", baseCost: 750, income: 24 },
  { id: "car-wash", name: "Car Wash", baseCost: 5000, income: 180 },
  { id: "nightclub", name: "Nightclub", baseCost: 50000, income: 2200 },
  { id: "shipping", name: "Shipping Empire", baseCost: 500000, income: 26000 },
  { id: "tech-firm", name: "Tech Firm", baseCost: 5000000, income: 310000 }
];

/*
  DATABASE MIGRATION
  ------------------
  This upgrades the older Hustle Empire database without deleting
  existing player records.
*/
async function migrate() {
  const columns = [
    ["password_hash", "TEXT DEFAULT ''"],
    ["cash", "NUMERIC(30,2) NOT NULL DEFAULT 500"],
    ["lifetime_cash", "NUMERIC(30,2) NOT NULL DEFAULT 500"],
    ["rebirths", "INT NOT NULL DEFAULT 0"],
    ["last_settled", "TIMESTAMPTZ NOT NULL DEFAULT now()"]
  ];

  for (const [name, definition] of columns) {
    const check = await pool.query(
      `SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'players'
          AND column_name = $1
      ) AS exists`,
      [name]
    );

    if (!check.rows[0].exists) {
      console.log(`Adding missing column: ${name}`);
      await pool.query(
        `ALTER TABLE players ADD COLUMN ${name} ${definition}`
      );
    }
  }

  const emailCheck = await pool.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'players'
        AND column_name = 'email'
    ) AS exists`
  );

  if (emailCheck.rows[0].exists) {
    await pool.query(
      `ALTER TABLE players ALTER COLUMN email DROP NOT NULL`
    );
  }

  const passwordCheck = await pool.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'players'
        AND column_name = 'password'
    ) AS exists`
  );

  if (passwordCheck.rows[0].exists) {
    await pool.query(
      `ALTER TABLE players ALTER COLUMN password DROP NOT NULL`
    );
  }

  console.log("Database migration complete");
}

async function init() {
  await migrate();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS players(
      id BIGSERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      cash NUMERIC(30,2) NOT NULL DEFAULT 500,
      lifetime_cash NUMERIC(30,2) NOT NULL DEFAULT 500,
      rebirths INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_settled TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS businesses(
      player_id BIGINT REFERENCES players(id) ON DELETE CASCADE,
      business_id TEXT,
      level INT NOT NULL DEFAULT 0,
      employees INT NOT NULL DEFAULT 0,
      upgrade INT NOT NULL DEFAULT 0,
      PRIMARY KEY(player_id, business_id)
    );

    CREATE TABLE IF NOT EXISTS sessions(
      token_hash TEXT PRIMARY KEY,
      player_id BIGINT REFERENCES players(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ledger(
      id BIGSERIAL PRIMARY KEY,
      player_id BIGINT REFERENCES players(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      amount NUMERIC(30,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  console.log("Database initialization complete");
}

function hash(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function passwordHash(
  password,
  salt = crypto.randomBytes(16).toString("hex")
) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, (e, key) =>
      e
        ? reject(e)
        : resolve(`${salt}:${key.toString("hex")}`)
    )
  );
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) {
    return Promise.resolve(false);
  }

  const [salt, hex] = stored.split(":");

  if (!salt || !hex) {
    return Promise.resolve(false);
  }

  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, (e, key) => {
      if (e) return reject(e);

      const a = Buffer.from(hex, "hex");
      const b = key;

      resolve(
        a.length === b.length &&
        crypto.timingSafeEqual(a, b)
      );
    })
  );
}

function auth(req, res, next) {
  const raw = (req.headers.authorization || "").replace(
    /^Bearer\s+/i,
    ""
  );

  if (!raw) {
    return res.status(401).json({
      error: "Login required"
    });
  }

  pool
    .query(
      `SELECT p.*
       FROM sessions s
       JOIN players p ON p.id = s.player_id
       WHERE s.token_hash = $1
         AND s.expires_at > now()`,
      [hash(raw)]
    )
    .then((r) => {
      if (!r.rowCount) {
        return res.status(401).json({
          error: "Session expired"
        });
      }

      req.player = r.rows[0];
      next();
    })
    .catch(next);
}

async function settle(playerId, client = pool) {
  const r = await client.query(
    `SELECT *
     FROM players
     WHERE id = $1
     FOR UPDATE`,
    [playerId]
  );

  if (!r.rowCount) {
    throw new Error("Player missing");
  }

  const p = r.rows[0];

  const biz = await client.query(
    `SELECT *
     FROM businesses
     WHERE player_id = $1`,
    [playerId]
  );

  let perSec = 0;

  for (const row of biz.rows) {
    const b = BUSINESSES.find(
      (x) => x.id === row.business_id
    );

    if (b) {
      perSec +=
        b.income *
        row.level *
        (1 + row.upgrade * 0.15) *
        (1 + row.employees * 0.05);
    }
  }

  const elapsed = Math.max(
    0,
    (Date.now() - new Date(p.last_settled).getTime()) / 1000
  );

  const earned = Math.min(elapsed * perSec, 1e12);

  if (earned > 0) {
    await client.query(
      `UPDATE players
       SET cash = cash + $1,
           lifetime_cash = lifetime_cash + $1,
           last_settled = now()
       WHERE id = $2`,
      [earned, playerId]
    );
  }

  return {
    earned,
    perSec
  };
}

function publicPlayer(p, perSec = 0) {
  return {
    id: p.id,
    username: p.username,
    cash: Number(p.cash),
    lifetimeCash: Number(p.lifetime_cash),
    rebirths: p.rebirths,
    perSec
  };
}

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      game: "Hustle Empire"
    });
  } catch (e) {
    console.error(e);

    res.status(503).json({
      ok: false
    });
  }
});

/*
  REGISTER
*/
app.post("/api/register", async (req, res, next) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .slice(0, 24);

    const password = String(req.body.password || "");

    if (
      !/^[A-Za-z0-9_]{3,24}$/.test(username) ||
      password.length < 8
    ) {
      return res.status(400).json({
        error:
          "Username must be 3-24 letters/numbers/underscore and password must be 8+ characters"
      });
    }

    const ph = await passwordHash(password);
    const c = await pool.connect();

    try {
      await c.query("BEGIN");

      const r = await c.query(
        `INSERT INTO players(username, password_hash)
         VALUES($1, $2)
         RETURNING *`,
        [username, ph]
      );

      for (const b of BUSINESSES) {
        await c.query(
          `INSERT INTO businesses(
            player_id,
            business_id
          )
          VALUES($1, $2)`,
          [r.rows[0].id, b.id]
        );
      }

      await c.query("COMMIT");

      return issueSession(r.rows[0], res);
    } catch (e) {
      await c.query("ROLLBACK");

      if (e.code === "23505") {
        return res.status(409).json({
          error: "Username already exists"
        });
      }

      throw e;
    } finally {
      c.release();
    }
  } catch (e) {
    next(e);
  }
});

/*
  LOGIN
*/
app.post("/api/login", async (req, res, next) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    const r = await pool.query(
      `SELECT *
       FROM players
       WHERE username = $1`,
      [username]
    );

    if (
      !r.rowCount ||
      !(await verifyPassword(
        password,
        r.rows[0].password_hash
      ))
    ) {
      return res.status(401).json({
        error: "Invalid login"
      });
    }

    return issueSession(r.rows[0], res);
  } catch (e) {
    next(e);
  }
});

async function issueSession(p, res) {
  const raw = crypto.randomBytes(32).toString("hex");

  await pool.query(
    `INSERT INTO sessions(
      token_hash,
      player_id,
      expires_at
    )
    VALUES($1, $2, $3)`,
    [
      hash(raw),
      p.id,
      new Date(Date.now() + SESSION_MS)
    ]
  );

  res.json({
    token: raw
  });
}

/*
  PLAYER STATE
*/
app.get("/api/state", auth, async (req, res, next) => {
  try {
    const s = await settle(req.player.id);

    const p = (
      await pool.query(
        `SELECT *
         FROM players
         WHERE id = $1`,
        [req.player.id]
      )
    ).rows[0];

    const biz = (
      await pool.query(
        `SELECT business_id, level, employees, upgrade
         FROM businesses
         WHERE player_id = $1`,
        [p.id]
      )
    ).rows;

    res.json({
      player: publicPlayer(p, s.perSec),
      businesses: biz,
      catalog: BUSINESSES
    });
  } catch (e) {
    next(e);
  }
});

/*
  BUY BUSINESS
*/
app.post("/api/business/buy", auth, async (req, res, next) => {
  try {
    const id = String(req.body.businessId);

    const b = BUSINESSES.find(
      (x) => x.id === id
    );

    if (!b) {
      return res.status(400).json({
        error: "Unknown business"
      });
    }

    const c = await pool.connect();

    try {
      await c.query("BEGIN");

      await settle(req.player.id, c);

      const r = await c.query(
        `SELECT *
         FROM businesses
         WHERE player_id = $1
           AND business_id = $2
         FOR UPDATE`,
        [req.player.id, id]
      );

      const row = r.rows[0];

      const cost =
        b.baseCost *
        Math.pow(1.15, row.level);

      const player = (
        await c.query(
          `SELECT cash
           FROM players
           WHERE id = $1`,
          [req.player.id]
        )
      ).rows[0];

      if (Number(player.cash) < cost) {
        return res.status(400).json({
          error: "Not enough cash"
        });
      }

      await c.query(
        `UPDATE players
         SET cash = cash - $1
         WHERE id = $2`,
        [cost, req.player.id]
      );

      await c.query(
        `UPDATE businesses
         SET level = level + 1
         WHERE player_id = $1
           AND business_id = $2`,
        [req.player.id, id]
      );

      await c.query(
        `INSERT INTO ledger(
          player_id,
          kind,
          amount
        )
        VALUES($1, 'business_purchase', $2)`,
        [req.player.id, -cost]
      );

      await c.query("COMMIT");

      res.json({
        ok: true
      });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  } catch (e) {
    next(e);
  }
});

/*
  UPGRADE BUSINESS
*/
app.post("/api/business/upgrade", auth, async (req, res, next) => {
  try {
    const id = String(req.body.businessId);

    const b = BUSINESSES.find(
      (x) => x.id === id
    );

    if (!b) {
      return res.status(400).json({
        error: "Unknown business"
      });
    }

    const c = await pool.connect();

    try {
      await c.query("BEGIN");

      await settle(req.player.id, c);

      const row = (
        await c.query(
          `SELECT *
           FROM businesses
           WHERE player_id = $1
             AND business_id = $2
           FOR UPDATE`,
          [req.player.id, id]
        )
      ).rows[0];

      if (!row.level) {
        return res.status(400).json({
          error: "Buy the business first"
        });
      }

      const cost =
        b.baseCost *
        2 *
        Math.pow(1.7, row.upgrade);

      const cash = Number(
        (
          await c.query(
            `SELECT cash
             FROM players
             WHERE id = $1`,
            [req.player.id]
          )
        ).rows[0].cash
      );

      if (cash < cost) {
        return res.status(400).json({
          error: "Not enough cash"
        });
      }

      await c.query(
        `UPDATE players
         SET cash = cash - $1
         WHERE id = $2`,
        [cost, req.player.id]
      );

      await c.query(
        `UPDATE businesses
         SET upgrade = upgrade + 1
         WHERE player_id = $1
           AND business_id = $2`,
        [req.player.id, id]
      );

      await c.query(
        `INSERT INTO ledger(
          player_id,
          kind,
          amount
        )
        VALUES($1, 'upgrade', $2)`,
        [req.player.id, -cost]
      );

      await c.query("COMMIT");

      res.json({
        ok: true
      });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  } catch (e) {
    next(e);
  }
});

/*
  HIRE EMPLOYEE
*/
app.post("/api/business/employee", auth, async (req, res, next) => {
  try {
    const id = String(req.body.businessId);

    const b = BUSINESSES.find(
      (x) => x.id === id
    );

    if (!b) {
      return res.status(400).json({
        error: "Unknown business"
      });
    }

    const cost = b.baseCost * 0.75;

    const c = await pool.connect();

    try {
      await c.query("BEGIN");

      await settle(req.player.id, c);

      const row = (
        await c.query(
          `SELECT *
           FROM businesses
           WHERE player_id = $1
             AND business_id = $2
           FOR UPDATE`,
          [req.player.id, id]
        )
      ).rows[0];

      if (!row.level) {
        return res.status(400).json({
          error: "Buy the business first"
        });
      }

      const cash = Number(
        (
          await c.query(
            `SELECT cash
             FROM players
             WHERE id = $1`,
            [req.player.id]
          )
        ).rows[0].cash
      );

      if (cash < cost) {
        return res.status(400).json({
          error: "Not enough cash"
        });
      }

      await c.query(
        `UPDATE players
         SET cash = cash - $1
         WHERE id = $2`,
        [cost, req.player.id]
      );

      await c.query(
        `UPDATE businesses
         SET employees = employees + 1
         WHERE player_id = $1
           AND business_id = $2`,
        [req.player.id, id]
      );

      await c.query(
        `INSERT INTO ledger(
          player_id,
          kind,
          amount
        )
        VALUES($1, 'employee', $2)`,
        [req.player.id, -cost]
      );

      await c.query("COMMIT");

      res.json({
        ok: true
      });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  } catch (e) {
    next(e);
  }
});

/*
  REBIRTH
*/
app.post("/api/rebirth", auth, async (req, res, next) => {
  try {
    const c = await pool.connect();

    try {
      await c.query("BEGIN");

      await settle(req.player.id, c);

      const p = (
        await c.query(
          `SELECT *
           FROM players
           WHERE id = $1
           FOR UPDATE`,
          [req.player.id]
        )
      ).rows[0];

      const need =
        1000000 *
        Math.pow(5, p.rebirths);

      if (Number(p.lifetime_cash) < need) {
        return res.status(400).json({
          error: `Need $${need.toLocaleString()} lifetime cash`
        });
      }

      await c.query(
        `UPDATE players
         SET cash = 500,
             rebirths = rebirths + 1,
             last_settled = now()
         WHERE id = $1`,
        [p.id]
      );

      await c.query(
        `UPDATE businesses
         SET level = 0,
             employees = 0,
             upgrade = 0
         WHERE player_id = $1`,
        [p.id]
      );

      await c.query(
        `INSERT INTO ledger(
          player_id,
          kind,
          amount
        )
        VALUES($1, 'rebirth', 0)`,
        [p.id]
      );

      await c.query("COMMIT");

      res.json({
        ok: true
      });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  } catch (e) {
    next(e);
  }
});

/*
  LEADERBOARD
*/
app.get("/api/leaderboard", async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT username, rebirths, lifetime_cash
       FROM players
       ORDER BY rebirths DESC,
                lifetime_cash DESC
       LIMIT 50`
    );

    res.json(
      r.rows.map((x, i) => ({
        rank: i + 1,
        username: x.username,
        rebirths: x.rebirths,
        lifetimeCash: Number(x.lifetime_cash)
      }))
    );
  } catch (e) {
    next(e);
  }
});

/*
  DAILY REWARD
*/
app.post("/api/reward/daily", auth, async (req, res, next) => {
  try {
    await settle(req.player.id);

    const reward =
      1000 +
      req.player.rebirths * 500;

    await pool.query(
      `UPDATE players
       SET cash = cash + $1,
           lifetime_cash = lifetime_cash + $1
       WHERE id = $2`,
      [reward, req.player.id]
    );

    await pool.query(
      `INSERT INTO ledger(
        player_id,
        kind,
        amount
      )
      VALUES($1, 'daily_reward', $2)`,
      [req.player.id, reward]
    );

    res.json({
      ok: true,
      reward
    });
  } catch (e) {
    next(e);
  }
});

/*
  SHOP
*/
app.post("/api/shop/purchase", auth, async (req, res) => {
  res.status(501).json({
    error:
      "Shop is payment-ready but no real payment processor is connected yet."
  });
});

/*
  ADMIN STATUS
*/
app.post("/api/admin/status", async (req, res) => {
  if (
    !ADMIN_SECRET ||
    req.headers["x-admin-secret"] !== ADMIN_SECRET
  ) {
    return res.status(403).json({
      error: "Forbidden"
    });
  }

  const p = await pool.query(
    `SELECT
       count(*) players,
       coalesce(sum(cash), 0) cash
     FROM players`
  );

  res.json(p.rows[0]);
});

/*
  ERROR HANDLER
*/
app.use((e, req, res, next) => {
  console.error(e);

  res.status(500).json({
    error: "Server error"
  });
});

/*
  START SERVER
*/
init()
  .then(() => {
    app.listen(
      PORT,
      "0.0.0.0",
      () => console.log(
        `Hustle Empire listening on ${PORT}`
      )
    );
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
