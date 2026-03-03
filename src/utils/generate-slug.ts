export function generateSlug(name: string): string {
  // Normalize Unicode characters (e.g., ü -> u)
  const normalized = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  // Convert to lowercase
  const lowercase = normalized.toLowerCase();
  // Replace non-word characters and spaces with hyphens
  const slug = lowercase.replace(/[\W_]+/g, "-").replace(/^-+|-+$/g, "");
  return slug;
}
