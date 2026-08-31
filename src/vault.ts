import { Entry } from "@napi-rs/keyring";
import { CliError } from "./errors.js";

export type CapturedRequest = { url: string; headers: Record<string, string> };
export type Session = { version: 1; request: CapturedRequest };
export type RememberedIdentity = { document: string; documentType?: string };

export interface SessionVault {
  readSession(): Promise<Session | null>;
  writeSession(session: Session): Promise<void>;
  deleteSession(): Promise<void>;
  readIdentity(): Promise<RememberedIdentity | null>;
  writeIdentity(identity: RememberedIdentity): Promise<void>;
  deleteIdentity(): Promise<void>;
}

const service = "com.clinicainternacional.cli";
const sessionAccount = "session.v1";
const identityAccount = "remembered-document.v1";

function parse<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function keychain<T>(operation: () => T): T {
  try { return operation(); } catch { throw new CliError("KEYCHAIN_UNAVAILABLE"); }
}

/** macOS Keychain-backed vault. There is no file, environment, or CLI fallback. */
export class KeychainVault implements SessionVault {
  private entry(account: string) { return keychain(() => new Entry(service, account)); }
  async readSession() { return keychain(() => parse<Session>(this.entry(sessionAccount).getPassword())); }
  async writeSession(session: Session) { keychain(() => this.entry(sessionAccount).setPassword(JSON.stringify(session))); }
  async deleteSession() { keychain(() => this.entry(sessionAccount).deleteCredential()); }
  async readIdentity() { return keychain(() => parse<RememberedIdentity>(this.entry(identityAccount).getPassword())); }
  async writeIdentity(identity: RememberedIdentity) { keychain(() => this.entry(identityAccount).setPassword(JSON.stringify(identity))); }
  async deleteIdentity() { keychain(() => this.entry(identityAccount).deleteCredential()); }
}

/** Test-only vault; production wiring always uses KeychainVault. */
export class MemoryVault implements SessionVault {
  private session: Session | null;
  private identity: RememberedIdentity | null = null;
  constructor(session: (Session & Partial<RememberedIdentity>) | null = null) {
    this.session = session ? { version: session.version, request: session.request } : null;
    if (session?.document) this.identity = { document: session.document };
  }
  async readSession() { return this.session; }
  async writeSession(session: Session) { this.session = session; }
  async deleteSession() { this.session = null; }
  async readIdentity() { return this.identity; }
  async writeIdentity(identity: RememberedIdentity) { this.identity = identity; }
  async deleteIdentity() { this.identity = null; }
}
