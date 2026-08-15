import { CliError } from "./errors.js";
import type { RememberedIdentity } from "./vault.js";

type Appointment = { date: string; doctor: string; specialty: string };
type EmptyAppointmentsEnvelope = { bodyResponse: { appointmentsNumber: number; list: unknown[] } };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The only recorded portal fixture is an empty response at bodyResponse.
 * Keep this codec isolated so a redacted real non-empty fixture can extend it.
 */
export function parseAppointmentsEnvelope(payload: unknown): EmptyAppointmentsEnvelope {
  if (!object(payload) || !object(payload.bodyResponse)) throw new CliError("PORTAL_CONTRACT_CHANGED");
  const { appointmentsNumber, list } = payload.bodyResponse;
  if (typeof appointmentsNumber !== "number" || !Number.isInteger(appointmentsNumber) || appointmentsNumber < 0 || !Array.isArray(list)) throw new CliError("PORTAL_CONTRACT_CHANGED");
  if (appointmentsNumber !== list.length) throw new CliError("PORTAL_CONTRACT_CHANGED");
  if (list.length > 0) throw new CliError("PORTAL_CONTRACT_CHANGED");
  return { bodyResponse: { appointmentsNumber, list } };
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
