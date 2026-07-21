import { getGoogleCalendarTaskAuthority } from "./googleCalendar";

export type GoogleCalendarTaskAuthorityState = "current" | "deleted" | "stale" | "undated";

export interface GoogleCalendarTaskAuthorityInput {
  id: string;
  ownerUid: string;
  revision?: string | null;
}

export async function inspectGoogleCalendarTaskAuthority(
  input: GoogleCalendarTaskAuthorityInput
): Promise<GoogleCalendarTaskAuthorityState> {
  return getGoogleCalendarTaskAuthority(input);
}
