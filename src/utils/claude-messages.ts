export const CLAUDE_MESSAGES = {
  anthropic_token_variable_not_encrypted: `
\x1b[41m -- Anthropic token variable set by your admin is not encrypted. This poses a security risk. Please contact your admin to fix the variable used for your key. --
\x1b[0m`,
  anthropic_token_variable_not_found: `
\x1b[41m -- Anthropic token variable not found. Please contact your Exulu adminto fix the variable used for the key. --
\x1b[0m`,
  authentication_error: `
\x1b[41m -- Authentication error please check your IMP token and try again. --
\x1b[0m`,
  missing_body: `
\x1b[41m -- Missing body Anthropic response. --
\x1b[0m`,
  missing_nextauth_secret: `
\x1b[41m -- Missing NEXTAUTH_SECRET in environment variables on the server. --
\x1b[0m`,
  not_enabled: `
\x1b[41m -- The agent you selected does not have a valid API key set for it. --
\x1b[0m`,
  missing_project: `
\x1b[41m -- Project not found or you do not have access to it. --
\x1b[0m`,
};
