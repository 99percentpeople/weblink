export const getInitials = (name = "") =>
  name
    .split(" ")
    .map((part) => part[0])
    .splice(0, 2)
    .join("")
    .toUpperCase();
