export default function handler(
  request: unknown,
  response: unknown
): Promise<void>;

export function emailSettingsSendingRecoveryState(
  pending: Record<string, unknown> | null,
  nowMilliseconds?: number
): "not_sending" | "in_flight" | "expired";
