/**
 * Best-effort in-memory registry of sessions with a response mid-stream.
 * Used to 409 compaction while streaming. Single-process only by design —
 * the frontend also disables the control while streaming.
 */
const active = new Set<string>();

export const markStreamActive = (sessionID: string): void => {
  active.add(sessionID);
};

export const clearStreamActive = (sessionID: string): void => {
  active.delete(sessionID);
};

export const isStreamActive = (sessionID: string): boolean => active.has(sessionID);
