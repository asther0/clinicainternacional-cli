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
const loginUrl = `${frontendOrigin}${loginPath}`;
const replayHeaderNames = new Set(["authorization", "cookie", "channel", "idtransaction"]);
const maxRememberedDocumentLength = 64;
export const loginDocumentSelector = 'input[placeholder="Nro de documento"]';

/** Accepts only the explicitly opted-in document submitted through the login form. */
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

async function captureDocumentWhenSubmitted(page: Page, rememberDocument: boolean): Promise<() => RememberedIdentity | null> {
  let identity: RememberedIdentity | null = null;
  await page.exposeBinding("__clinicaiCaptureSubmittedDocument", (_source, value: unknown) => {
    identity = rememberedIdentityFromSubmittedDocument(rememberDocument, value);
  });
  await page.locator(loginDocumentSelector).evaluate((input) => {
    if (!(input instanceof HTMLInputElement)) return;
    input.form?.addEventListener("submit", () => {
      void (window as typeof window & { __clinicaiCaptureSubmittedDocument: (value: string) => Promise<void> })
        .__clinicaiCaptureSubmittedDocument(input.value);
    }, { once: true });
  });
  return () => identity;
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
    try { payload = await result.json(); } catch { throw new CliError("PORTAL_CONTRACT_CHANGED"); }
    parseAppointmentsEnvelope(payload);
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
    const submittedIdentity = await captureDocumentWhenSubmitted(page, options.rememberDocument);
    const response = await page.waitForResponse((candidate) => {
      const request = candidate.request();
      if (request.method() !== "GET" || !candidate.ok()) return false;
      try { validatedUrl(request.url()); return true; } catch { return false; }
    }, { timeout: 0 });
    let observed: unknown;
    try { observed = await response.json(); } catch { throw new CliError("PORTAL_CONTRACT_CHANGED"); }
    parseAppointmentsEnvelope(observed);
    const session: Session = { version: 1, request: await captureRequest(response.request(), context) };
    // Browser and context deliberately remain open until this direct replay proves the artifact.
    await new DirectHttpTransport(options.replay).listAppointments(session);
    return { session, rememberedIdentity: submittedIdentity() };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("LOGIN_NOT_COMPLETED");
  } finally {
    await context.close();
    await browser.close();
  }
}
