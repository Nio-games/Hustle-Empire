# Hustle Empire Online
Multiplayer browser game starter for Railway + PostgreSQL.

## Run
1. `npm install`
2. Set `DATABASE_URL` and a strong `ADMIN_SECRET`.
3. `npm start`
4. Open the printed local URL.

## Railway
Connect the GitHub repository to Railway. Railway detects Node projects automatically. Add `DATABASE_URL` from the PostgreSQL service and `ADMIN_SECRET` as a secret. Generate a public domain.

## Included
- Secure password hashing with Node crypto
- Hashed random sessions
- PostgreSQL persistence
- Server-authoritative cash/income
- Businesses, upgrades, employees, rebirth
- Leaderboard
- Purchase-ready shop endpoints (no real payment processor is claimed)
- Reward-ready daily/ad-reward endpoint
- Admin status endpoint
- Economy ledger
