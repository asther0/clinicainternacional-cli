# Clinica Internacional CLI

`clinicai` is a deliberately narrow, agent-facing tracer for existing appointments. It targets Node 20+ and macOS Keychain.

```sh
clinicai auth login
clinicai auth login --remember-document
clinicai auth forget-document
clinicai auth status
clinicai auth logout
clinicai appointments list
```

Each command writes one JSON object to stdout. A remembered document is opt-in, captured only when the official `Ingresar` control is activated, and prefilled only in its `Nro de documento` input. It is never printed, passed as an argument, or stored with a password. `auth forget-document` deletes only that value; `auth logout` deletes both session and remembered document and is safe to repeat.

## Current behavior

`auth login` opens headed Chrome at `https://citasenlinea.clinicainternacional.com.pe/authentication/login/login-first-step`. After an interactive login it waits for the authenticated "Mis citas" control, activates it, and captures only the resulting appointments request. The replay artifact (`channel`, `idtransaction`, `authorization`, `cookie`) is replayed through a direct Node `fetch`; the session and opted-in remembered document are written to macOS Keychain only after that replay validates. Failed capture or replay saves nothing and returns `AUTH_ARTIFACT_UNSUPPORTED`; there is no browser fallback.

The parser only normalizes the three exact empty response forms observed in the wild to a `bodyResponse` envelope with `appointmentsNumber` and `appointments`; one of those accepted observed inputs is the legacy form with a `list` key instead of `appointments`. Non-empty appointment item schemas still fail closed as `PORTAL_CONTRACT_CHANGED` pending a redacted real non-empty fixture. A `401` or `403` removes the session before returning `AUTH_REQUIRED`.

## Evidence

A live macOS run on 2026-08-30 validated opt-in document capture through the official `Ingresar` activation, Keychain persistence only after successful replay, reuse by `appointments list`, and redacted output containing only `documentLast3`. The offline suite is 27 tests and remains fake-only: it exercises parsers and replay behavior without touching a live portal or Keychain.

```sh
bun install
bun run typecheck
bun test
bun run build
npm pack --dry-run
node --check < dist/cli.js
```
