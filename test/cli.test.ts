import { describe, expect, test } from "bun:test";
import { run } from "../src/app.js";
import { CliError } from "../src/errors.js";
import { compareAppointments, parseAppointmentsEnvelope, parseFamilies, parsePatients, parseProfile } from "../src/parser.js";
import { DirectHttpTransport, backendOrigin, appointmentPath, captureAfterAuthenticatedActivation, captureDocumentOnOfficialLoginActivation, captureReplayRequest, familiesPath, installRememberedLoginPrefill, loginDocumentSelector, officialLoginButtonName, profilePath, readRememberedIdentityFromSessionStorage, rememberedIdentityFromAuthenticatedPair, rememberedIdentityFromSubmittedDocument, type LoginCapture, type PortalTransport } from "../src/transport.js";
import { MemoryVault, type RememberedIdentity, type Session, type SessionVault } from "../src/vault.js";

const request = { url: `${backendOrigin}${appointmentPath}`, headers: { authorization: "Bearer redacted", channel: "web", idtransaction: "opaque", cookie: "sid=redacted" } };
const session: Session = { version: 1, request };
const empty = { bodyResponse: { appointmentsNumber: 0, list: [] } };
const currentEmpty = { bodyResponse: { appointmentsNumber: "0", appointments: [] } };
const auditedEmpty = {
  auditResponse: {
    idTransaction: "opaque-tx",
    serviceName: "opaque-svc",
    methodName: "opaque-method",
    date: "1970-01-01T00:00:00Z",
    responseCode: "0",
    responseMessage: "ok",
  },
  bodyResponse: { appointmentsNumber: 0, appointments: [] },
};

class FakeTransport implements PortalTransport {
  constructor(private readonly data: unknown = empty, private readonly failure?: CliError) {}
  async listAppointments() { if (this.failure) throw this.failure; return this.data; }
  async listPatients(): Promise<{ profile: unknown; families: unknown }> { throw new Error("not used"); }
}

const loginResult: LoginCapture = { session, rememberedIdentity: null };
const execute = (
  args: string[],
  vault = new MemoryVault(),
  transport: PortalTransport = new FakeTransport(),
  login: (options: { rememberDocument: boolean; identity: { document: string } | null }) => Promise<LoginCapture> = async () => loginResult
) => run(args, { vault, transport, login });

function installLoginActivationPage(options: { delayBinding?: boolean } = {}) {
  class FakeInput { value = "12345678"; }
  const originalInput = globalThis.HTMLInputElement;
  const originalWindow = globalThis.window;
  const input = new FakeInput();
  let buttonListener: (() => void) | undefined;
  let keydownListener: ((event: KeyboardEvent) => void) | undefined;
  let buttonListenerOptions: AddEventListenerOptions | boolean | undefined;
  let documentListenerOptions: AddEventListenerOptions | boolean | undefined;
  let binding: ((source: unknown, value: unknown) => boolean | Promise<boolean>) | undefined;
  let releaseBinding = () => {};
  const document = {
    querySelector: (selector: string) => selector === loginDocumentSelector ? input : null,
    addEventListener: (type: string, listener: (event: KeyboardEvent) => void, listenerOptions?: AddEventListenerOptions | boolean) => {
      if (type === "keydown") {
        keydownListener = listener;
        documentListenerOptions = listenerOptions;
      }
    },
    removeEventListener: () => {},
  };
  const button = {
    ownerDocument: document,
    addEventListener: (type: string, listener: () => void, listenerOptions?: AddEventListenerOptions | boolean) => {
      if (type === "click") {
        buttonListener = listener;
        buttonListenerOptions = listenerOptions;
      }
    },
    removeEventListener: () => {},
  };
  const calls: unknown[] = [];
  const page = {
    exposeBinding: async (_name: string, callback: (source: unknown, value: unknown) => boolean | Promise<boolean>) => { binding = callback; },
    getByRole: (role: string, roleOptions: unknown) => {
      calls.push(role, roleOptions);
      return {
        waitFor: async (waitOptions: unknown) => { calls.push(waitOptions); },
        evaluate: async (callback: (element: typeof button, selector: string) => void, selector: string) => callback(button, selector),
      };
    },
  };
  Object.defineProperty(globalThis, "HTMLInputElement", { configurable: true, value: FakeInput });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __clinicaiCaptureSubmittedDocument: async (value: string) => {
        if (!options.delayBinding) return binding?.({}, value) ?? false;
        return new Promise<boolean>((resolve) => {
          releaseBinding = async () => resolve(await (binding?.({}, value) ?? false));
        });
      },
    },
  });
  return {
    page,
    input,
    calls,
    get buttonListenerOptions() { return buttonListenerOptions; },
    get documentListenerOptions() { return documentListenerOptions; },
    click: () => buttonListener?.(),
    keydown: (key: string) => keydownListener?.({ key } as KeyboardEvent),
    get releaseBinding() { return releaseBinding; },
    restore: () => {
      Object.defineProperty(globalThis, "HTMLInputElement", { configurable: true, value: originalInput });
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    },
  };
}

