/**
 * Truncates a sandbox tool output string that exceeds 25% of the agent's context window.
 * Uses a head+tail split so the agent sees both the beginning and end of the output.
 * The omitted middle is replaced with a marker listing granular recovery commands.
 * Pass charLimitOverride (a positive character count) to use a fixed budget instead of the 25% rule.
 */
export const truncateToolOutput = (
  output: string,
  maxContextLength: number | undefined,
  toolName: string,
  tailFraction = 0.1,
  charLimitOverride?: number,
): string => {
  const effectiveCtx = (maxContextLength != null && maxContextLength > 0) ? maxContextLength : 128_000;
  const charLimit =
    charLimitOverride != null && charLimitOverride > 0
      ? charLimitOverride
      : Math.floor(effectiveCtx * 0.25 * 4);
  const clampedTail = Math.min(1, Math.max(0, tailFraction));
  if (output.length <= charLimit) return output;
  const headChars = Math.floor(charLimit * (1 - clampedTail));
  const tailChars = charLimit - headChars;
  // Safety guard: if the split would be nonsensical for any reason, return unchanged.
  if (headChars + tailChars >= output.length) return output;
  const omitted = output.length - headChars - tailChars;
  const marker =
    `\n\n[${toolName.toUpperCase()} OUTPUT TRUNCATED: output was ${output.length} characters; ` +
    `showing first ${headChars} and last ${tailChars} characters ` +
    `(limit: ${charLimit} = 25% of ${effectiveCtx}-token context). ` +
    `${omitted} characters omitted. To read specific sections use:\n` +
    `  grep -n "pattern" <file>        # find specific text\n` +
    `  sed -n '1,50p' <file>           # lines 1–50\n` +
    `  head -n 100 <file>              # first 100 lines\n` +
    `  tail -n 100 <file>              # last 100 lines\n` +
    `  awk 'NR>=10 && NR<=50' <file>   # lines 10–50]`;
  const head = output.slice(0, headChars);
  // slice(-0) === slice(0) returns the full string — guard tailChars=0 explicitly.
  const tail = tailChars > 0 ? output.slice(-tailChars) : '';
  return head + marker + tail;
};
