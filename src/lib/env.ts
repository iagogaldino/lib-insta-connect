export function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (typeof value === "undefined") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}
