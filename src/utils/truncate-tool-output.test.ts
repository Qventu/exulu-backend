import { truncateToolOutput } from './truncate-tool-output';

// charLimit when maxContextLength=128_000: floor(128_000 * 0.25 * 4) = 128_000
// With tailFraction=0.1 (default): headChars=115_200, tailChars=12_800
const LIMIT = 128_000;

describe('truncateToolOutput', () => {
  it('returns output unchanged when at or under the limit', () => {
    const output = 'x'.repeat(LIMIT);
    expect(truncateToolOutput(output, 128_000, 'bash')).toBe(output);
  });

  it('truncates into head + marker + tail when over limit', () => {
    // 200_000 chars > 128_000 limit
    // headChars = floor(128_000 * 0.9) = 115_200
    // tailChars = 128_000 - 115_200 = 12_800
    const head = 'A'.repeat(115_200);
    const middle = 'M'.repeat(72_000); // omitted section
    const tail = 'B'.repeat(12_800);
    const output = head + middle + tail;

    const result = truncateToolOutput(output, 128_000, 'bash', 0.1);

    expect(result.startsWith(head)).toBe(true);
    expect(result).toContain('BASH OUTPUT TRUNCATED');
    expect(result.endsWith(tail)).toBe(true);
    expect(result.length).toBeLessThan(output.length);
  });

  it('marker includes original length and omitted character count', () => {
    const output = 'x'.repeat(200_000);
    const result = truncateToolOutput(output, 128_000, 'bash', 0.1);
    expect(result).toContain('200000');  // original length
    expect(result).toContain('72000');   // omitted = 200_000 - 128_000
    expect(result).toContain('115200');  // headChars
    expect(result).toContain('12800');   // tailChars
  });

  it('uses 128k default when maxContextLength is undefined', () => {
    const output = 'x'.repeat(200_000);
    const withUndefined = truncateToolOutput(output, undefined, 'bash');
    const withExplicit  = truncateToolOutput(output, 128_000, 'bash');
    expect(withUndefined).toBe(withExplicit);
  });

  it('uses 128k default when maxContextLength is 0', () => {
    const output = 'x'.repeat(200_000);
    const result = truncateToolOutput(output, 0, 'bash');
    expect(result).toContain('BASH OUTPUT TRUNCATED');
  });

  it('uses 128k default when maxContextLength is negative', () => {
    const output = 'x'.repeat(200_000);
    const result = truncateToolOutput(output, -1, 'bash');
    expect(result).toContain('BASH OUTPUT TRUNCATED');
  });

  it('tailFraction=0 produces head-only truncation with no tail after marker', () => {
    const output = 'A'.repeat(200_000);
    const result = truncateToolOutput(output, 128_000, 'bash', 0);
    // headChars=128_000, tailChars=0 — no tail slice
    const markerIdx = result.indexOf('BASH OUTPUT TRUNCATED');
    expect(markerIdx).toBeGreaterThan(0);
    // The closing bracket ends the result — no tail after marker
    expect(result.endsWith(']')).toBe(true);
  });

  it('tailFraction=1 produces marker+tail with no head before marker', () => {
    const output = 'x'.repeat(200_000);
    const result = truncateToolOutput(output, 128_000, 'bash', 1);
    // headChars=0 — result starts immediately with the marker
    expect(result.startsWith('\n\n[')).toBe(true);
    // tailChars=128_000 — last 128_000 chars of output appear after marker
    expect(result.endsWith('x'.repeat(128_000))).toBe(true);
  });

  it('clamps tailFraction above 1 to 1', () => {
    const output = 'x'.repeat(200_000);
    const withClamped  = truncateToolOutput(output, 128_000, 'bash', 1);
    const withExceeded = truncateToolOutput(output, 128_000, 'bash', 99);
    expect(withExceeded).toBe(withClamped);
  });

  it('clamps tailFraction below 0 to 0', () => {
    const output = 'x'.repeat(200_000);
    const withClamped  = truncateToolOutput(output, 128_000, 'bash', 0);
    const withNegative = truncateToolOutput(output, 128_000, 'bash', -5);
    expect(withNegative).toBe(withClamped);
  });

  it('uppercases toolName in the marker', () => {
    const output = 'x'.repeat(200_000);
    const result = truncateToolOutput(output, 128_000, 'readFile', 0.05);
    expect(result).toContain('READFILE OUTPUT TRUNCATED');
  });

  it('marker contains recovery command examples', () => {
    const output = 'x'.repeat(200_000);
    const result = truncateToolOutput(output, 128_000, 'bash', 0.1);
    expect(result).toContain('grep');
    expect(result).toContain('sed');
    expect(result).toContain('head');
    expect(result).toContain('tail');
    expect(result).toContain('awk');
  });
});

// Verify the per-field tailFraction values match the spec
describe('truncateToolOutput — per-field tailFraction contracts', () => {
  const OVER = 200_000;

  it('readFile tailFraction=0.05: tail is 6_400 chars (5% of 128k limit)', () => {
    const output = 'x'.repeat(OVER);
    const result = truncateToolOutput(output, 128_000, 'readFile', 0.05);
    // headChars = floor(128_000 * 0.95) = 121_600; tailChars = 6_400
    expect(result.endsWith('x'.repeat(6_400))).toBe(true);
  });

  it('bash stdout tailFraction=0.10: tail is 12_800 chars (10% of 128k limit)', () => {
    const output = 'x'.repeat(OVER);
    const result = truncateToolOutput(output, 128_000, 'bash', 0.10);
    // headChars = floor(128_000 * 0.9) = 115_200; tailChars = 12_800
    expect(result.endsWith('x'.repeat(12_800))).toBe(true);
  });

  it('bash stderr tailFraction=0.40: tail is 51_200 chars (40% of 128k limit)', () => {
    const output = 'x'.repeat(OVER);
    const result = truncateToolOutput(output, 128_000, 'bash', 0.40);
    // headChars = floor(128_000 * 0.6) = 76_800; tailChars = 51_200
    expect(result.endsWith('x'.repeat(51_200))).toBe(true);
  });
});

describe("charLimitOverride", () => {
  it("uses the override instead of the 25% rule", () => {
    const output = "a".repeat(10_000);
    const result = truncateToolOutput(output, 1_000_000, "readFile", 0.1, 4_000);
    expect(result.length).toBeLessThan(10_000);
    expect(result).toContain("OUTPUT TRUNCATED");
    // head 90% + tail 10% of the 4000-char budget
    expect(result.startsWith("a".repeat(3_600))).toBe(true);
    expect(result.endsWith("a".repeat(400))).toBe(true);
  });

  it("ignores a non-positive override", () => {
    const output = "a".repeat(10);
    expect(truncateToolOutput(output, 128_000, "bash", 0.1, 0)).toBe(output);
  });
});
