export const getInitials = (name = "") => {
  const normalized = name.trim();
  if (!normalized) return "?";

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    return (
      Array.from(parts[0])[0] +
      Array.from(parts[parts.length - 1])[0]
    ).toUpperCase();
  }

  return Array.from(parts[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
};
