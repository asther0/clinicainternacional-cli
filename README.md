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

Each command writes one JSON object to stdout. A remembered document is opt-in, captured only when the official login form is submitted, and prefilled only in its `Nro de documento` input. It is never printed, passed as an argument, or stored with a password. `auth forget-document` deletes only that value; `auth logout` deletes both session and remembered document and is safe to repeat.

## Current evidence boundary

Login opens headed Chrome at `https://citasenlinea.clinicainternacional.com.pe/authentication/login/login-first-step`. After an interactive login, it accepts only the exact appointments `GET` replay artifact (`channel`, `idtransaction`, `authorization`, `cookie`) and proves the direct Node `fetch` replay while Chrome remains open. Failed capture or replay saves nothing and returns `AUTH_ARTIFACT_UNSUPPORTED`; there is no browser fallback.

The only supported response fixture is the observed empty `bodyResponse` envelope with `appointmentsNumber` and `list`. Non-empty item schemas are intentionally rejected as `PORTAL_CONTRACT_CHANGED` until a redacted real fixture supports an extension. A `401` or `403` removes the session before returning `AUTH_REQUIRED`.

The test suite is fake-only; it does not validate a live portal or Keychain.

```sh
bun install
bun run typecheck
bun test
bun run build
npm pack --dry-run
node --check < dist/cli.js
```