describe("clinicai tracer contract", () => {
  test("accepts only an opted-in, bounded document captured from the official input", () => {
    expect(loginDocumentSelector).toContain('placeholder="Nro de documento"');
    expect(officialLoginButtonName).toBe("Ingresar");
    expect(rememberedIdentityFromSubmittedDocument(false, "12345678")).toBeNull();
    expect(rememberedIdentityFromSubmittedDocument(true, "")).toBeNull();
    expect(rememberedIdentityFromSubmittedDocument(true, " ")).toBeNull();
    expect(rememberedIdentityFromSubmittedDocument(true, "1".repeat(65))).toBeNull();
    expect(rememberedIdentityFromSubmittedDocument(true, " 12345678 ")).toEqual({ document: "12345678" });
  });

  test("accepts only an opted-in, bounded authenticated pair with both non-empty bounded strings", () => {
    // Opted out: never persists the pair.
    expect(rememberedIdentityFromAuthenticatedPair(false, "12345678", "1")).toBeNull();
    // Empty or whitespace document.
    expect(rememberedIdentityFromAuthenticatedPair(true, "", "1")).toBeNull();
    expect(rememberedIdentityFromAuthenticatedPair(true, " ", "1")).toBeNull();
    // Empty or whitespace documentType.
    expect(rememberedIdentityFromAuthenticatedPair(true, "12345678", "")).toBeNull();
    expect(rememberedIdentityFromAuthenticatedPair(true, "12345678", " ")).toBeNull();
    // Bounded document (<=64) and documentType (<=16).
    expect(rememberedIdentityFromAuthenticatedPair(true, "1".repeat(65), "1")).toBeNull();
    expect(rememberedIdentityFromAuthenticatedPair(true, "12345678", "1".repeat(17))).toBeNull();
    // Non-string or null/undefined values.
    expect(rememberedIdentityFromAuthenticatedPair(true, 12345678, "1")).toBeNull();
    expect(rememberedIdentityFromAuthenticatedPair(true, "12345678", 1)).toBeNull();
    expect(rememberedIdentityFromAuthenticatedPair(true, null, "1")).toBeNull();
    expect(rememberedIdentityFromAuthenticatedPair(true, "12345678", null)).toBeNull();
    expect(rememberedIdentityFromAuthenticatedPair(true, undefined, "1")).toBeNull();
    expect(rememberedIdentityFromAuthenticatedPair(true, "12345678", undefined)).toBeNull();
    // Happy path: exact authenticated pair, both values trimmed.
    expect(rememberedIdentityFromAuthenticatedPair(true, "12345678", "1")).toEqual({ document: "12345678", documentType: "1" });
    expect(rememberedIdentityFromAuthenticatedPair(true, " 12345678 ", " 1 ")).toEqual({ document: "12345678", documentType: "1" });
  });

  test("captures at the exact official Ingresar click in capture phase", async () => {
    const activation = installLoginActivationPage();
    try {
      const captured = await captureDocumentOnOfficialLoginActivation(activation.page as never, true);
      activation.click();
      expect(activation.calls).toEqual(["button", { name: officialLoginButtonName, exact: true }, { state: "visible" }]);
      expect(activation.buttonListenerOptions).toEqual({ capture: true });
      expect(await captured()).toEqual({ document: "12345678" });
    } finally {
      activation.restore();
    }
  });

  test("captures the official document on an Enter keydown at document capture phase", async () => {
    const activation = installLoginActivationPage();
    try {
      const captured = await captureDocumentOnOfficialLoginActivation(activation.page as never, true);
      activation.keydown("Escape");
      activation.keydown("Enter");
      expect(activation.documentListenerOptions).toEqual({ capture: true });
      expect(await captured()).toEqual({ document: "12345678" });
    } finally {
      activation.restore();
    }
  });

  test("waits for a delayed asynchronous binding after replay", async () => {
    const activation = installLoginActivationPage({ delayBinding: true });
    try {
      const captured = await captureDocumentOnOfficialLoginActivation(activation.page as never, true, 100);
      activation.click();
      const result = captured();
      activation.releaseBinding();
      expect(await result).toEqual({ document: "12345678" });
    } finally {
      activation.restore();
    }
  });

  test("keeps the first valid official activation when click and Enter both fire", async () => {
    const activation = installLoginActivationPage();
    try {
      const captured = await captureDocumentOnOfficialLoginActivation(activation.page as never, true);
      activation.click();
      activation.input.value = "87654321";
      activation.keydown("Enter");
      expect(await captured()).toEqual({ document: "12345678" });
    } finally {
      activation.restore();
    }
  });

  test("does not bind document capture when remembering is opted out", async () => {
    const page = {
      exposeBinding: () => { throw new Error("should not bind"); },
      getByRole: () => { throw new Error("should not locate"); },
    };
    expect(await (await captureDocumentOnOfficialLoginActivation(page as never, false))()).toBeNull();
  });

  test("returns null after a bounded wait when no official activation is captured", async () => {
    const activation = installLoginActivationPage();
    try {
      const captured = await captureDocumentOnOfficialLoginActivation(activation.page as never, true, 10);
      const started = Date.now();
      expect(await captured()).toBeNull();
      expect(Date.now() - started).toBeLessThan(250);
    } finally {
      activation.restore();
    }
  });

  test("reads the exact authenticated pair from sessionStorage with opt-out and invalid fallbacks", async () => {
    const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    const installSessionStorage = (values: Record<string, string | null>) => {
      Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        value: { getItem: (key: string) => key in values ? values[key] : null },
      });
    };
    const page = { evaluate: async <T>(fn: () => T) => fn() };
    try {
      // Happy path: exact authenticated pair present in sessionStorage.
      installSessionStorage({ documentNumber: "12345678", documentType: "1" });
      expect(await readRememberedIdentityFromSessionStorage(page as never, true)).toEqual({ document: "12345678", documentType: "1" });
      // Opt-out: rememberDocument=false never reads or persists the pair.
      expect(await readRememberedIdentityFromSessionStorage(page as never, false)).toBeNull();
      // Invalid: documentNumber missing from sessionStorage.
      installSessionStorage({ documentType: "1" });
      expect(await readRememberedIdentityFromSessionStorage(page as never, true)).toBeNull();
      // Invalid: documentType missing from sessionStorage.
      installSessionStorage({ documentNumber: "12345678" });
      expect(await readRememberedIdentityFromSessionStorage(page as never, true)).toBeNull();
      // Invalid: documentType exceeds the bounded length.
      installSessionStorage({ documentNumber: "12345678", documentType: "1".repeat(17) });
      expect(await readRememberedIdentityFromSessionStorage(page as never, true)).toBeNull();
      // Invalid: document exceeds the bounded length.
      installSessionStorage({ documentNumber: "1".repeat(65), documentType: "1" });
      expect(await readRememberedIdentityFromSessionStorage(page as never, true)).toBeNull();
    } finally {
      if (originalSessionStorage) Object.defineProperty(globalThis, "sessionStorage", originalSessionStorage);
      else delete (globalThis as Record<string, unknown>).sessionStorage;
    }
  });

  test("returns null when page.evaluate throws and never reads sessionStorage when opted out", async () => {
    // page.evaluate throws on every read: the reader must swallow the failure
    // and return null so observeLogin can fall back to the activation-captured identity.
    let evaluateCalls = 0;
    const throwingPage = { evaluate: async () => { evaluateCalls += 1; throw new Error("sessionStorage unavailable"); } };
    expect(await readRememberedIdentityFromSessionStorage(throwingPage as never, true)).toBeNull();
    expect(evaluateCalls).toBe(1);
    // Opt-out: page.evaluate must not be invoked at all.
    const optOutPage = { evaluate: async () => { throw new Error("should not evaluate"); } };
    expect(await readRememberedIdentityFromSessionStorage(optOutPage as never, false)).toBeNull();
  });

  test("emits an empty observed envelope with redacted remembered identity", async () => {
    const vault = new MemoryVault({ ...session, document: "12345678" });
    const result = await execute(["appointments", "list"], vault);
    expect(result).toEqual({ stdout: '{"appointments":[],"identity":{"documentLast3":"678"},"ok":true}\n', stderr: "", exitCode: 0 });
  });

  test("normalizes the legacy and current exact empty envelopes", () => {
    const normalized = { bodyResponse: { appointmentsNumber: 0, appointments: [] } };
    expect(parseAppointmentsEnvelope(empty)).toEqual(normalized);
    expect(parseAppointmentsEnvelope(currentEmpty)).toEqual(normalized);
  });

  test("normalizes the live audited empty envelope without exposing audit values", () => {
    const normalized = { bodyResponse: { appointmentsNumber: 0, appointments: [] } };
    const out = parseAppointmentsEnvelope(auditedEmpty);
    expect(out).toEqual(normalized);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("auditResponse");
    expect(serialized).not.toContain("idTransaction");
    expect(serialized).not.toContain("serviceName");
    expect(serialized).not.toContain("methodName");
    expect(serialized).not.toContain("responseCode");
    expect(serialized).not.toContain("responseMessage");
    expect(serialized).not.toContain("opaque");
  });

  test("preserves the normalized public output across every accepted form", () => {
    const normalized = { bodyResponse: { appointmentsNumber: 0, appointments: [] } };
    expect(parseAppointmentsEnvelope(empty)).toEqual(normalized);
    expect(parseAppointmentsEnvelope(currentEmpty)).toEqual(normalized);
    expect(parseAppointmentsEnvelope(auditedEmpty)).toEqual(normalized);
    expect(JSON.stringify(parseAppointmentsEnvelope(empty))).not.toContain("auditResponse");
    expect(JSON.stringify(parseAppointmentsEnvelope(currentEmpty))).not.toContain("auditResponse");
    expect(JSON.stringify(parseAppointmentsEnvelope(auditedEmpty))).not.toContain("auditResponse");
  });

  test("normalizes the legacy and current exact empty envelopes", () => {
    for (const value of [
      { appointments: [] },
      { extra: true, bodyResponse: { appointmentsNumber: 0, list: [] } },
      { bodyResponse: { appointmentsNumber: 0, list: [], extra: true } },
      { bodyResponse: { appointmentsNumber: 0, list: [], appointments: [] } },
      { bodyResponse: { appointmentsNumber: 1, list: [] } },
      { bodyResponse: { appointmentsNumber: 1, appointments: [{}] } },
      { bodyResponse: { appointmentsNumber: "00", appointments: [] } },
      { bodyResponse: { appointmentsNumber: "0.0", appointments: [] } },
      { bodyResponse: { appointmentsNumber: "-0", appointments: [] } },
      { bodyResponse: { appointmentsNumber: "0x0", appointments: [] } },
      { bodyResponse: { appointmentsNumber: -1, appointments: [] } },
      { bodyResponse: { appointmentsNumber: 0.5, appointments: [] } },
      { bodyResponse: { appointmentsNumber: Number.MAX_SAFE_INTEGER + 1, appointments: [] } },
    ]) {
      expect(() => parseAppointmentsEnvelope(value)).toThrow(CliError);
    }
  });

  test("rejects hybrid count/array-key combinations that crossed form boundaries", () => {
    const validAudit = {
      idTransaction: "opaque-tx",
      serviceName: "opaque-svc",
      methodName: "opaque-method",
      date: "1970-01-01T00:00:00Z",
      responseCode: "0",
      responseMessage: "ok",
    };
    const validBody = { appointmentsNumber: 0, appointments: [] };
    // Each entry must be rejected: none belongs to one of the three exact forms.
    for (const value of [
      // hybrid: string count with legacy `list` key
      { bodyResponse: { appointmentsNumber: "0", list: [] } },
      // hybrid: numeric count with unaudited `appointments` key
      { bodyResponse: { appointmentsNumber: 0, appointments: [] } },
      // hybrid: string count with audited `appointments` key
      { auditResponse: validAudit, bodyResponse: { appointmentsNumber: "0", appointments: [] } },
      // hybrid: numeric count with audited `list` key
      { auditResponse: validAudit, bodyResponse: { appointmentsNumber: 0, list: [] } },
      // non-zero canonical string in the unaudited appointments form
      { bodyResponse: { appointmentsNumber: "1", appointments: [] } },
      // non-zero canonical string in the audited form
      { auditResponse: validAudit, bodyResponse: { appointmentsNumber: "10", appointments: [] } },
      // boolean count with both shapes
      { bodyResponse: { appointmentsNumber: false, list: [] } },
      { bodyResponse: { appointmentsNumber: true, appointments: [] } },
      { auditResponse: validAudit, bodyResponse: { appointmentsNumber: false, appointments: [] } },
      // null count with both shapes
      { bodyResponse: { appointmentsNumber: null, list: [] } },
      { bodyResponse: { appointmentsNumber: null, appointments: [] } },
      { auditResponse: validAudit, bodyResponse: { appointmentsNumber: null, appointments: [] } },
    ]) {
      expect(() => parseAppointmentsEnvelope(value)).toThrow(CliError);
    }
  });

  test("rejects malformed audited envelopes", () => {
    const validAudit = {
      idTransaction: "opaque-tx",
      serviceName: "opaque-svc",
      methodName: "opaque-method",
      date: "1970-01-01T00:00:00Z",
      responseCode: "0",
      responseMessage: "ok",
    };
    const validBody = { appointmentsNumber: 0, appointments: [] };
    const { idTransaction: _dropId, ...missingId } = validAudit;
    const { serviceName: _dropSvc, ...missingSvc } = validAudit;
    const { responseMessage: _dropMsg, ...missingMsg } = validAudit;
    for (const value of [
      // missing audit keys (truly absent)
      { auditResponse: missingId, bodyResponse: validBody },
      { auditResponse: missingSvc, bodyResponse: validBody },
      { auditResponse: missingMsg, bodyResponse: validBody },
      // audit key with non-string value
      { auditResponse: { ...validAudit, idTransaction: undefined }, bodyResponse: validBody },
      // extra audit key
      { auditResponse: { ...validAudit, extraAudit: "leak" }, bodyResponse: validBody },
      // non-string audit values
      { auditResponse: { ...validAudit, idTransaction: 1 }, bodyResponse: validBody },
      { auditResponse: { ...validAudit, serviceName: null }, bodyResponse: validBody },
      { auditResponse: { ...validAudit, responseCode: { value: "0" } }, bodyResponse: validBody },
      { auditResponse: { ...validAudit, responseMessage: ["ok"] }, bodyResponse: validBody },
      // auditResponse not an object
      { auditResponse: "string-not-object", bodyResponse: validBody },
      { auditResponse: ["not", "an", "object"], bodyResponse: validBody },
      { auditResponse: null, bodyResponse: validBody },
      // extra top-level key
      { auditResponse: validAudit, bodyResponse: validBody, meta: "extra" },
      { auditResponse: validAudit, bodyResponse: validBody, audit: true },
      // only auditResponse, no bodyResponse
      { auditResponse: validAudit },
      // body-level failures under audit
      { auditResponse: validAudit, bodyResponse: { appointmentsNumber: 1, appointments: [{}] } },
      { auditResponse: validAudit, bodyResponse: { appointmentsNumber: 5, appointments: [] } },
      { auditResponse: validAudit, bodyResponse: { appointmentsNumber: "1", appointments: [] } },
      { auditResponse: validAudit, bodyResponse: { appointmentsNumber: 0, appointments: [], list: [] } },
      { auditResponse: validAudit, bodyResponse: { appointmentsNumber: 0, list: [] } },
    ]) {
      expect(() => parseAppointmentsEnvelope(value)).toThrow(CliError);
    }
  });

  test("uses an exact minimal GET and validates its replay envelope", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const transport = new DirectHttpTransport(async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(empty), { status: 200 });
    });
    expect(await transport.listAppointments(session)).toEqual(empty);
    expect(await new DirectHttpTransport(async () => new Response(JSON.stringify(currentEmpty), { status: 200 })).listAppointments(session)).toEqual(currentEmpty);
    expect(calls).toEqual([{ input: `${backendOrigin}${appointmentPath}`, init: { method: "GET", headers: request.headers } }]);
    await expect(new DirectHttpTransport(async () => new Response(JSON.stringify({ bodyResponse: { appointmentsNumber: 1, list: [{}] } }), { status: 200 })).listAppointments(session)).rejects.toMatchObject({ code: "PORTAL_CONTRACT_CHANGED" });
  });

  test("keeps extra top-level keys on the session-expired envelope as a contract mismatch", async () => {
    const expiredWithExtra = {
      auditResponse: {
        idTransaction: "opaque-tx",
        serviceName: "opaque-svc",
        methodName: "opaque-method",
        date: "1970-01-01T00:00:00Z",
        responseCode: "-1",
        responseMessage: "Sesion expirada o no encontrada",
      },
      bodyResponse: null,
      extra: "leak",
    };
    const transport = new DirectHttpTransport(async () => new Response(JSON.stringify(expiredWithExtra), { status: 200 }));
    await expect(transport.listAppointments(session)).rejects.toMatchObject({ code: "PORTAL_CONTRACT_CHANGED" });
  });

  test("captures only the strict replay header allowlist and requires observed artifacts", () => {
    expect(captureReplayRequest(`${backendOrigin}${appointmentPath}`, {
      Channel: "web", IdTransaction: "opaque", Authorization: "Bearer secret", Cookie: "sid=secret", Referer: "discard", "x-extra": "discard"
    }, [])).toEqual({ url: `${backendOrigin}${appointmentPath}`, headers: { channel: "web", idtransaction: "opaque", authorization: "Bearer secret", cookie: "sid=secret" } });
    expect(captureReplayRequest(`${backendOrigin}${appointmentPath}`, { channel: "web", idtransaction: "opaque" }, [{ name: "sid", value: "secret" }]).headers).toEqual({ channel: "web", idtransaction: "opaque", cookie: "sid=secret" });
    expect(() => captureReplayRequest(`${backendOrigin}${appointmentPath}`, { channel: "web", idtransaction: "opaque" }, [])).toThrow(CliError);
  });

  test("invalidates the saved session before reporting an authorization failure", async () => {
    const vault = new MemoryVault(session);
    const result = await execute(["appointments", "list"], vault, new FakeTransport(empty, new CliError("AUTH_REQUIRED")));
    expect(result.stderr).toBe("AUTH_REQUIRED\n");
    expect(await vault.readSession()).toBeNull();
  });

  test("treats the exact audited session-expired envelope as auth required", async () => {
    const vault = new MemoryVault(session);
    const expired = {
      auditResponse: {
        idTransaction: "opaque-tx",
        serviceName: "opaque-svc",
        methodName: "opaque-method",
        date: "1970-01-01T00:00:00Z",
        responseCode: "-1",
        responseMessage: "Sesion expirada o no encontrada",
      },
      bodyResponse: null,
    };
    const transport = new DirectHttpTransport(async () => new Response(JSON.stringify(expired), { status: 200 }));
    const result = await execute(["appointments", "list"], vault, transport);
    expect(result.stderr).toBe("AUTH_REQUIRED\n");
    expect(await vault.readSession()).toBeNull();
  });

  test("arms appointment capture only after authenticated Mis citas is available and before activation", async () => {
    const calls: string[] = [];
    const captured = await captureAfterAuthenticatedActivation({
      waitForAuthenticatedControl: async () => { calls.push("authenticated"); },
      armResponse: async () => { calls.push("armed"); return "response"; },
      activateControl: async () => { calls.push("activated"); },
      validate: async (response) => { calls.push(`validated:${response}`); },
    });
    expect(captured).toBe("response");
    expect(calls).toEqual(["authenticated", "armed", "activated", "validated:response"]);
  });

  test("keeps waiting after a contract-mismatch candidate", async () => {
    const candidates = ["bad", "good"];
    const calls: string[] = [];
    const result = await captureAfterAuthenticatedActivation({
      waitForAuthenticatedControl: async () => { calls.push("authenticated"); },
      armResponse: async () => candidates.shift()!,
      activateControl: async () => { calls.push("activated"); },
      validate: async (candidate) => {
        calls.push(`validated:${candidate}`);
        if (candidate === "bad") throw new CliError("PORTAL_CONTRACT_CHANGED");
      },
    });
    expect(result).toBe("good");
    expect(calls).toEqual(["authenticated", "activated", "validated:bad", "validated:good"]);
  });

  test("returns a stable mismatch code after a timeout or browser close", async () => {
    for (const interruption of ["timeout", "browser closed"]) {
      let attempts = 0;
      await expect(captureAfterAuthenticatedActivation({
        waitForAuthenticatedControl: async () => {},
        armResponse: async () => {
          attempts += 1;
          if (attempts === 1) return "bad";
          throw new Error(interruption);
        },
        activateControl: async () => {},
        validate: async () => { throw new CliError("PORTAL_CONTRACT_CHANGED"); },
      })).rejects.toMatchObject({ code: "PORTAL_CONTRACT_CHANGED" });
    }
  });

  test("does not persist a login when artifact capture/replay is unsupported", async () => {
    class ObservedVault extends MemoryVault {
      writes: string[] = [];
      async writeSession(value: Session) { this.writes.push("session"); await super.writeSession(value); }
      async writeIdentity(value: { document: string }) { this.writes.push("identity"); await super.writeIdentity(value); }
    }
    const vault = new ObservedVault();
    const result = await execute(["auth", "login"], vault, new FakeTransport(), async () => { throw new CliError("AUTH_ARTIFACT_UNSUPPORTED"); });
    expect(result.stderr).toBe("AUTH_ARTIFACT_UNSUPPORTED\n");
    expect(await vault.readSession()).toBeNull();
    expect(await vault.readIdentity()).toBeNull();
    expect(vault.writes).toEqual([]);
  });

  test("remembers only an explicitly opted-in document and supports forgetting it", async () => {
    const vault = new MemoryVault();
    const login = async ({ rememberDocument }: { rememberDocument: boolean }): Promise<LoginCapture> => ({ session, rememberedIdentity: rememberDocument ? { document: "12345678", documentType: "1" } : null });
    expect((await execute(["auth", "login"], vault, new FakeTransport(), login)).exitCode).toBe(0);
    expect(await vault.readIdentity()).toBeNull();
    expect((await execute(["auth", "login", "--remember-document"], vault, new FakeTransport(), login)).stdout).toBe('{"ok":true,"status":"logged_in"}\n');
    expect(await vault.readIdentity()).toEqual({ document: "12345678", documentType: "1" });
    expect((await execute(["auth", "forget-document"], vault)).stdout).toBe('{"ok":true,"status":"document_forgotten"}\n');
    expect(await vault.readIdentity()).toBeNull();
  });

  test("writes the remembered identity only after a successful login capture", async () => {
    class OrderedVault extends MemoryVault {
      writes: string[] = [];
      async writeSession(value: Session) { this.writes.push("session"); await super.writeSession(value); }
      async writeIdentity(value: { document: string }) { this.writes.push("identity"); await super.writeIdentity(value); }
    }
    const vault = new OrderedVault();
    const login = async (): Promise<LoginCapture> => ({ session, rememberedIdentity: { document: "12345678" } });
    expect((await execute(["auth", "login", "--remember-document"], vault, new FakeTransport(), login)).exitCode).toBe(0);
    expect(vault.writes).toEqual(["session", "identity"]);
  });

  test("logout is idempotent and attempts both deletes when one vault operation fails", async () => {
    class PartialVault extends MemoryVault {
      identityDeletes = 0;
      async deleteSession() { throw new Error("unavailable"); }
      async deleteIdentity() { this.identityDeletes += 1; await super.deleteIdentity(); }
    }
    const failing = new PartialVault(session);
    expect((await execute(["auth", "logout"], failing)).stderr).toBe("KEYCHAIN_UNAVAILABLE\n");
    expect(failing.identityDeletes).toBe(1);
    const vault = new MemoryVault();
    expect((await execute(["auth", "logout"], vault)).exitCode).toBe(0);
    expect((await execute(["auth", "logout"], vault)).exitCode).toBe(0);
  });

  test("uses a locale-independent total ordering for ties and reordered input", () => {
    const unordered = [
      { date: "2026-01-01T00:00:00.000Z", doctor: "B", specialty: "A" },
      { date: "2026-01-01T00:00:00.000Z", doctor: "A", specialty: "Z" },
      { date: "2026-01-01T00:00:00.000Z", doctor: "A", specialty: "A" }
    ];
    const ordered = [...unordered].sort(compareAppointments);
    expect(ordered.map((value) => `${value.doctor}:${value.specialty}`)).toEqual(["A:A", "A:Z", "B:A"]);
    expect([...unordered].reverse().sort(compareAppointments)).toEqual(ordered);
  });

  test("reports auth required without leaking internals", async () => {
    const result = await execute(["appointments", "list"]);
    expect(result.stdout).toBe('{"error":{"code":"AUTH_REQUIRED","message":"Authentication required. Run clinicai auth login."},"ok":false}\n');
  });

  test("emits exactly one public JSON line and one stable error code on a contract mismatch", async () => {
    const transport = new DirectHttpTransport(async () => new Response("not json", { status: 200 }));
    const result = await execute(["appointments", "list"], new MemoryVault(session), transport);
    expect(result.stderr).toBe("PORTAL_CONTRACT_CHANGED\n");
    expect(result.stdout).toBe('{"error":{"code":"PORTAL_CONTRACT_CHANGED","message":"The portal response no longer matches the supported contract."},"ok":false}\n');
    expect(result.exitCode).toBe(1);
  });

  test("patients list requires session, then identity with documentType, before doing any work", async () => {
    // No session: AUTH_REQUIRED (identity is irrelevant at this layer).
    const noSession = new MemoryVault();
    expect((await execute(["patients", "list"], noSession)).stderr).toBe("AUTH_REQUIRED\n");
    // Session but no identity: IDENTITY_REQUIRED.
    const sessionOnly = new MemoryVault(session);
    expect((await execute(["patients", "list"], sessionOnly)).stderr).toBe("IDENTITY_REQUIRED\n");
    // Identity with document but no documentType: IDENTITY_REQUIRED, message directs --remember-document.
    const missingType = new MemoryVault({ ...session, document: "12345678" });
    const missingResult = await execute(["patients", "list"], missingType);
    expect(missingResult.stderr).toBe("IDENTITY_REQUIRED\n");
    expect(missingResult.stdout).toBe('{"error":{"code":"IDENTITY_REQUIRED","message":"A remembered document with type is required. Run clinicai auth login --remember-document."},"ok":false}\n');
  });

  test("MemoryVault constructor preserves the optional documentType from the seed", async () => {
    const withType = new MemoryVault({ ...session, document: "12345678", documentType: "1" });
    expect(await withType.readIdentity()).toEqual({ document: "12345678", documentType: "1" });
    const withoutType = new MemoryVault({ ...session, document: "12345678" });
    expect(await withoutType.readIdentity()).toEqual({ document: "12345678" });
    const empty = new MemoryVault(null);
    expect(await empty.readIdentity()).toBeNull();
  });

  test("patients list emits the observed holder-only public output with redacted contract fields", async () => {
    const remembered: RememberedIdentity = { document: "12345678", documentType: "1" };
    const vault = new MemoryVault({ ...session, document: remembered.document, documentType: remembered.documentType });
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const validAudit = {
      idTransaction: "opaque-tx",
      serviceName: "opaque-svc",
      methodName: "opaque-method",
      date: "1970-01-01T00:00:00Z",
      responseCode: "0",
      responseMessage: "ok",
    };
    const profileFixture = {
      auditResponse: { ...validAudit },
      bodyResponse: {
        patient: {
          documentNumber: "12345678",
          documentType: "1",
          names: "Juan",
          lastName: "Perez",
          lastName2: "Gomez",
          phone: "987654321",
          email: "juan@example.com",
          internalId: "internal-leak",
          address: "redacted address",
          insurer: "redacted insurer",
          token: "redacted token",
        },
        liveWell: { internalFlag: "x", internalScore: 42 },
      },
    };
    const familiesFixture = {
      auditResponse: { ...validAudit, responseCode: "1" },
      bodyResponse: { holderNames: null, families: [] },
    };
    const transport = new DirectHttpTransport(async (input, init) => {
      calls.push({ input, init });
      const method = (init.method ?? "GET").toUpperCase();
      return new Response(JSON.stringify(method === "POST" ? profileFixture : familiesFixture), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await execute(["patients", "list"], vault, transport);
    // Exact request assertions: two calls in order, exact headers, exact POST body.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      input: `${backendOrigin}${profilePath}`,
      init: {
        method: "POST",
        headers: { ...request.headers, "content-type": "application/json" },
        body: JSON.stringify({ documentNumber: "12345678", documentType: "1", idPatientHolder: false }),
      },
    });
    expect(calls[1]).toEqual({
      input: `${backendOrigin}${familiesPath}`,
      init: { method: "GET", headers: { ...request.headers, "content-type": "application/json" } },
    });
    // Exact public output: one holder with assembled name and digits-only last3.
    expect(result.stdout).toBe('{"ok":true,"patients":[{"ref":"holder","name":"Juan Perez Gomez","documentLast3":"678","relationship":"self"}]}\n');
    // Redaction assertions: nothing internal or audit-related leaks. The
    // assembled name legitimately contains "Gomez" and the wrapper key is
    // "patients" (which contains "patient" as a substring), so neither is
    // forbidden here.
    for (const forbidden of ["auditResponse", "idTransaction", "serviceName", "methodName", "responseCode", "responseMessage", "liveWell", "families", "holderNames", "phone", "987654321", "email", "juan@example.com", "internalId", "internal-leak", "address", "insurer", "token", "internalFlag", "internalScore", "12345678"]) {
      expect(result.stdout).not.toContain(forbidden);
    }
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("patients list normalizes whitespace and empty name parts when assembling the holder name", () => {
    const validAudit = {
      idTransaction: "opaque-tx",
      serviceName: "opaque-svc",
      methodName: "opaque-method",
      date: "1970-01-01T00:00:00Z",
      responseCode: "0",
      responseMessage: "ok",
    };
    const profile = {
      auditResponse: validAudit,
      bodyResponse: {
        patient: { documentNumber: " 12-345-678 ", documentType: "1", names: "  Maria   Jose ", lastName: "  Lopez ", lastName2: "" },
        liveWell: {},
      },
    };
    const families = {
      auditResponse: { ...validAudit, responseCode: "1" },
      bodyResponse: { holderNames: null, families: [] },
    };
    expect(parsePatients(profile, families, { document: " 12-345-678 ", documentType: "1" })).toEqual({
      ok: true,
      patients: [{ ref: "holder", name: "Maria Jose Lopez", documentLast3: "678", relationship: "self" }],
    });
  });

  test("patients list fails closed on profile document/type identity mismatch with IDENTITY_REQUIRED", () => {
    const validAudit = {
      idTransaction: "opaque-tx",
      serviceName: "opaque-svc",
      methodName: "opaque-method",
      date: "1970-01-01T00:00:00Z",
      responseCode: "0",
      responseMessage: "ok",
    };
    const profile = {
      auditResponse: validAudit,
      bodyResponse: {
        patient: { documentNumber: "12345678", documentType: "1", names: "Juan", lastName: "Perez", lastName2: "Gomez" },
        liveWell: {},
      },
    };
    const families = {
      auditResponse: { ...validAudit, responseCode: "1" },
      bodyResponse: { holderNames: null, families: [] },
    };
    expect(() => parsePatients(profile, families, { document: "99999999", documentType: "1" })).toThrow(new CliError("IDENTITY_REQUIRED"));
    expect(() => parsePatients(profile, families, { document: "12345678", documentType: "2" })).toThrow(new CliError("IDENTITY_REQUIRED"));
  });

  test("parseProfile accepts only the exact observed envelope and required patient strings", () => {
    const validAudit = {
      idTransaction: "opaque-tx",
      serviceName: "opaque-svc",
      methodName: "opaque-method",
      date: "1970-01-01T00:00:00Z",
      responseCode: "0",
      responseMessage: "ok",
    };
    // Happy path: extra patient/liveWell fields are allowed but never returned.
    const out = parseProfile({
      auditResponse: validAudit,
      bodyResponse: {
        patient: { documentNumber: "12345678", documentType: "1", names: "Juan", lastName: "Perez", lastName2: "Gomez", phone: "9", insurer: "x" },
        liveWell: { flag: true },
      },
    });
    expect(out).toEqual({ documentNumber: "12345678", documentType: "1", names: "Juan", lastName: "Perez", lastName2: "Gomez" });
    // Returns must never carry extra keys.
    expect(Object.keys(out).sort()).toEqual(["documentNumber", "documentType", "lastName", "lastName2", "names"]);
    // Unordered bodyResponse keys are accepted (exactKeys is order-independent).
    expect(parseProfile({
      auditResponse: validAudit,
      bodyResponse: { liveWell: { flag: true }, patient: { documentNumber: "x", documentType: "1", names: "n", lastName: "l", lastName2: "l2" } },
    })).toEqual({ documentNumber: "x", documentType: "1", names: "n", lastName: "l", lastName2: "l2" });
    // Near-miss rejections (PORTAL_CONTRACT_CHANGED).
    const cases: unknown[] = [
      null,
      "string",
      { auditResponse: validAudit },
      { bodyResponse: { patient: {}, liveWell: {} } },
      { auditResponse: validAudit, bodyResponse: { patient: {}, liveWell: {} }, extra: "leak" },
      { auditResponse: validAudit, bodyResponse: { patient: {}, liveWell: {} } },
      { auditResponse: { ...validAudit, responseCode: "1" }, bodyResponse: { patient: {}, liveWell: {} } },
      { auditResponse: { ...validAudit, idTransaction: undefined }, bodyResponse: { patient: {}, liveWell: {} } },
      { auditResponse: { ...validAudit, responseCode: 0 }, bodyResponse: { patient: {}, liveWell: {} } },
      { auditResponse: validAudit, bodyResponse: "not-an-object" },
      { auditResponse: validAudit, bodyResponse: { patient: "not-an-object", liveWell: {} } },
      { auditResponse: validAudit, bodyResponse: { patient: { documentNumber: "x", documentType: "1", names: "n", lastName: "l", lastName2: "l2" }, liveWell: "x" } },
      { auditResponse: validAudit, bodyResponse: { patient: { documentNumber: 1, documentType: "1", names: "n", lastName: "l", lastName2: "l2" }, liveWell: {} } },
      { auditResponse: validAudit, bodyResponse: { patient: { documentNumber: "x", names: "n", lastName: "l", lastName2: "l2" }, liveWell: {} } },
      { auditResponse: validAudit, bodyResponse: { patient: { documentNumber: "x", documentType: "1", lastName: "l", lastName2: "l2" }, liveWell: {} } },
      { auditResponse: validAudit, bodyResponse: { patient: { documentNumber: "x", documentType: "1", names: "n", lastName: "l" }, liveWell: {} } },
      { auditResponse: validAudit, bodyResponse: { patient: { documentNumber: "x", documentType: "1", names: "n", lastName: "l", lastName2: "l2" } } },
    ];
    for (const value of cases) expect(() => parseProfile(value)).toThrow(CliError);
  });

  test("parseFamilies accepts only the exact observed no-relative form", () => {
    const validAudit = {
      idTransaction: "opaque-tx",
      serviceName: "opaque-svc",
      methodName: "opaque-method",
      date: "1970-01-01T00:00:00Z",
      responseCode: "0",
      responseMessage: "ok",
    };
    // Happy path.
    expect(parseFamilies({
      auditResponse: { ...validAudit, responseCode: "1" },
      bodyResponse: { holderNames: null, families: [] },
    })).toEqual({ holderNames: null, families: [] });
    // Unordered bodyResponse keys are accepted (exactKeys is order-independent).
    expect(parseFamilies({
      auditResponse: { ...validAudit, responseCode: "1" },
      bodyResponse: { families: [], holderNames: null },
    })).toEqual({ holderNames: null, families: [] });
    // Near-miss rejections.
    const cases: unknown[] = [
      null,
      { auditResponse: { ...validAudit, responseCode: "1" }, bodyResponse: { holderNames: null, families: [{}] } },
      { auditResponse: { ...validAudit, responseCode: "1" }, bodyResponse: { holderNames: "Maria", families: [] } },
      { auditResponse: { ...validAudit, responseCode: "1" }, bodyResponse: { holderNames: null, families: [], extra: true } },
      { auditResponse: { ...validAudit, responseCode: "1" }, bodyResponse: { holderNames: null } },
      { auditResponse: { ...validAudit, responseCode: "0" }, bodyResponse: { holderNames: null, families: [] } },
      { auditResponse: { ...validAudit, responseCode: "1" }, bodyResponse: "x" },
      { auditResponse: { ...validAudit, responseCode: "1" }, bodyResponse: null },
      { bodyResponse: { holderNames: null, families: [] } },
    ];
    for (const value of cases) expect(() => parseFamilies(value)).toThrow(CliError);
  });

  test("patients list transport treats HTTP 401/403 as AUTH_REQUIRED and the app deletes the session", async () => {
    const transport = new DirectHttpTransport(async () => new Response("forbidden", { status: 403 }));
    const vault = new MemoryVault({ ...session, document: "12345678", documentType: "1" });
    const result = await execute(["patients", "list"], vault, transport);
    expect(result.stderr).toBe("AUTH_REQUIRED\n");
    expect(await vault.readSession()).toBeNull();
  });

  test("patients list transport treats the exact audited session-expired envelope as AUTH_REQUIRED and the app deletes the session", async () => {
    const expired = {
      auditResponse: {
        idTransaction: "opaque-tx",
        serviceName: "opaque-svc",
        methodName: "opaque-method",
        date: "1970-01-01T00:00:00Z",
        responseCode: "-1",
        responseMessage: "Sesion expirada o no encontrada",
      },
      bodyResponse: null,
    };
    const transport = new DirectHttpTransport(async () => new Response(JSON.stringify(expired), { status: 200 }));
    const vault = new MemoryVault({ ...session, document: "12345678", documentType: "1" });
    const result = await execute(["patients", "list"], vault, transport);
    expect(result.stderr).toBe("AUTH_REQUIRED\n");
    expect(await vault.readSession()).toBeNull();
  });

  test("patients list transport treats non-empty families or drifted patient/family envelopes as PORTAL_CONTRACT_CHANGED", async () => {
    const validAudit = {
      idTransaction: "opaque-tx",
      serviceName: "opaque-svc",
      methodName: "opaque-method",
      date: "1970-01-01T00:00:00Z",
      responseCode: "0",
      responseMessage: "ok",
    };
    const profile = {
      auditResponse: validAudit,
      bodyResponse: {
        patient: { documentNumber: "12345678", documentType: "1", names: "Juan", lastName: "Perez", lastName2: "Gomez" },
        liveWell: {},
      },
    };
    const driftFamilies = {
      auditResponse: { ...validAudit, responseCode: "1" },
      bodyResponse: { holderNames: null, families: [{ name: "relative" }] },
    };
    const transport = new DirectHttpTransport(async (_input, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      return new Response(JSON.stringify(method === "POST" ? profile : driftFamilies), { status: 200, headers: { "content-type": "application/json" } });
    });
    const vault = new MemoryVault({ ...session, document: "12345678", documentType: "1" });
    const result = await execute(["patients", "list"], vault, transport);
    expect(result.stderr).toBe("PORTAL_CONTRACT_CHANGED\n");
    expect(result.exitCode).toBe(1);
  });

  test("USAGE message advertises patients list", () => {
    const result = (async () => run(["nope"]))();
    return result.then((value) => {
      expect(value.stderr).toBe("USAGE\n");
      expect(value.stdout).toContain("clinicai patients list");
    });
  });

});

describe("installRememberedLoginPrefill", () => {
  test("installs an init script that sets exactly three localStorage keys for typed identity", async () => {
    const captures: Array<{ script: (...args: unknown[]) => unknown; arg: unknown }> = [];
    const fakePage = {
      addInitScript: async (script: (...args: unknown[]) => unknown, arg: unknown) => {
        captures.push({ script, arg });
      },
    };
    await installRememberedLoginPrefill(fakePage as never, { document: "12345678", documentType: "1" });
    expect(captures).toHaveLength(1);
    const { script, arg } = captures[0];
    expect(arg).toEqual({ document: "12345678", documentType: "1" });
    // Execute the captured script with a fake localStorage installed on globalThis.
    const writes: Array<[string, string]> = [];
    const reads: string[] = [];
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        setItem: (key: string, value: string) => { writes.push([key, value]); },
        getItem: (key: string) => { reads.push(key); return null; },
      },
    });
    try {
      const fn = script as (arg: { document: string; documentType: string }) => void;
      fn(arg as { document: string; documentType: string });
      expect(writes).toEqual([
        ["rememberMeIsChecked", "true"],
        ["selectedDocumentTypeCode", "1"],
        ["documentNumber", "12345678"],
      ]);
      expect(reads).toEqual([]);
    } finally {
      if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
      else delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  test("does not install init script for old identity without documentType", async () => {
    let calls = 0;
    const fakePage = {
      addInitScript: async () => { calls += 1; throw new Error("should not call addInitScript"); },
    };
    await installRememberedLoginPrefill(fakePage as never, { document: "12345678" });
    await installRememberedLoginPrefill(fakePage as never, null);
    expect(calls).toBe(0);
  });

  test("does not install init script when documentType is invalid", async () => {
    let calls = 0;
    const fakePage = {
      addInitScript: async () => { calls += 1; throw new Error("should not call addInitScript"); },
    };
    // Empty, whitespace-only, and over-long types must be rejected; the helper
    // must never hand an unbounded type to the init script.
    await installRememberedLoginPrefill(fakePage as never, { document: "12345678", documentType: "" });
    await installRememberedLoginPrefill(fakePage as never, { document: "12345678", documentType: " " });
    await installRememberedLoginPrefill(fakePage as never, { document: "12345678", documentType: "1".repeat(17) });
    expect(calls).toBe(0);
  });

  test("continues without throwing when addInitScript setup fails", async () => {
    const fakePage = {
      addInitScript: async () => { throw new Error("setup failed"); },
    };
    // The helper must swallow addInitScript failures so observeLogin can fall
    // back to the post-goto direct input fill; the user can still select the
    // type manually.
    await expect(
      installRememberedLoginPrefill(fakePage as never, { document: "12345678", documentType: "1" }),
    ).resolves.toBeUndefined();
  });
});
