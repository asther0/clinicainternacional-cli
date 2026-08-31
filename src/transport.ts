import { chromium, type BrowserContext, type Page, type Request } from "playwright";
import { CliError } from "./errors.js";
import { parseAppointmentsEnvelope } from "./parser.js";
import type { CapturedRequest, RememberedIdentity, Session } from "./vault.js";

export interface PortalTransport { listAppointments(session: Session): Promise<unknown>; }
export type LoginCapture = { session: Session; rememberedIdentity: RememberedIdentity | null };
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const frontendOrigin = "https://citasenlinea.clinicainternacional.com.pe";
export const backendOrigin = "https://prdexp.clinicainternacional.com.pe";
export const loginPath = "/authentication/login/login-first-step";
export const appointmentPath = "/v2/appointments/appointmentslist";
/** Exact accessible name of the visible official login control. */
export const officialLoginButtonName = "Ingresar";
const loginUrl = `${frontendOrigin}${loginPath}`;
const replayHeaderNames = new Set(["authorization", "cookie", "channel", "idtransaction"]);
const maxRememberedDocumentLength = 64;
const appointmentsCaptureTimeout = 120_000;
const documentCaptureTimeout = 1_000;
export const loginDocumentSelector = 'input[placeholder="Nro de documento"]';

/** Accepts only the explicitly opted-in document captured at official login activation. */
export function rememberedIdentityFromSubmittedDocument(rememberDocument: boolean, value: unknown): RememberedIdentity | null {
  if (!rememberDocument || typeof value !== "string") return null;
  const document = value.trim();
  if (!document || document.length > maxRememberedDocumentLength) return null;
  return { document };
}

function validatedUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin !== backendOrigin || url.pathname !== appointmentPath || url.search || url.hash) throw new CliError("PORTAL_CONTRACT_CHANGED");
  return url;
}

export function captureReplayRequest(urlValue: string, headers: Record<string, string>, cookies: { name: string; value: string }[]): CapturedRequest {
  const url = validatedUrl(urlValue);
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (replayHeaderNames.has(normalized) && value.trim()) safe[normalized] = value;
  }
  if (!safe.cookie && cookies.length) safe.cookie = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  if (!safe.channel || !safe.idtransaction || (!safe.authorization && !safe.cookie)) throw new CliError("AUTH_ARTIFACT_UNSUPPORTED");
  return { url: url.toString(), headers: safe };
}

async function captureRequest(request: Request, context: BrowserContext): Promise<CapturedRequest> {
  const headers = await request.allHeaders();
  const cookies = await context.cookies(request.url());
  return captureReplayRequest(request.url(), headers, cookies);
}

async function prefillDocument(page: Page, identity: RememberedIdentity | null): Promise<void> {
  if (!identity) return;
  const input = page.locator(loginDocumentSelector).first();
  if (await input.count()) await input.fill(identity.document);
}

export async function captureDocumentOnOfficialLoginActivation(
  page: Page,
  rememberDocument: boolean,
  timeout = documentCaptureTimeout,
): Promise<() => Promise<RememberedIdentity | null>> {
  if (!rememberDocument) return async () => null;

  let captured = false;
  let resolveCaptured!: (identity: RememberedIdentity) => void;
  const capturedIdentity = new Promise<RememberedIdentity>((resolve) => { resolveCaptured = resolve; });
  await page.exposeBinding("__clinicaiCaptureSubmittedDocument", (_source, value: unknown) => {
    if (captured) return false;
    const identity = rememberedIdentityFromSubmittedDocument(rememberDocument, value);
    if (!identity) return false;
    captured = true;
    resolveCaptured(identity);
    return true;
  });
  const button = page.getByRole("button", { name: officialLoginButtonName, exact: true });
  await button.waitFor({ state: "visible" });
  await button.evaluate((element, selector) => {
    const document = element.ownerDocument;
    type CaptureBinding = (value: string) => Promise<boolean>;
    const capture = async () => {
      const input = document.querySelector(selector);
      if (!(input instanceof HTMLInputElement)) return;
      const accepted = await (window as typeof window & { __clinicaiCaptureSubmittedDocument: CaptureBinding })
        .__clinicaiCaptureSubmittedDocument(input.value);
      if (!accepted) return;
      element.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeydown, true);
    };
    const onClick = () => { void capture(); };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Enter") void capture();
    };
    element.addEventListener("click", onClick, { capture: true });
    document.addEventListener("keydown", onKeydown, { capture: true });
  }, loginDocumentSelector);
  return async () => {
    if (captured) return capturedIdentity;
    return Promise.race([
      capturedIdentity,
      new Promise<null>((resolve) => { setTimeout(resolve, timeout, null); }),
    ]);
  };
}

type ActivatedCapture<T> = {
  waitForAuthenticatedControl: () => Promise<void>;
  armResponse: (timeout: number) => Promise<T>;
  activateControl: () => Promise<void>;
  validate: (response: T) => Promise<void>;
  timeout?: number;
};

/**
 * Ignore pre-authentication traffic, arm the response listener before activation,
 * and keep waiting after a contract mismatch for another eligible response.
 */
