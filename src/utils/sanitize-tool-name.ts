export function sanitizeToolName(name: string): string {
  if (typeof name !== "string") return "";

  // Step 1: Replace invalid characters with underscores
  // Keep a-z, A-Z, 0-9, underscores (_), dots (.), colons (:), and dashes (-)
  let sanitized = name.replace(/[^a-zA-Z0-9_.\:-]+/g, "_");

  // Step 2: Ensure it starts with a letter or underscore (Vertex AI requirement)
  // If it starts with a number, dash, dot, or colon, prepend an underscore
  if (sanitized.length > 0 && !/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = "_" + sanitized;
  }

  // Step 3: Remove leading/trailing underscores (but keep at least one if needed for validation)
  sanitized = sanitized.replace(/^_+|_+$/g, "");

  // Step 4: If empty after cleanup, provide a default
  if (!sanitized) {
    sanitized = "tool";
  }

  // Step 5: Trim to 64 characters (Vertex AI requirement)
  if (sanitized.length > 64) {
    sanitized = sanitized.substring(0, 64);
  }

  // Step 6: Final check - ensure it still starts with letter or underscore after trimming
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = "_" + sanitized.substring(1);
  }

  return sanitized;
}
