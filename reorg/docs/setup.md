# reorG Setup Guide

This guide walks you through setting up reorG on your local computer so you can run and develop the application.

---

## Prerequisites

Before you begin, make sure you have these installed:

| Requirement | Version | How to Check |
|-------------|---------|--------------|
| **Node.js** | 20 or higher | Open a terminal and run: `node --version` |
| **PostgreSQL** | 14 or higher | Run: `psql --version` |
| **npm** | Comes with Node.js | Run: `npm --version` |

**Don't have Node.js?** Download the LTS version from [nodejs.org](https://nodejs.org).

**Don't have PostgreSQL?** Options:
- **Windows:** [Download from postgresql.org](https://www.postgresql.org/download/windows/) or use [PostgreSQL Portable](https://get.enterprisedb.com/postgresql/postgresql-16.3-1-windows-x64.exe)
- **Mac:** Install via [Postgres.app](https://postgresapp.com/) or run: `brew install postgresql`
- **Linux:** Run: `sudo apt install postgresql` (Ubuntu) or `sudo dnf install postgresql` (Fedora)

---

## Step 1: Clone or Open the Project

If you received the project as a folder (not from git), simply open that folder in your terminal.

If you're using git:

```bash
git clone <repository-url>
cd reorg
```

---

## Step 2: Install Dependencies

In the project root (`reorg` folder), run:

```bash
npm install
```

This installs all the packages reorG needs. It may take 1–2 minutes.

---

## Step 3: Configure Environment Variables

1. **Copy the example env file:**
   - Find the file `.env.example` in the project root
   - Copy it and rename the copy to `.env`
   - On Windows: `copy .env.example .env`
   - On Mac/Linux: `cp .env.example .env`

2. **Edit `.env`** with a text editor and fill in at least these values:
   - `DATABASE_URL` — Your PostgreSQL connection string (see below)
   - `AUTH_SECRET` — A random secret for authentication (see below)
   - `AUTH_URL` — For local dev, use: `http://localhost:3000`

**Database URL format:**
```
postgresql://USERNAME:PASSWORD@localhost:5432/reorg?schema=public
```
Replace `USERNAME` and `PASSWORD` with your PostgreSQL credentials. The database name `reorg` is fine to use.

**Generate AUTH_SECRET:**
Run this in the project folder:
```bash
npx auth secret
```
Copy the output into `.env` as the value for `AUTH_SECRET`.

See `docs/env-checklist.md` for a complete list of all environment variables.

---

## Step 4: Create the Database

If you haven't created a PostgreSQL database named `reorg` yet:

**Using psql (command line):**
```bash
psql -U postgres
CREATE DATABASE reorg;
\q
```

**Using pgAdmin or another GUI:** Create a new database named `reorg`.

---

## Step 5: Run Database Migrations

This creates all the tables reorG needs:

```bash
npm run db:migrate
```

When prompted for a migration name, you can type something like `init` and press Enter.

---

## Step 6: Seed the Database

This adds starter data: admin users, integrations, shipping rate table, and app settings:

```bash
npm run db:seed
```

**Important:** The seed creates two admin accounts:
- adam@theperfectpart.net
- coryzz@live.com  

Both start with the temporary password: `changeme-on-first-login`  
**Change these passwords immediately** after your first login.

---

## Step 7: Start the Development Server

```bash
npm run dev
```

You should see something like:

```
▲ Next.js 16.x.x
- Local: http://localhost:3000
```

Open [http://localhost:3000](http://localhost:3000) in your browser. You should see the reorG login page.

---

## Troubleshooting

### "Port 3000 is already in use"
Another app is using port 3000. Either close that app or start Next.js on a different port:
```bash
npm run dev -- -p 3001
```
Then open http://localhost:3001

### "Can't connect to database" / "Connection refused"
- Make sure PostgreSQL is running (check Services on Windows, or `brew services list` on Mac)
- Verify `DATABASE_URL` in `.env` — username, password, and host (usually `localhost`) must be correct
- Confirm the `reorg` database exists

### "Prisma Client not generated"
Run:
```bash
npm run db:generate
```

### "Migration failed" / Schema errors
If you get errors during migration:
1. Make sure you're on the latest code
2. Try: `npm run db:push` (warning: use only for local dev; this can reset schema)
3. If the database is empty or disposable, you can drop and recreate it, then run migrations again

### npm install fails
- Make sure you have Node.js 20+ (`node --version`)
- Delete the `node_modules` folder and `package-lock.json`, then run `npm install` again
- On Windows, try running the terminal as Administrator if you get permission errors

### Blank page or errors after login
- Check the browser console (F12 → Console tab) for errors
- Make sure you ran `db:seed` so admin users exist
- Verify `AUTH_URL` in `.env` matches the URL you're using (e.g., `http://localhost:3000`)

---

## Next Steps

- Log in with an admin account and change the default password
- Configure integrations (eBay, BigCommerce, Shopify) — see `docs/api-tokens.md`
- Populate shipping rates — see `docs/shipping-rates.md`
- Run your first sync — see the Sync page in the app
