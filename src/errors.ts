export type ErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_ARTIFACT_UNSUPPORTED"
  | "KEYCHAIN_UNAVAILABLE"
  | "PORTAL_CONTRACT_CHANGED"
  | "LOGIN_NOT_COMPLETED"
  | "USAGE"
  | "PORTAL_REQUEST_FAILED";

const messages: Record<ErrorCode, string> = {
  AUTH_REQUIRED: "Authentication required. Run clinicai auth login.",
  AUTH_ARTIFACT_UNSUPPORTED: "The portal session cannot be safely replayed. Run clinicai auth login.",
  KEYCHAIN_UNAVAILABLE: "macOS Keychain is unavailable; no authentication data was changed.",
  PORTAL_CONTRACT_CHANGED: "The portal response no longer matches the supported contract.",
  LOGIN_NOT_COMPLETED: "Login was not completed before a supported appointment request was observed.",
  USAGE: "Usage: clinicai auth <login [--remember-document]|status|logout|forget-document> | clinicai appointments list",
  PORTAL_REQUEST_FAILED: "The portal request could not be completed."
};

export class CliError extends Error {
  constructor(readonly code: ErrorCode) { super(messages[code]); }
  toJSON() { return { error: { code: this.code, message: this.message }, ok: false }; }
}
