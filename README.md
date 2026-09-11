# Postgres UI

A focused Tauri 2 desktop client for browsing PostgreSQL servers and editing tables with primary keys. All database operations run in the Rust process and are exposed only through Tauri IPC; the application opens no HTTP or database proxy listener.

The table toolbar includes **Export CSV**, which downloads the currently loaded page of rows. Any active filter is applied to the exported rows, and PostgreSQL `NULL` values are exported as empty CSV fields.

## Setup and Run

**Prerequisites:**
- Node.js 20+ and npm
- Rust 1.77.2+ (install via [rustup](https://rustup.rs/))
- Tauri 2 system dependencies: see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- A PostgreSQL server

**Configuration:**

On first launch, use **New Connection → Save & Connect** to enter a host, port, username, and password. Successfully connected profiles save the host, port, and username locally; passwords are saved separately in the OS credential store, never in browser local storage. On restart, the Rust backend retrieves the saved passwords and automatically reconnects. Connections that are unavailable remain as disconnected tabs; click the tab or its **Reconnect** button to retry or update credentials. Closing a connection tab removes its saved profile and password.

**Existing profiles:** Passwords from older versions were session-only. Reconnect and enter each password once to save it securely for future launches.

**Credential store:** macOS uses Keychain, Windows uses Credential Manager, and Linux requires an unlocked Secret Service keyring (such as GNOME Keyring or KWallet with Secret Service enabled). If the store is unavailable or locked, the app reports an error rather than saving passwords in plaintext. Linux builds also require the D-Bus development package (`libdbus-1-dev` on Debian/Ubuntu).

Optional: Set `POSTGRESUI_ROWKEY_SECRET` in the process environment to persist row references across restarts:
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
