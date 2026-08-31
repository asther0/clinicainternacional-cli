# Clinica Internacional CLI

`clinicai` is a deliberately narrow, agent-facing CLI for Clínica Internacional appointments and availability discovery. It targets Node 20+ and macOS Keychain.

```sh
clinicai auth login
clinicai auth login --remember-document
clinicai auth forget-document
clinicai auth status
clinicai auth logout
clinicai appointments list
clinicai patients list
clinicai specialties list --visit-type CM
clinicai specialties list --visit-type CV
```

Each command writes one JSON object to stdout. A remembered identity (`document` and `documentType`) is opt-in, never includes a password, is never printed or passed as an argument, and is stored in macOS Keychain only after a successful replay. `auth forget-document` deletes that identity; `auth logout` deletes both session and remembered identity and is safe to repeat.

## Current behavior

`auth login` opens headed Chrome at `https://citasenlinea.clinicainternacional.com.pe/authentication/login/login-first-step`. Before navigation, when the remembered identity has a valid `documentType`, an init script writes exactly the three official portal localStorage keys (`rememberMeIsChecked=true`, `selectedDocumentTypeCode=<type>`, `documentNumber=<document>`); when the type is missing or the script cannot be installed, the flow falls back to a direct fill of the `Nro de documento` input so the user can still select the type manually. After an interactive login it waits for the authenticated "Mis citas" control, activates it, and captures only the resulting appointments request; activating the official `Ingresar` control also captures the submitted document when `--remember-document` is set. The replay artifact (`channel`, `idtransaction`, `authorization`, `cookie`) is replayed through a direct Node `fetch`, and only after that replay validates are the session and the opted-in remembered identity written to macOS Keychain, with the authenticated `document` and `documentType` read from the portal's sessionStorage preferred over the activation-captured document. Failed capture or replay saves nothing and returns `AUTH_ARTIFACT_UNSUPPORTED`; there is no browser fallback.

The parser only normalizes the three exact empty response forms observed in the wild to a `bodyResponse` envelope with `appointmentsNumber` and `appointments`; one of those accepted observed inputs is the legacy form with a `list` key instead of `appointments`. Non-empty appointment item schemas still fail closed as `PORTAL_CONTRACT_CHANGED` pending a redacted real non-empty fixture. A `401` or `403` removes the session before returning `AUTH_REQUIRED`. The portal session is observed to last roughly 20 minutes; an exact HTTP-200 expiry response from the portal also clears the saved session and maps to `AUTH_REQUIRED`.

## Patients

`clinicai patients list` requires the opt-in remembered authenticated document and the captured document type. It POSTs the holder profile and GETs the family list through direct HTTP with the captured replay artifact. The parser supports only the observed holder plus empty-family response and fails closed as `PORTAL_CONTRACT_CHANGED` on any non-empty unobserved relative. The public JSON exposes `name`, `ref` (holder flag), `relationship` (set to `self`), and `documentLast3` only; no other fields are forwarded.

## Availability filters

`clinicai specialties list --visit-type CM|CV` lists the specialties and locations available for in-person (`CM`) or virtual (`CV`) care. It uses direct HTTP with the saved replay artifact, emits only normalized codes, names, pediatric/principal flags, and locations, and sorts the output deterministically. The parser accepts only the exact observed portal contract and clears an expired session before returning `AUTH_REQUIRED`.

## Evidence

A live macOS run on 2026-08-30 validated opt-in document capture through the official `Ingresar` activation, Keychain persistence only after successful replay, reuse by `appointments list`, document type persistence, and the patients list returning one holder with only the redacted last-three document output. Live specialty discovery also validated 81 in-person and 22 virtual specialties without printing personal data. The offline suite is 53 tests and remains fake-only: it exercises parsers and replay behavior without touching a live portal or Keychain.

```sh
bun install
bun run typecheck
bun test
bun run build
npm pack --dry-run
node --check dist/cli.js
```
