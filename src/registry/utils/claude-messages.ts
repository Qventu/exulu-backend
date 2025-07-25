export const CLAUDE_MESSAGES = {
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
\x1b[31m
███████╗██╗  ██╗██╗   ██╗██╗      ██╗   ██╗
██╔════╝╚██╗██╔╝██║   ██║██║      ██║   ██║
█████╗   ╚███╔╝ ██║   ██║██║      ██║   ██║
██╔══╝   ██╔██╗ ██║   ██║██║      ██║   ██║
███████╗██╔╝ ██╗╚██████╔╝███████╗╚██████╔╝
╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝ ╚═════╝ 
Intelligence Management Platform
\x1b[0m
\x1b[41m -- Your account has not been enabled to use Claude Code, please contact your admin or enable Claude Code in the user settings. --
\x1b[0m`
}