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

export type ParsedProfile = {
  documentNumber: string;
  documentType: string;
  names: string;
  lastName: string;
  lastName2: string;
};

export type PublicPatient = { ref: "holder"; name: string; documentLast3: string; relationship: "self" };
export type VisitType = "CM" | "CV";
export type PublicSpecialty = {
  code: string;
  name: string;
  isPediatric: boolean;
  isPrincipal: boolean;
  locations: Array<{ code: string; name: string }>;
};

const PROFILE_PATIENT_KEYS = ["documentNumber", "documentType", "lastName", "lastName2", "names"] as const;
const PROFILE_BODY_KEYS = ["liveWell", "patient"] as const;
const FAMILIES_BODY_KEYS = ["families", "holderNames"] as const;

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  if (keys.length !== expected.length) return false;
  const sorted = [...keys].sort();
  const sortedExpected = [...expected].sort();
  for (let i = 0; i < sortedExpected.length; i += 1) {
    if (sorted[i] !== sortedExpected[i]) return false;
  }
  return true;
}

/**
 * Profile parser: the holder profile returned by POST /v1/patientdata/obtaindata.
 *
 * Accepts only the exact observed envelope: two keys `auditResponse`/`bodyResponse`,
 * the existing six-string audit shape with `responseCode '0'`, exact `bodyResponse`
 * keys `patient`/`liveWell`, and required patient string fields
 * `documentNumber`, `documentType`, `names`, `lastName`, `lastName2`. Other
 * `patient`/`liveWell` fields are allowed but never exposed; only the required
 * strings are returned. Any drift is PORTAL_CONTRACT_CHANGED.
 */
export function parseProfile(payload: unknown): ParsedProfile {
  if (!object(payload)) throw new CliError("PORTAL_CONTRACT_CHANGED");
  if (!exactKeys(payload, ["auditResponse", "bodyResponse"])) throw new CliError("PORTAL_CONTRACT_CHANGED");
  const audit = payload.auditResponse;
  if (!object(audit) || !hasExactAuditShape(audit)) throw new CliError("PORTAL_CONTRACT_CHANGED");
  if (audit.responseCode !== "0") throw new CliError("PORTAL_CONTRACT_CHANGED");
  const body = payload.bodyResponse;
  if (!object(body) || !exactKeys(body, PROFILE_BODY_KEYS)) throw new CliError("PORTAL_CONTRACT_CHANGED");
  const patient = body.patient;
  const liveWell = body.liveWell;
  if (!object(patient) || !object(liveWell)) throw new CliError("PORTAL_CONTRACT_CHANGED");
  const out: Record<string, unknown> = {};
  for (const required of PROFILE_PATIENT_KEYS) {
    const value = patient[required];
    if (typeof value !== "string") throw new CliError("PORTAL_CONTRACT_CHANGED");
    out[required] = value;
  }
  return out as unknown as ParsedProfile;
}

/**
 * Family parser: the holder's family roster returned by GET /v1/patientdata/familylist.
 *
 * For this slice accepts ONLY the exact observed no-relative form:
 *   auditResponse (six-string shape, responseCode '1'),
 *   bodyResponse { holderNames: null, families: [] }.
 * Non-empty / unobserved relatives or any drift fail closed as PORTAL_CONTRACT_CHANGED.
 */
export function parseFamilies(payload: unknown): { holderNames: null; families: [] } {
  if (!object(payload)) throw new CliError("PORTAL_CONTRACT_CHANGED");
  if (!exactKeys(payload, ["auditResponse", "bodyResponse"])) throw new CliError("PORTAL_CONTRACT_CHANGED");
  const audit = payload.auditResponse;
  if (!object(audit) || !hasExactAuditShape(audit)) throw new CliError("PORTAL_CONTRACT_CHANGED");
  if (audit.responseCode !== "1") throw new CliError("PORTAL_CONTRACT_CHANGED");
  const body = payload.bodyResponse;
  if (!object(body) || !exactKeys(body, FAMILIES_BODY_KEYS)) throw new CliError("PORTAL_CONTRACT_CHANGED");
  if (body.holderNames !== null) throw new CliError("PORTAL_CONTRACT_CHANGED");
  if (!Array.isArray(body.families) || body.families.length !== 0) throw new CliError("PORTAL_CONTRACT_CHANGED");
  return { holderNames: null, families: [] };
}

