# Postgres UI

A focused Tauri 2 desktop client for browsing one PostgreSQL server and editing tables with primary keys. All database operations run in the Rust process and are exposed only through Tauri IPC; the application opens no HTTP or database proxy listener.

## Setup and Run

**Prerequisites:**
- Node.js 20+ and npm
- Rust 1.77.2+ (install via [rustup](https://rustup.rs/))
- Tauri 2 system dependencies: see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- A PostgreSQL server

**Configuration:**

Create a `.env` file (see `.env.example`) or export environment variables:

```sh
export DATABASE_URL='postgresql://postgres:secret@localhost:5432/postgres'
export PGSSLMODE=prefer
```

Alternatively, set individual variables: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` (defaults: `localhost`, `5432`, `postgres`, no password, `postgres`).

Optional: Set `POSTGRESUI_ROWKEY_SECRET` to persist row references across restarts:
```sh
export POSTGRESUI_ROWKEY_SECRET=$(openssl rand -base64 32)
```

**Install and run:**

```sh
npm install
npm run dev
```

**Build for production:**

```sh
npm run build
```

The distributable will be in `src-tauri/target/release/bundle/`.
