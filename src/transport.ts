import { chromium, type BrowserContext, type Page, type Request } from "playwright";
import { CliError } from "./errors.js";
import { parseAppointmentsEnvelope, parseFamilies, parseProfile, parseSpecialties, type VisitType } from "./parser.js";
import type { CapturedRequest, RememberedIdentity, Session } from "./vault.js";

export interface PortalTransport {
  listAppointments(session: Session): Promise<unknown>;
  listPatients(session: Session, identity: RememberedIdentity): Promise<{ profile: unknown; families: unknown }>;
  listSpecialties(session: Session, visitType: VisitType): Promise<unknown>;
}
export type LoginCapture = { session: Session; rememberedIdentity: RememberedIdentity | null };
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const frontendOrigin = "https://citasenlinea.clinicainternacional.com.pe";
export const backendOrigin = "https://prdexp.clinicainternacional.com.pe";
export const loginPath = "/authentication/login/login-first-step";
export const appointmentPath = "/v2/appointments/appointmentslist";
export const profilePath = "/v1/patientdata/obtaindata";
export const familiesPath = "/v1/patientdata/familylist";
export const specialtyPath = "/v2/specialty/specialtieslist";
/** Exact accessible name of the visible official login control. */
export const officialLoginButtonName = "Ingresar";
const loginUrl = `${frontendOrigin}${loginPath}`;
const replayHeaderNames = new Set(["authorization", "cookie", "channel", "idtransaction"]);
const maxRememberedDocumentLength = 64;
const maxRememberedDocumentTypeLength = 16;
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

/**
 * Accepts only the explicitly opted-in pair read from sessionStorage after a
 * successful direct replay. Both values must be non-empty bounded strings:
 * document <= 64, documentType <= 16. Old keychain identities with only
 * document remain readable because documentType is optional.
 */
export function rememberedIdentityFromAuthenticatedPair(
  rememberDocument: boolean,
  document: unknown,
  documentType: unknown,
): RememberedIdentity | null {
  if (!rememberDocument || typeof document !== "string" || typeof documentType !== "string") return null;
  const trimmedDocument = document.trim();
  const trimmedType = documentType.trim();
  if (!trimmedDocument || trimmedDocument.length > maxRememberedDocumentLength) return null;
  if (!trimmedType || trimmedType.length > maxRememberedDocumentTypeLength) return null;
  return { document: trimmedDocument, documentType: trimmedType };
}

/**
 * Reads only sessionStorage.getItem('documentNumber') and getItem('documentType')
 * via page.evaluate, then validates the pair. Opts out by returning null without
 * ever calling page.evaluate. A page.evaluate read failure is swallowed and
 * returns null so observeLogin can fall back to the activation-captured identity.
 */
export async function readRememberedIdentityFromSessionStorage(
  page: Page,
  rememberDocument: boolean,
): Promise<RememberedIdentity | null> {
  if (!rememberDocument) return null;
  let pair: { document: string | null; documentType: string | null };
  try {
    pair = await page.evaluate(() => ({
      document: sessionStorage.getItem("documentNumber"),
      documentType: sessionStorage.getItem("documentType"),
    }));
  } catch {
    return null;
  }
  return rememberedIdentityFromAuthenticatedPair(rememberDocument, pair.document, pair.documentType);
}

function validatedUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin !== backendOrigin || url.pathname !== appointmentPath || url.search || url.hash) throw new CliError("PORTAL_CONTRACT_CHANGED");
  return url;
}

