/**
 * Which bot name and recording-notice a dispatch actually uses.
 *
 * Pure so the precedence is testable without the Recall suite's mocks. When
 * recordersMayOverrideBot is false the workspace value wins even if the caller
 * supplied one — otherwise the setting would be advisory only, which is not a
 * setting.
 */
export function resolveBotIdentity(
  request: { bot_name?: string | null; notify_chat?: boolean | null },
  workspace: { botName: string; notifyChat: boolean; recordersMayOverrideBot: boolean },
): { botName: string; notifyChat: boolean } {
  if (!workspace.recordersMayOverrideBot) {
    return { botName: workspace.botName, notifyChat: workspace.notifyChat };
  }
  return {
    botName: request.bot_name?.trim() || workspace.botName,
    notifyChat: request.notify_chat ?? workspace.notifyChat,
  };
}
