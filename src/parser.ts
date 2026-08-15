import { CliError } from "./errors.js";
import type { RememberedIdentity } from "./vault.js";

type Appointment = { date: string; doctor: string; specialty: string };
type EmptyAppointmentsEnvelope = { bodyResponse: { appointmentsNumber: number; appointments: unknown[] } };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const AUDIT_KEYS = ["date", "idTransaction", "methodName", "responseCode", "responseMessage", "serviceName"] as const;
const hasExactAuditShape = (audit: Record<string, unknown>): boolean => {
  const keys = Object.keys(audit);
  if (keys.length !== AUDIT_KEYS.length) return false;
  for (const expected of AUDIT_KEYS) {
    if (!keys.includes(expected) || typeof audit[expected] !== "string") return false;
  }
  return true;
};

const isExactTwoKeys = (record: Record<string, unknown>, required: [string, string]): boolean => {
  const keys = Object.keys(record);
  if (keys.length !== 2) return false;
  const sorted = [...keys].sort();
  return sorted[0] === required[0] && sorted[1] === required[1];
};

/** Unaudited form 1: numeric count with the legacy `list` key. */
const isUnauditedEmptyList = (body: unknown): boolean => {
  if (!object(body)) return false;
  if (!isExactTwoKeys(body, ["appointmentsNumber", "list"])) return false;
  return body.appointmentsNumber === 0 && Array.isArray(body.list) && body.list.length === 0;
};

/** Unaudited form 2: canonical string count with the `appointments` key. */
const isUnauditedEmptyAppointments = (body: unknown): boolean => {
  if (!object(body)) return false;
  if (!isExactTwoKeys(body, ["appointments", "appointmentsNumber"])) return false;
  return body.appointmentsNumber === "0" && Array.isArray(body.appointments) && body.appointments.length === 0;
};

/** Audited form 3: numeric count with `appointments` plus the exact audit envelope. */
const isAuditedEmptyAppointments = (audit: unknown, body: unknown): boolean => {
  if (!object(audit) || !hasExactAuditShape(audit)) return false;
  if (!object(body)) return false;
  if (!isExactTwoKeys(body, ["appointments", "appointmentsNumber"])) return false;
  return body.appointmentsNumber === 0 && Array.isArray(body.appointments) && body.appointments.length === 0;
};

/**
 * The only recorded portal fixture is an empty bodyResponse. Accepts exactly
 * three observed exact empty shapes and nothing else:
 *  1. legacy unaudited:   { bodyResponse: { appointmentsNumber: 0,            list:         [] } }
 *  2. current unaudited:  { bodyResponse: { appointmentsNumber: "0",          appointments: [] } }
 *  3. live audited empty: { auditResponse: { date, idTransaction, methodName, responseCode, responseMessage, serviceName },
 *                           bodyResponse:  { appointmentsNumber: 0,            appointments: [] } }
 *
 * Count type and array key are bound per form to fail closed on any hybrid
 * (string count with `list`, numeric count with unaudited `appointments`,
 * string count with audited `appointments`) or any drift in count encoding.
 * The audit block is consumed for validation only and never appears in the
 * returned envelope; the normalized public output stays
 * { bodyResponse: { appointmentsNumber, appointments } }.
 */
export function parseAppointmentsEnvelope(payload: unknown): EmptyAppointmentsEnvelope {
  if (!object(payload)) throw new CliError("PORTAL_CONTRACT_CHANGED");
  const topKeys = Object.keys(payload).sort();
  let matched = false;
  if (topKeys.length === 1 && topKeys[0] === "bodyResponse") {
    matched = isUnauditedEmptyList(payload.bodyResponse) || isUnauditedEmptyAppointments(payload.bodyResponse);
  } else if (topKeys.length === 2 && topKeys[0] === "auditResponse" && topKeys[1] === "bodyResponse") {
    matched = isAuditedEmptyAppointments(payload.auditResponse, payload.bodyResponse);
  }
  if (!matched) throw new CliError("PORTAL_CONTRACT_CHANGED");
  return { bodyResponse: { appointmentsNumber: 0, appointments: [] } };
}

export function parseAppointments(payload: unknown, identity: RememberedIdentity | null) {
  parseAppointmentsEnvelope(payload);
  const document = identity?.document.replace(/\D/g, "") ?? "";
  return {
    appointments: [] as Appointment[],
    identity: document ? { documentLast3: document.slice(-3) } : null,
    ok: true
  };
}

/** Locale-independent ordering for the later, evidence-backed non-empty codec. */
export function compareAppointments(a: Appointment, b: Appointment): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.doctor < b.doctor ? -1 : a.doctor > b.doctor ? 1 : a.specialty < b.specialty ? -1 : a.specialty > b.specialty ? 1 : 0;
}
