import { CliError } from "./errors.js";
import { parseAppointments } from "./parser.js";
import { DirectHttpTransport, observeLogin, type LoginCapture, type PortalTransport } from "./transport.js";
import { KeychainVault, type SessionVault } from "./vault.js";

export type RunResult = { stdout: string; stderr: string; exitCode: number };
type Dependencies = {
  vault?: SessionVault;
  transport?: PortalTransport;
  login?: (options: { rememberDocument: boolean; identity: Awaited<ReturnType<SessionVault["readIdentity"]>> }) => Promise<LoginCapture>;
};
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

async function logout(vault: SessionVault): Promise<void> {
  const outcomes = await Promise.allSettled([vault.deleteSession(), vault.deleteIdentity()]);
  if (outcomes.some((outcome) => outcome.status === "rejected")) throw new CliError("KEYCHAIN_UNAVAILABLE");
}

export async function run(args: string[], dependencies: Dependencies = {}): Promise<RunResult> {
  const vault = dependencies.vault ?? new KeychainVault();
  const transport = dependencies.transport ?? new DirectHttpTransport();
  const login = dependencies.login ?? observeLogin;
  try {
    const rememberDocument = args[0] === "auth" && args[1] === "login" && args[2] === "--remember-document" && args.length === 3;
    if ((args[0] === "auth" && args[1] === "login" && args.length === 2) || rememberDocument) {
      const captured = await login({ rememberDocument, identity: await vault.readIdentity() });
      await vault.writeSession(captured.session);
      if (rememberDocument && captured.rememberedIdentity) await vault.writeIdentity(captured.rememberedIdentity);
      return { stdout: line({ ok: true, status: "logged_in" }), stderr: "", exitCode: 0 };
    }
    if (args[0] === "auth" && args[1] === "forget-document" && args.length === 2) {
      await vault.deleteIdentity();
      return { stdout: line({ ok: true, status: "document_forgotten" }), stderr: "", exitCode: 0 };
    }
    if (args[0] === "auth" && args[1] === "status" && args.length === 2) {
      return { stdout: line({ ok: true, status: await vault.readSession() ? "authenticated" : "unauthenticated" }), stderr: "", exitCode: 0 };
    }
    if (args[0] === "auth" && args[1] === "logout" && args.length === 2) {
      await logout(vault);
      return { stdout: line({ ok: true, status: "logged_out" }), stderr: "", exitCode: 0 };
    }
    if (args[0] === "appointments" && args[1] === "list" && args.length === 2) {
      const session = await vault.readSession();
      if (!session) throw new CliError("AUTH_REQUIRED");
      try {
        const data = await transport.listAppointments(session);
        return { stdout: line(parseAppointments(data, await vault.readIdentity())), stderr: "", exitCode: 0 };
      } catch (error) {
        if (error instanceof CliError && error.code === "AUTH_REQUIRED") await vault.deleteSession();
        throw error;
      }
    }
    throw new CliError("USAGE");
  } catch (error) {
    const safe = error instanceof CliError ? error : new CliError("PORTAL_REQUEST_FAILED");
    return { stdout: line(safe.toJSON()), stderr: `${safe.code}\n`, exitCode: 1 };
  }
}
