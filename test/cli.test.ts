import { describe, expect, test } from "bun:test";
import { run } from "../src/app.js";
import { CliError } from "../src/errors.js";
import { compareAppointments, parseAppointmentsEnvelope } from "../src/parser.js";
import { DirectHttpTransport, backendOrigin, appointmentPath, captureAfterAuthenticatedActivation, captureReplayRequest, loginDocumentSelector, rememberedIdentityFromSubmittedDocument, type LoginCapture, type PortalTransport } from "../src/transport.js";
import { MemoryVault, type Session, type SessionVault } from "../src/vault.js";

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
}

const loginResult: LoginCapture = { session, rememberedIdentity: null };
const execute = (
  args: string[],
  vault = new MemoryVault(),
  transport: PortalTransport = new FakeTransport(),
  login: (options: { rememberDocument: boolean; identity: { document: string } | null }) => Promise<LoginCapture> = async () => loginResult
) => run(args, { vault, transport, login });

describe("clinicai tracer contract", () => {
  test("accepts only an opted-in, bounded document submitted from the official input", () => {
    expect(loginDocumentSelector).toContain('placeholder="Nro de documento"');
    expect(rememberedIdentityFromSubmittedDocument(false, "12345678")).toBeNull();
    expect(rememberedIdentityFromSubmittedDocument(true, "")).toBeNull();
    expect(rememberedIdentityFromSubmittedDocument(true, " ")).toBeNull();
    expect(rememberedIdentityFromSubmittedDocument(true, "1".repeat(65))).toBeNull();
    expect(rememberedIdentityFromSubmittedDocument(true, " 12345678 ")).toEqual({ document: "12345678" });
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
    const vault = new MemoryVault();
    const result = await execute(["auth", "login"], vault, new FakeTransport(), async () => { throw new CliError("AUTH_ARTIFACT_UNSUPPORTED"); });
    expect(result.stderr).toBe("AUTH_ARTIFACT_UNSUPPORTED\n");
    expect(await vault.readSession()).toBeNull();
  });

  test("remembers only an explicitly opted-in document and supports forgetting it", async () => {
    const vault = new MemoryVault();
    const login = async ({ rememberDocument }: { rememberDocument: boolean }): Promise<LoginCapture> => ({ session, rememberedIdentity: rememberDocument ? { document: "12345678" } : null });
    expect((await execute(["auth", "login"], vault, new FakeTransport(), login)).exitCode).toBe(0);
    expect(await vault.readIdentity()).toBeNull();
    expect((await execute(["auth", "login", "--remember-document"], vault, new FakeTransport(), login)).stdout).toBe('{"ok":true,"status":"logged_in"}\n');
    expect(await vault.readIdentity()).toEqual({ document: "12345678" });
    expect((await execute(["auth", "forget-document"], vault)).stdout).toBe('{"ok":true,"status":"document_forgotten"}\n');
    expect(await vault.readIdentity()).toBeNull();
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

});
