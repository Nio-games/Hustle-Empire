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
    that are no longer required.
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

  console.log(
    "Database initialization and migration complete"
  );
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

function valid