function normalizeNamePart(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Patients list parser: the public run()-level entry point for `clinicai patients list`.
 *
 * Verifies that the profile's `documentNumber` and `documentType` exactly match
 * the remembered identity (else IDENTITY_REQUIRED), parses the families payload
 * (which only accepts the observed no-relative form), and emits the redacted
 * holder-only public output `{ok:true, patients:[{ref, name, documentLast3, relationship}]}`.
 * Non-empty names/lastName/lastName2 parts are whitespace-normalized and joined
 * with a single space; `documentLast3` is the digits-only trailing three of the
 * profile document number. No other patient or liveWell fields are ever exposed.
 */
export function parsePatients(
  profile: unknown,
  families: unknown,
  identity: RememberedIdentity,
): { ok: true; patients: PublicPatient[] } {
  const parsed = parseProfile(profile);
  if (parsed.documentNumber !== identity.document) throw new CliError("IDENTITY_REQUIRED");
  if (parsed.documentType !== identity.documentType) throw new CliError("IDENTITY_REQUIRED");
  parseFamilies(families);
  const parts = [parsed.names, parsed.lastName, parsed.lastName2]
    .map(normalizeNamePart)
    .filter((part) => part.length > 0);
  const name = parts.join(" ");
  const documentLast3 = parsed.documentNumber.replace(/\D/g, "").slice(-3);
  return { ok: true, patients: [{ ref: "holder", name, documentLast3, relationship: "self" }] };
}

const SPECIALTY_KEYS = ["headquarters", "isPediatric", "isPrincipal", "specialtyCode", "specialtyModal", "specialtyName"] as const;
const HEADQUARTERS_KEYS = ["codeHeadquarters", "nameHeadquarters", "visitType"] as const;

function requiredTrimmedString(value: unknown): string {
  if (typeof value !== "string") throw new CliError("PORTAL_CONTRACT_CHANGED");
  const trimmed = value.trim();
  if (!trimmed) throw new CliError("PORTAL_CONTRACT_CHANGED");
  return trimmed;
}

function portalBoolean(value: unknown): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CliError("PORTAL_CONTRACT_CHANGED");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Parses the exact live specialty envelope and exposes only agent-safe filters. */
export function parseSpecialties(
  payload: unknown,
  visitType: VisitType,
): { ok: true; visitType: VisitType; specialties: PublicSpecialty[] } {
  if (!object(payload) || !exactKeys(payload, ["auditResponse", "bodyResponse"])) throw new CliError("PORTAL_CONTRACT_CHANGED");
  const audit = payload.auditResponse;
  if (!object(audit) || !hasExactAuditShape(audit) || audit.responseCode !== "0") throw new CliError("PORTAL_CONTRACT_CHANGED");
  const body = payload.bodyResponse;
  if (!object(body) || !exactKeys(body, ["specialties"]) || !Array.isArray(body.specialties)) throw new CliError("PORTAL_CONTRACT_CHANGED");

  const specialties = body.specialties.map((value): PublicSpecialty => {
    if (!object(value) || !exactKeys(value, SPECIALTY_KEYS)) throw new CliError("PORTAL_CONTRACT_CHANGED");
    if (value.specialtyModal !== null && !object(value.specialtyModal)) throw new CliError("PORTAL_CONTRACT_CHANGED");
    if (!Array.isArray(value.headquarters)) throw new CliError("PORTAL_CONTRACT_CHANGED");
    const locations = value.headquarters.map((headquarters) => {
      if (!object(headquarters) || !exactKeys(headquarters, HEADQUARTERS_KEYS)) throw new CliError("PORTAL_CONTRACT_CHANGED");
      if (headquarters.visitType !== visitType) throw new CliError("PORTAL_CONTRACT_CHANGED");
      return {
        code: requiredTrimmedString(headquarters.codeHeadquarters),
        name: requiredTrimmedString(headquarters.nameHeadquarters),
      };
    }).sort((a, b) => compareText(a.name, b.name) || compareText(a.code, b.code));
    return {
      code: requiredTrimmedString(value.specialtyCode),
      name: requiredTrimmedString(value.specialtyName),
      isPediatric: portalBoolean(value.isPediatric),
      isPrincipal: portalBoolean(value.isPrincipal),
      locations,
    };
  }).sort((a, b) => compareText(a.name, b.name) || compareText(a.code, b.code));

  return { ok: true, visitType, specialties };
}
