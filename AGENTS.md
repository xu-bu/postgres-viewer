# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the Vite frontend: `main.ts` manages UI state and Tauri IPC, `connections.ts` handles saved connection profiles, and `styles.css` contains application styles.
- `src-tauri/` contains the Rust backend, Tauri configuration, credential-store integration, and platform assets. Database queries and mutations belong in `src-tauri/src/lib.rs`.
- `tests/` contains Node’s built-in test suites, currently focused on connection persistence behavior.
- `index.html` is the frontend shell; `dist/` is generated build output and should not be edited directly.

## Build, Test, and Development Commands

- `npm install` installs frontend and Tauri CLI dependencies.
- `npm run dev` sources `.env` and starts the Tauri development application on Vite port `1420`.
- `npm test` runs the strict TypeScript check followed by all `tests/*.test.mjs` files.
- `npm run web:check` runs `tsc --noEmit` for frontend type checking.
- `npm run web:build` creates the frontend bundle with Vite.
- `npm run build` builds the production Tauri application and distributables.

## Coding Style & Naming Conventions

Use two-space indentation in TypeScript, HTML, and CSS, and idiomatic Rust formatting. Keep TypeScript strict and avoid unused locals or parameters; validate with `npm run web:check`. Use `camelCase` for TypeScript functions and variables, `PascalCase` for types, `snake_case` for Rust functions and Tauri command payload fields, and kebab-case for DOM IDs (for example, `reload-rows-button`). Prefer small, focused functions and preserve existing accessibility attributes and UI patterns. No repository formatter or linter is configured; use `cargo fmt` for Rust changes.

## Testing Guidelines

Tests use Node’s `node:test` runner and live in `tests/` with names ending in `.test.mjs`. Add focused regression coverage for connection-state or persistence changes, then run `npm test`. Rust unit tests are colocated in `src-tauri/src/lib.rs`; run `cargo test --manifest-path src-tauri/Cargo.toml` when changing backend logic.

## Commit & Pull Request Guidelines

Existing commits use concise, lowercase summaries such as `save passwords` and `support multi connections`. Follow that style, keeping each commit focused. Pull requests should explain behavior changes, list validation commands, link an issue when applicable, and include screenshots or a short recording for visible UI changes. Call out configuration or database-impacting changes explicitly.

## Security & Configuration Tips

Never commit `.env`, passwords, or generated build artifacts. Use `.env.example` for documented configuration. Connection passwords must remain in the OS credential store; do not add password persistence to browser storage or logs. Quote and validate SQL identifiers and values through the existing backend patterns.
