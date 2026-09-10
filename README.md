# Postgres UI

A focused Tauri 2 desktop client for browsing PostgreSQL servers and editing tables with primary keys. All database operations run in the Rust process and are exposed only through Tauri IPC; the application opens no HTTP or database proxy listener.

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

On first launch, the app connects using this environment configuration. Use **New Connection → Save & Connect** to enter a host, port, username, and password. Successfully connected profiles save the host, port, and username locally; passwords are kept only in memory for the session, never in local storage. On restart, the app attempts to restore saved connections. Connections that need a password or are unavailable remain as disconnected tabs. Click a disconnected tab or its **Reconnect** button to retry; the connection details are prefilled so you can re-enter the password. Closing a connection tab removes its saved profile. Additional connections inherit the environment's initial database and connection options, but use the credentials you enter. Older profiles without a username continue to use environment credentials.

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
