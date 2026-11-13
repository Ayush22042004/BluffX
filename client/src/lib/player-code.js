export const normalizePlayerCode = (value) =>
  String(value || "")
    .replace(/[\s-]/g, "")
    .toLowerCase();
export const formatPlayerCode = (value) =>
  normalizePlayerCode(value)
    .toUpperCase()
    .match(/.{1,4}/g)
    ?.join("-") || "";
