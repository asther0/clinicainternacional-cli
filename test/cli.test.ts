import { describe, expect, test } from "bun:test";
import { run } from "../src/app.js";
import { CliError } from "../src/errors.js";
import { compareAppointments, parseAppointmentsEnvelope } from "../src/parser.js";
import { DirectHttpTransport, backendOrigin, appointmentPath, captureReplayRequest, loginDocumentSelector, rememberedIdentityFromSubmittedDocument, type LoginCapture, type PortalTransport } from "../src/transport.js";
import { MemoryVault, type Session, type SessionVault } from "../src/vault.js";

const request = { url: `${backendOrigin}${appointmentPath}`, headers: { authorization: "Bearer redacted", channel: "web", idtransaction: "opaque", cookie: "sid=redacted" } };
const session: Session = { version: 1, request };
const empty = { bodyResponse: { appointmentsNumber: 0, list: [] } };

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

  test("rejects aliases, count mismatches, and unknown non-empty item schemas", () => {
    for (const value of [{ appointments: [] }, { bodyResponse: { appointmentsNumber: 1, list: [] } }, { bodyResponse: { appointmentsNumber: 1, list: [{}] } }]) {
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
});
