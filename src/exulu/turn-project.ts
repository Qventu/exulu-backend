/**
 * The project of THIS turn, as one mutable holder shared by every tool factory of the turn.
 * It starts as the access-checked project the turn began with (null = none). create_project
 * sets it after it created and attached a project, so `project/<name>` resolves in the same
 * turn for the document tools. The system prompt of the turn is NOT rebuilt (the model learns
 * from the tool result); the sandbox `project/` folder appears from the next message.
 */
export type TurnProject = {
  current: { id: string; name: string; speakerCanWrite: boolean } | null;
};

export function createTurnProject(initial?: TurnProject["current"] | undefined): TurnProject {
  return { current: initial ? { ...initial } : null };
}

/**
 * The project id a tool should resolve `project/<name>` against right now: the holder when
 * the turn has one (read at call time, not at registration), else the static id older
 * call sites pass.
 */
export function currentProjectId(
  holder: TurnProject | undefined,
  fallback?: string | null,
): string | null {
  if (holder) return holder.current?.id ?? null;
  return fallback ?? null;
}
