import express from "express";
import pg from "pg";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const app = express();

const ROOT = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(ROOT, "public")));

const PORT = Number(process.env.PORT || 3000);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway")
    ? { rejectUnauthorized: false }
    : undefined
});

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

const SESSION_MS =
  Number(process.env.SESSION_DAYS || 30) * 86400000;

const DAILY_COOLDOWN_MS = 86400000;

const BUSINESSES = [
  {
    id: "street-hustle",
    name: "Street Hustle",
    baseCost: 100,
    income: 4
  },
  {
    id: "food-cart",
    name: "Food Cart",
    baseCost: 750,
    income: 24
  },
  {
    id: "car-wash",
    name: "Car Wash",
    baseCost: 5000,
    income: 180
  },
  {
    id: "nightclub",
    name: "Nightclub",
    baseCost: 50000,
    income: 2200
  },
  {
    id: "shipping",
    name: "Shipping Empire",
    baseCost: 500000,
    income: 26000
  },
  {
    id: "tech-firm",
    name: "Tech Firm",
    baseCost: 5000000,
    income: 310000
  }
];

const DAILY_BASE_REWARD = 1000;
const DAILY_REBIRTH_BONUS = 500;

/*
  DATABASE INITIALIZATION
*/
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players(
      id BIGSERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL DEFAULT '',
      cash NUMERIC(30,2) NOT NULL DEFAULT 500,
      lifetime_cash NUMERIC(30,2) NOT NULL DEFAULT 500,
      rebirths INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_settled TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_daily TIMESTAMPTZ,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE
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

  /*
    Upgrade legacy players table.
  */
  const columns = [
    ["password_hash", "TEXT DEFAULT ''"],
    ["cash", "NUMERIC(30,2) NOT NULL DEFAULT 500"],
    ["lifetime_cash", "NUMERIC(30,2) NOT NULL DEFAULT 500"],
    ["rebirths", "INT NOT NULL DEFAULT 0"],
    ["last_settled", "TIMESTAMPTZ NOT NULL DEFAULT now()"],
    ["last_daily", "TIMESTAMPTZ"],
    ["is_admin", "BOOLEAN NOT NULL DEFAULT FALSE"]
  ];

  for (const [name, definition] of columns) {
    const check = await pool.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'players'
            AND column_name = $1
        ) AS exists
      `,
      [name]
    );

    if (!check.rows[0].exists) {
      console.log(`Adding missing column: ${name}`);

      await pool.query(
        `ALTER TABLE players ADD COLUMN ${name} ${definition}`
      );
    }
  }

  /*
    Legacy databases may contain email/password columns
    that are no longer required by Hustle Empire.
  */
  const emailCheck = await pool.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'players'
          AND column_name = 'email'
      ) AS exists
    `
  );

  if (emailCheck.rows[0].exists) {
    await pool.query(
      `ALTER TABLE players ALTER COLUMN email DROP NOT NULL`
    );
  }

  const passwordCheck = await pool.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'players'
          AND column_name = 'password'
      ) AS exists
    `
  );

  if (passwordCheck.rows[0].exists) {
    await pool.query(
      `ALTER TABLE players ALTER COLUMN password DROP NOT NULL`
    );
  }

  console.log("Database initialization and migration complete");
}

/*
  HELPERS
*/
function hash(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function passwordHash(
  password,
  salt = crypto.randomBytes(16).toString("hex")
) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => {
      if (error) {
        return reject(error);
      }

      resolve(
        `${salt}:${key.toString("hex")}`
      );
    });
  });
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) {
    return Promise.resolve(false);
  }

  const [salt, hex] = stored.split(":");

  if (!salt || !hex) {
    return Promise.resolve(false);
  }

  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => {
      if (error) {
        return reject(error);
      }

      const a = Buffer.from(hex, "hex");
      const b = key;

      resolve(
        a.length === b.length &&
        crypto.timingSafeEqual(a, b)
      );
    });
  });
}

/*
  AUTHENTICATION
*/
function auth(req, res, next) {
  const raw = (
    req.headers.authorization || ""
  ).replace(/^Bearer\s+/i, "");

  if (!raw) {
    return res.status(401).json({
      error: "Login required"
    });
  }

  pool
    .query(
      `
        SELECT p.*
        FROM sessions s
        JOIN players p
          ON p.id = s.player_id
        WHERE s.token_hash = $1
          AND s.expires_at > now()
      `,
      [hash(raw)]
    )
    .then((result) => {
      if (!result.rowCount) {
        return res.status(401).json({
          error: "Session expired"
        });
      }

      req.player = result.rows[0];
      next();
    })
    .catch(next);
}

/*
  ADMIN AUTHENTICATION
*/
function adminAuth(req, res, next) {
  const raw = (
    req.headers.authorization || ""
  ).replace(/^Bearer\s+/i, "");

  if (!raw) {
    return res.status(401).json({
      error: "Admin login required"
    });
  }

  pool
    .query(
      `
        SELECT p.*
        FROM sessions s
        JOIN players p
          ON p.id = s.player_id
        WHERE s.token_hash = $1
          AND s.expires_at > now()
          AND p.is_admin = TRUE
      `,
      [hash(raw)]
    )
    .then((result) => {
      if (!result.rowCount) {
        return res.status(403).json({
          error: "Admin access required"
        });
      }

      req.player = result.rows[0];
      next();
    })
    .catch(next);
}

/*
  SETTLE PASSIVE BUSINESS INCOME
*/
async function settle(playerId, client = pool) {
  const playerResult = await client.query(
    `
      SELECT *
      FROM players
      WHERE id = $1
      FOR UPDATE
    `,
    [playerId]
  );

  if (!playerResult.rowCount) {
    throw new Error("Player missing");
  }

  const player = playerResult.rows[0];

  const businessResult = await client.query(
    `
      SELECT *
      FROM businesses
      WHERE player_id = $1
    `,
    [playerId]
  );

  let perSec = 0;

  for (const row of businessResult.rows) {
    const business = BUSINESSES.find(
      (item) => item.id === row.business_id
    );

    if (!business) {
      continue;
    }

    perSec +=
      business.income *
      row.level *
      (1 + row.upgrade * 0.15) *
      (1 + row.employees * 0.05);
  }

  const elapsed = Math.max(
    0,
    (
      Date.now() -
      new Date(player.last_settled).getTime()
    ) / 1000
  );

  const earned = Math.min(
    elapsed * perSec,
    1e12
  );

  if (earned > 0) {
    await client.query(
      `
        UPDATE players
        SET cash = cash + $1,
            lifetime_cash = lifetime_cash + $1,
            last_settled = now()
        WHERE id = $2
      `,
      [earned, playerId]
    );
  } else {
    await client.query(
      `
        UPDATE players
        SET last_settled = now()
        WHERE id = $1
      `,
      [playerId]
    );
  }

  return {
    earned,
    perSec
  };
}

function publicPlayer(player, perSec = 0) {
  return {
    id: player.id,
    username: player.username,
    cash: Number(player.cash),
    lifetimeCash: Number(player.lifetime_cash),
    rebirths: player.rebirths,
    perSec
  };
}

/*
  HEALTH
*/
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      game: "Hustle Empire"
    });
  } catch (error) {
    console.error(error);

    res.status(503).json({
      ok: false
    });
  }
});

/*
  REGISTER NORMAL PLAYER
*/
app.post("/api/register", async (req, res, next) => {
  try {
    const username = String(
      req.body.username || ""
    )
      .trim()
      .slice(0, 24);

    const password = String(
      req.body.password || ""
    );

    if (
      !/^[A-Za-z0-9_]{3,24}$/.test(username) ||
      password.length < 8
    ) {
      return res.status(400).json({
        error:
          "Username must be 3-24 letters/numbers/underscore and password must be 8+ characters"
      });
    }

    const passwordHashValue =
      await passwordHash(password);

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `
          INSERT INTO players(
            username,
            password_hash,
            is_admin
          )
          VALUES($1, $2, FALSE)
          RETURNING *
        `,
        [
          username,
          passwordHashValue
        ]
      );

      const player = result.rows[0];

      for (const business of BUSINESSES) {
        await client.query(
          `
            INSERT INTO businesses(
              player_id,
              business_id
            )
            VALUES($1, $2)
            ON CONFLICT DO NOTHING
          `,
          [
            player.id,
            business.id
          ]
        );
      }

      await client.query("COMMIT");

      return issueSession(player, res);
    } catch (error) {
      await client.query("ROLLBACK");

      if (error.code === "23505") {
        return res.status(409).json({
          error: "Username already exists"
        });
      }

      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

/*
  LOGIN
*/
app.post("/api/login", async (req, res, next) => {
  try {
    const username = String(
      req.body.username || ""
    ).trim();

    const password = String(
      req.body.password || ""
    );

    const result = await pool.query(
      `
        SELECT *
        FROM players
        WHERE username = $1
      `,
      [username]
    );

    if (!result.rowCount) {
      return res.status(401).json({
        error: "Invalid login"
      });
    }

    const player = result.rows[0];

    const valid = await verifyPassword(
      password,
      player.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        error: "Invalid login"
      });
    }

    return issueSession(player, res);
  } catch (error) {
    next(error);
  }
});

/*
  SESSION
*/
async function issueSession(player, res) {
  const raw = crypto
    .randomBytes(32)
    .toString("hex");

  await pool.query(
    `
      INSERT INTO sessions(
        token_hash,
        player_id,
        expires_at
      )
      VALUES($1, $2, $3)
    `,
    [
      hash(raw),
      player.id,
      new Date(
        Date.now() + SESSION_MS
      )
    ]
  );

  res.json({
    token: raw
  });
}

/*
  PLAYER STATE
*/
app.get(
  "/api/state",
  auth,
  async (req, res, next) => {
    try {
      const settled = await settle(
        req.player.id
      );

      const playerResult = await pool.query(
        `
          SELECT *
          FROM players
          WHERE id = $1
        `,
        [req.player.id]
      );

      const player = playerResult.rows[0];

      const businessResult = await pool.query(
        `
          SELECT
            business_id,
            level,
            employees,
            upgrade
          FROM businesses
          WHERE player_id = $1
        `,
        [player.id]
      );

      res.json({
        player: publicPlayer(
          player,
          settled.perSec
        ),
        businesses: businessResult.rows,
        catalog: BUSINESSES
      });
    } catch (error) {
      next(error);
    }
  }
);

/*
  BUY BUSINESS
*/
app.post(
  "/api/business/buy",
  auth,
  async (req, res, next) => {
    try {
      const id = String(
        req.body.businessId || ""
      );

      const business = BUSINESSES.find(
        (item) => item.id === id
      );

      if (!business) {
        return res.status(400).json({
          error: "Unknown business"
        });
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        await settle(
          req.player.id,
          client
        );

        const businessResult =
          await client.query(
            `
              SELECT *
              FROM businesses
              WHERE player_id = $1
                AND business_id = $2
              FOR UPDATE
            `,
            [
              req.player.id,
              id
            ]
          );

        const row =
          businessResult.rows[0];

        if (!row) {
          throw new Error(
            "Business record missing"
          );
        }

        const cost =
          business.baseCost *
          Math.pow(1.15, row.level);

        const playerResult =
          await client.query(
            `
              SELECT cash
              FROM players
              WHERE id = $1
              FOR UPDATE
            `,
            [req.player.id]
          );

        const cash =
          Number(
            playerResult.rows[0].cash
          );

        if (cash < cost) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            error: "Not enough cash"
          });
        }

        await client.query(
          `
            UPDATE players
            SET cash = cash - $1
            WHERE id = $2
          `,
          [
            cost,
            req.player.id
          ]
        );

        await client.query(
          `
            UPDATE businesses
            SET level = level + 1
            WHERE player_id = $1
              AND business_id = $2
          `,
          [
            req.player.id,
            id
          ]
        );

        await client.query(
          `
            INSERT INTO ledger(
              player_id,
              kind,
              amount
            )
            VALUES(
              $1,
              'business_purchase',
              $2
            )
          `,
          [
            req.player.id,
            -cost
          ]
        );

        await client.query("COMMIT");

        res.json({
          ok: true
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }
);

/*
  UPGRADE BUSINESS
*/
app.post(
  "/api/business/upgrade",
  auth,
  async (req, res, next) => {
    try {
      const id = String(
        req.body.businessId || ""
      );

      const business = BUSINESSES.find(
        (item) => item.id === id
      );

      if (!business) {
        return res.status(400).json({
          error: "Unknown business"
        });
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        await settle(
          req.player.id,
          client
        );

        const businessResult =
          await client.query(
            `
              SELECT *
              FROM businesses
              WHERE player_id = $1
                AND business_id = $2
              FOR UPDATE
            `,
            [
              req.player.id,
              id
            ]
          );

        const row =
          businessResult.rows[0];

        if (!row) {
          throw new Error(
            "Business record missing"
          );
        }

        if (!row.level) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            error:
              "Buy the business first"
          });
        }

        const cost =
          business.baseCost *
          2 *
          Math.pow(
            1.7,
            row.upgrade
          );

        const playerResult =
          await client.query(
            `
              SELECT cash
              FROM players
              WHERE id = $1
              FOR UPDATE
            `,
            [req.player.id]
          );

        const cash =
          Number(
            playerResult.rows[0].cash
          );

        if (cash < cost) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            error: "Not enough cash"
          });
        }

        await client.query(
          `
            UPDATE players
            SET cash = cash - $1
            WHERE id = $2
          `,
          [
            cost,
            req.player.id
          ]
        );

        await client.query(
          `
            UPDATE businesses
            SET upgrade = upgrade + 1
            WHERE player_id = $1
              AND business_id = $2
          `,
          [
            req.player.id,
            id
          ]
        );

        await client.query(
          `
            INSERT INTO ledger(
              player_id,
              kind,
              amount
            )
            VALUES(
              $1,
              'upgrade',
              $2
            )
          `,
          [
            req.player.id,
            -cost
          ]
        );

        await client.query("COMMIT");

        res.json({
          ok: true
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }
);

/*
  HIRE EMPLOYEE
*/
app.post(
  "/api/business/employee",
  auth,
  async (req, res, next) => {
    try {
      const id = String(
        req.body.businessId || ""
      );

      const business = BUSINESSES.find(
        (item) => item.id === id
      );

      if (!business) {
        return res.status(400).json({
          error: "Unknown business"
        });
      }

      const cost =
        business.baseCost * 0.75;

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        await settle(
          req.player.id,
          client
        );

        const businessResult =
          await client.query(
            `
              SELECT *
              FROM businesses
              WHERE player_id = $1
                AND business_id = $2
              FOR UPDATE
            `,
            [
              req.player.id,
              id
            ]
          );

        const row =
          businessResult.rows[0];

        if (!row) {
          throw new Error(
            "Business record missing"
          );
        }

        if (!row.level) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            error:
              "Buy the business first"
          });
        }

        const playerResult =
          await client.query(
            `
              SELECT cash
              FROM players
              WHERE id = $1
              FOR UPDATE
            `,
            [req.player.id]
          );

        const cash =
          Number(
            playerResult.rows[0].cash
          );

        if (cash < cost) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            error: "Not enough cash"
          });
        }

        await client.query(
          `
            UPDATE players
            SET cash = cash - $1
            WHERE id = $2
          `,
          [
            cost,
            req.player.id
          ]
        );

        await client.query(
          `
            UPDATE businesses
            SET employees = employees + 1
            WHERE player_id = $1
              AND business_id = $2
          `,
          [
            req.player.id,
            id
          ]
        );

        await client.query(
          `
            INSERT INTO ledger(
              player_id,
              kind,
              amount
            )
            VALUES(
              $1,
              'employee',
              $2
            )
          `,
          [
            req.player.id,
            -cost
          ]
        );

        await client.query("COMMIT");

        res.json({
          ok: true
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }
);

/*
  REBIRTH
*/
app.post(
  "/api/rebirth",
  auth,
  async (req, res, next) => {
    try {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        await settle(
          req.player.id,
          client
        );

        const playerResult =
          await client.query(
            `
              SELECT *
              FROM players
              WHERE id = $1
              FOR UPDATE
            `,
            [req.player.id]
          );

        const player =
          playerResult.rows[0];

        const required =
          1000000 *
          Math.pow(
            5,
            player.rebirths
          );

        if (
          Number(player.lifetime_cash) <
          required
        ) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            error:
              `Need $${required.toLocaleString()} lifetime cash`
          });
        }

        await client.query(
          `
            UPDATE players
            SET cash = 500,
                rebirths = rebirths + 1,
                last_settled = now()
            WHERE id = $1
          `,
          [player.id]
        );

        await client.query(
          `
            UPDATE businesses
            SET level = 0,
                employees = 0,
                upgrade = 0
            WHERE player_id = $1
          `,
          [player.id]
        );

        await client.query(
          `
            INSERT INTO ledger(
              player_id,
              kind,
              amount
            )
            VALUES(
              $1,
              'rebirth',
              0
            )
          `,
          [player.id]
        );

        await client.query("COMMIT");

        res.json({
          ok: true
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }
);

/*
  LEADERBOARD
  ------------
  Admin accounts are intentionally excluded.
*/
app.get(
  "/api/leaderboard",
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `
          SELECT
            username,
            rebirths,
            lifetime_cash
          FROM players
          WHERE is_admin = FALSE
          ORDER BY
            rebirths DESC,
            lifetime_cash DESC
          LIMIT 50
        `
      );

      res.json(
        result.rows.map(
          (player, index) => ({
            rank: index + 1,
            username: player.username,
            rebirths: player.rebirths,
            lifetimeCash:
              Number(
                player.lifetime_cash
              )
          })
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

/*
  DAILY REWARD
  ------------
  Server-side 24-hour protection.
*/
app.post(
  "/api/reward/daily",
  auth,
  async (req, res, next) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await settle(
        req.player.id,
        client
      );

      const playerResult =
        await client.query(
          `
            SELECT
              id,
              rebirths,
              last_daily
            FROM players
            WHERE id = $1
            FOR UPDATE
          `,
          [req.player.id]
        );

      if (!playerResult.rowCount) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: "Player missing"
        });
      }

      const player =
        playerResult.rows[0];

      const reward =
        DAILY_BASE_REWARD +
        Number(player.rebirths) *
          DAILY_REBIRTH_BONUS;

      let nextClaimAt = null;

      if (player.last_daily) {
        const lastClaim =
          new Date(
            player.last_daily
          ).getTime();

        const nextClaimTime =
          lastClaim +
          DAILY_COOLDOWN_MS;

        if (
          Date.now() <
          nextClaimTime
        ) {
          nextClaimAt =
            new Date(
              nextClaimTime
            ).toISOString();

          await client.query("ROLLBACK");

          return res.status(429).json({
            error:
              "Daily reward already claimed",
            nextClaimAt
          });
        }
      }

      const updateResult =
        await client.query(
          `
            UPDATE players
            SET cash = cash + $1,
                lifetime_cash = lifetime_cash + $1,
                last_daily = now()
            WHERE id = $2
            RETURNING last_daily
          `,
          [
            reward,
            req.player.id
          ]
        );

      if (!updateResult.rowCount) {
        throw new Error(
          "Daily reward update failed"
        );
      }

      await client.query(
        `
          INSERT INTO ledger(
            player_id,
            kind,
            amount
          )
          VALUES(
            $1,
            'daily_reward',
            $2
          )
        `,
        [
          req.player.id,
          reward
        ]
      );

      await client.query("COMMIT");

      nextClaimAt =
        new Date(
          Date.now() +
          DAILY_COOLDOWN_MS
        ).toISOString();

      res.json({
        ok: true,
        reward,
        nextClaimAt
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback errors.
      }

      next(error);
    } finally {
      client.release();
    }
  }
);

/*
  SHOP
*/
app.post(
  "/api/shop/purchase",
  auth,
  async (req, res) => {
    res.status(501).json({
      error:
        "Shop is payment-ready but no real payment processor is connected yet."
    });
  }
);

/*
  ADMIN CREATE
  ------------
  Creates an admin account.

  This endpoint is protected by ADMIN_SECRET.
  The secret is never stored in the database.

  Request:
    POST /api/admin/create

  Header:
    x-admin-secret: YOUR_ADMIN_SECRET

  Body:
    {
      "username": "adminname",
      "password": "strongpassword"
    }
*/
app.post(
  "/api/admin/create",
  async (req, res, next) => {
    try {
      if (
        !ADMIN_SECRET ||
        req.headers["x-admin-secret"] !==
          ADMIN_SECRET
      ) {
        return res.status(403).json({
          error: "Forbidden"
        });
      }

      const username = String(
        req.body.username || ""
      )
        .trim()
        .slice(0, 24);

      const password = String(
        req.body.password || ""
      );

      if (
        !/^[A-Za-z0-9_]{3,24}$/.test(username) ||
        password.length < 8
      ) {
        return res.status(400).json({
          error:
            "Username must be 3-24 letters/numbers/underscore and password must be 8+ characters"
        });
      }

      const passwordHashValue =
        await passwordHash(password);

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const result = await client.query(
          `
            INSERT INTO players(
              username,
              password_hash,
              is_admin
            )
            VALUES($1, $2, TRUE)
            RETURNING *
          `,
          [
            username,
            passwordHashValue
          ]
        );

        const player = result.rows[0];

        /*
          Give the admin the same business records
          as a normal player so the account can still
          enter and inspect the game.
        */
        for (const business of BUSINESSES) {
          await client.query(
            `
              INSERT INTO businesses(
                player_id,
                business_id
              )
              VALUES($1, $2)
              ON CONFLICT DO NOTHING
            `,
            [
              player.id,
              business.id
            ]
          );
        }

        await client.query("COMMIT");

        return issueSession(
          player,
          res
        );
      } catch (error) {
        await client.query("ROLLBACK");

        if (error.code === "23505") {
          return res.status(409).json({
            error:
              "Username already exists"
          });
        }

        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }
);

/*
  ADMIN STATUS
*/
app.post(
  "/api/admin/status",
  async (req, res, next) => {
    try {
      if (
        !ADMIN_SECRET ||
        req.headers["x-admin-secret"] !==
          ADMIN_SECRET
      ) {
        return res.status(403).json({
          error: "Forbidden"
        });
      }

      const result =
        await pool.query(
          `
            SELECT
              count(*) players,
              coalesce(
                sum(cash),
                0
              ) cash,
              count(*) FILTER (
                WHERE is_admin = TRUE
              ) admins
            FROM players
          `
        );

      res.json(
        result.rows[0]
      );
    } catch (error) {
      next(error);
    }
  }
);

/*
  ADMIN STATE
  -----------
  Optional protected endpoint for admin tools.
*/
app.get(
  "/api/admin/state",
  adminAuth,
  async (req, res, next) => {
    try {
      const result =
        await pool.query(
          `
            SELECT
              id,
              username,
              cash,
              lifetime_cash,
              rebirths,
              created_at,
              last_daily,
              is_admin
            FROM players
            WHERE id = $1
          `,
          [req.player.id]
        );

      if (!result.rowCount) {
        return res.status(404).json({
          error: "Admin missing"
        });
      }

      const player = result.rows[0];

      res.json({
        id: player.id,
        username: player.username,
        cash: Number(player.cash),
        lifetimeCash:
          Number(player.lifetime_cash),
        rebirths: player.rebirths,
        createdAt: player.created_at,
        lastDaily: player.last_daily,
        isAdmin: player.is_admin
      });
    } catch (error) {
      next(error);
    }
  }
);

/*
  ERROR HANDLER
*/
app.use(
  (error, req, res, next) => {
    console.error(error);

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      error: "Server error"
    });
  }
);

/*
  START SERVER
*/
init()
  .then(() => {
    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `Hustle Empire listening on ${PORT}`
        );
      }
    );
  })
  .catch((error) => {
    console.error(
      "Failed to start Hustle Empire:",
      error
    );

    process.exit(1);
  });