export async function captureAfterAuthenticatedActivation<T>({
  waitForAuthenticatedControl,
  armResponse,
  activateControl,
  validate,
  timeout = appointmentsCaptureTimeout,
}: ActivatedCapture<T>): Promise<T> {
  await waitForAuthenticatedControl();
  const deadline = Date.now() + timeout;
  const remaining = () => Math.max(1, deadline - Date.now());
  let candidate = armResponse(remaining());
  await activateControl();
  let observedMismatch = false;

  for (;;) {
    try {
      const response = await candidate;
      try {
        await validate(response);
        return response;
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== "PORTAL_CONTRACT_CHANGED") throw error;
        observedMismatch = true;
      }
      if (Date.now() >= deadline) throw new CliError("PORTAL_CONTRACT_CHANGED");
      candidate = armResponse(remaining());
    } catch (error) {
      if (observedMismatch) throw new CliError("PORTAL_CONTRACT_CHANGED");
      throw error;
    }
  }
}

async function validateObservedAppointmentsResponse(response: import("playwright").Response): Promise<void> {
  let observed: unknown;
  try {
    observed = await response.json();
  } catch {
    throw new CliError("PORTAL_CONTRACT_CHANGED");
  }
  try {
    parseAppointmentsEnvelope(observed);
  } catch {
    throw new CliError("PORTAL_CONTRACT_CHANGED");
  }
}

const expiredAuditKeys = ["date", "idTransaction", "methodName", "responseCode", "responseMessage", "serviceName"] as const;
const expiredResponseCode = "-1";
const expiredResponseMessage = "Sesion expirada o no encontrada";

/**
 * Exact audit envelope the portal uses to signal an expired/missing session
 * inside an HTTP 200 body. Any drift (wrong code, different message, missing
 * or extra audit key, non-null bodyResponse) is a near miss and stays
 * PORTAL_CONTRACT_CHANGED via parseAppointmentsEnvelope.
 */
function isExactSessionExpiredPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  const topKeys = Object.keys(record);
  if (topKeys.length !== 2) return false;
  if (!topKeys.includes("auditResponse") || !topKeys.includes("bodyResponse")) return false;
  const audit = record.auditResponse;
  if (typeof audit !== "object" || audit === null || Array.isArray(audit)) return false;
  const auditRecord = audit as Record<string, unknown>;
  const keys = Object.keys(auditRecord);
  if (keys.length !== expiredAuditKeys.length) return false;
  for (const expected of expiredAuditKeys) {
    if (!keys.includes(expected) || typeof auditRecord[expected] !== "string") return false;
  }
  if (auditRecord.responseCode !== expiredResponseCode) return false;
  if (auditRecord.responseMessage !== expiredResponseMessage) return false;
  if (record.bodyResponse !== null) return false;
  return true;
}

/** Exact, minimal direct replay. It never invokes browser automation as a fallback. */
export class DirectHttpTransport implements PortalTransport {
  constructor(private readonly request: FetchLike = fetch) {}
  async listAppointments(session: Session): Promise<unknown> {
    const url = validatedUrl(session.request.url);
    const result = await this.request(url.toString(), { method: "GET", headers: session.request.headers });
    if (result.status === 401 || result.status === 403) throw new CliError("AUTH_REQUIRED");
    if (!result.ok) throw new CliError("PORTAL_REQUEST_FAILED");
    let payload: unknown;
    try {
      payload = await result.json();
    } catch {
      throw new CliError("PORTAL_CONTRACT_CHANGED");
    }
    if (isExactSessionExpiredPayload(payload)) throw new CliError("AUTH_REQUIRED");
    try {
      parseAppointmentsEnvelope(payload);
    } catch {
      throw new CliError("PORTAL_CONTRACT_CHANGED");
    }
    return payload;
  }
}

/** Opens headed Chrome; credential entry remains exclusively on the official portal. */
export async function observeLogin(options: { rememberDocument: boolean; identity: RememberedIdentity | null; replay?: FetchLike } = { rememberDocument: false, identity: null }): Promise<LoginCapture> {
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    await prefillDocument(page, options.identity);
    const submittedIdentity = await captureDocumentOnOfficialLoginActivation(page, options.rememberDocument);
    const misCitas = page.getByText("Mis citas", { exact: true }).first();
    const response = await captureAfterAuthenticatedActivation({
      waitForAuthenticatedControl: () => misCitas.waitFor({ state: "visible", timeout: 0 }),
      armResponse: (timeout) => page.waitForResponse((candidate) => {
        const request = candidate.request();
        if (request.method() !== "GET" || !candidate.ok()) return false;
        try { validatedUrl(request.url()); return true; } catch { return false; }
      }, { timeout }),
      activateControl: () => misCitas.click(),
      validate: validateObservedAppointmentsResponse,
    });
    const session: Session = { version: 1, request: await captureRequest(response.request(), context) };
    // Browser and context deliberately remain open until this direct replay proves the artifact.
    await new DirectHttpTransport(options.replay).listAppointments(session);
    return { session, rememberedIdentity: await submittedIdentity() };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("LOGIN_NOT_COMPLETED");
  } finally {
    await context.close();
    await browser.close();
  }
}
