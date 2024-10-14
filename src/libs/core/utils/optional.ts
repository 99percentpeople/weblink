/**
 * Convert valid value to string, invalid value will be null
 * @param v
 * @returns
 */
export const optional = <
  T extends string | number | Date | null | undefined,
>(
  v: T,
): T | null => {
  if (typeof v === "string")
    return v.length === 0 ? null : v;
  else if (typeof v === "number")
    return v === 0 || Number.isNaN(v) ? null : v;
  else if (v instanceof Date) return v;
  return null;
};