function validatedBackendPath(value: string, expectedPath: string): URL {
  const url = new URL(value);
  if (url.origin !== backendOrigin || url.pathname !== expectedPath || url.search || url.hash) throw new CliError("PORTAL_CONTRACT_CHANGED");
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

/**
 * Installs a Playwright init script that, when the official login portal loads,
 * pre-selects the remembered document type and prefills the document number by
 * writing exactly three localStorage keys: rememberMeIsChecked=true,
 * selectedDocumentTypeCode=<type>, and documentNumber=<document>. The portal
 * reads these keys before rendering its document-type selector. No password key,
 * no other storage reads or writes, and no process arguments are referenced.
 *
 * Only acts when the identity has a valid bounded documentType. Old identities
 * without documentType keep the existing direct input fill. Setup failures from
 * addInitScript are swallowed so observeLogin can continue with the direct
 * input fill as a safe value check/fallback.
 */
export async function installRememberedLoginPrefill(page: Page, identity: RememberedIdentity | null): Promise<void> {
  if (!identity) return;
  const type = identity.documentType;
  if (typeof type !== "string") return;
  const trimmedType = type.trim();
  if (!trimmedType || trimmedType.length > maxRememberedDocumentTypeLength) return;
  try {
    await page.addInitScript(
      ({ document, documentType }: { document: string; documentType: string }) => {
        localStorage.setItem("rememberMeIsChecked", "true");
        localStorage.setItem("selectedDocumentTypeCode", documentType);
        localStorage.setItem("documentNumber", document);
      },
      { document: identity.document, documentType: trimmedType },
    );
  } catch {
    // Swallow setup failures so observeLogin can fall back to the direct input fill.
  }
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

  /**
   * Shared JSON request helper: parses, maps HTTP 401/403 and the exact
   * HTTP-200 audited session-expired envelope to AUTH_REQUIRED uniformly
   * across every operation, and rejects any other failure as PORTAL_REQUEST_FAILED.
   */
  private async jsonRequest(url: string, init: RequestInit): Promise<unknown> {
    const result = await this.request(url, init);
    if (result.status === 401 || result.status === 403) throw new CliError("AUTH_REQUIRED");
    if (!result.ok) throw new CliError("PORTAL_REQUEST_FAILED");
    let payload: unknown;
    try {
      payload = await result.json();
    } catch {
      throw new CliError("PORTAL_CONTRACT_CHANGED");
    }
    if (isExactSessionExpiredPayload(payload)) throw new CliError("AUTH_REQUIRED");
    return payload;
  }

  async listAppointments(session: Session): Promise<unknown> {
    const url = validatedUrl(session.request.url);
    const payload = await this.jsonRequest(url.toString(), { method: "GET", headers: session.request.headers });
    try {
      parseAppointmentsEnvelope(payload);
    } catch {
      throw new CliError("PORTAL_CONTRACT_CHANGED");
    }
    return payload;
  }

  async listPatients(session: Session, identity: RememberedIdentity): Promise<{ profile: unknown; families: unknown }> {
    const profileUrl = validatedBackendPath(`${backendOrigin}${profilePath}`, profilePath);
    const profileHeaders = { ...session.request.headers, "content-type": "application/json" };
    const profileBody = JSON.stringify({ documentNumber: identity.document, documentType: identity.documentType, idPatientHolder: false });
    const profile = await this.jsonRequest(profileUrl.toString(), { method: "POST", headers: profileHeaders, body: profileBody });
    try {
      parseProfile(profile);
    } catch {
      throw new CliError("PORTAL_CONTRACT_CHANGED");
    }
    const familiesUrl = validatedBackendPath(`${backendOrigin}${familiesPath}`, familiesPath);
    const familiesHeaders = { ...session.request.headers, "content-type": "application/json" };
    const families = await this.jsonRequest(familiesUrl.toString(), { method: "GET", headers: familiesHeaders });
    try {
      parseFamilies(families);
    } catch {
      throw new CliError("PORTAL_CONTRACT_CHANGED");
    }
    return { profile, families };
  }

  async listSpecialties(session: Session, visitType: VisitType): Promise<unknown> {
    const url = validatedBackendPath(`${backendOrigin}${specialtyPath}`, specialtyPath);
    const headers = { ...session.request.headers, "content-type": "application/json" };
    const body = JSON.stringify({ visible: true, visitType, isCuidate: false });
    const payload = await this.jsonRequest(url.toString(), { method: "POST", headers, body });
    try {
      parseSpecialties(payload, visitType);
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
    // Install the init script before navigation so the portal reads the remembered
    // type and document from localStorage when it renders. addInitScript failures
    // are swallowed inside installRememberedLoginPrefill; the post-goto direct
    // input fill below acts as a safe value check/fallback so the user can still
    // select the type manually.
    await installRememberedLoginPrefill(page, options.identity);
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
    // After successful replay, prefer the validated authenticated pair from sessionStorage;
    // fall back to the activation-captured document for compatibility with old keychain identities.
    const authenticated = await readRememberedIdentityFromSessionStorage(page, options.rememberDocument);
    return { session, rememberedIdentity: authenticated ?? await submittedIdentity() };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("LOGIN_NOT_COMPLETED");
  } finally {
    await context.close();
    await browser.close();
  }
}
