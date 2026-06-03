import { join } from "node:path";
import {
  getIdleTimeoutMs,
  getMaxGateways,
  getPortRange,
  getProfileDir,
  isHermesEnabled,
} from "./config";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("isHermesEnabled", () => {
  it("is true only for the exact string 'true'", () => {
    process.env.ENABLE_HERMES_AGENT = "true";
    expect(isHermesEnabled()).toBe(true);
    process.env.ENABLE_HERMES_AGENT = "1";
    expect(isHermesEnabled()).toBe(false);
    delete process.env.ENABLE_HERMES_AGENT;
    expect(isHermesEnabled()).toBe(false);
  });
});

describe("getPortRange", () => {
  it("defaults to 8642-8700", () => {
    delete process.env.HERMES_PORT_RANGE;
    expect(getPortRange()).toEqual({ start: 8642, end: 8700 });
  });

  it("parses a valid range", () => {
    process.env.HERMES_PORT_RANGE = "9000-9010";
    expect(getPortRange()).toEqual({ start: 9000, end: 9010 });
  });

  it("throws on a malformed range", () => {
    process.env.HERMES_PORT_RANGE = "not-a-range";
    expect(() => getPortRange()).toThrow(/Invalid HERMES_PORT_RANGE/);
  });

  it("throws when start > end", () => {
    process.env.HERMES_PORT_RANGE = "9010-9000";
    expect(() => getPortRange()).toThrow(/Invalid HERMES_PORT_RANGE/);
  });
});

describe("getMaxGateways", () => {
  it("defaults to 20 and rejects junk", () => {
    delete process.env.HERMES_MAX_GATEWAYS;
    expect(getMaxGateways()).toBe(20);
    process.env.HERMES_MAX_GATEWAYS = "-3";
    expect(getMaxGateways()).toBe(20);
    process.env.HERMES_MAX_GATEWAYS = "7";
    expect(getMaxGateways()).toBe(7);
  });
});

describe("getIdleTimeoutMs", () => {
  it("defaults to 15 minutes", () => {
    delete process.env.HERMES_IDLE_TIMEOUT_MS;
    expect(getIdleTimeoutMs()).toBe(15 * 60 * 1000);
  });
});

describe("getProfileDir", () => {
  it("nests private-scope profiles under <agent>/<user>", () => {
    process.env.HERMES_HOME = "/tmp/hermes-test-home";
    expect(getProfileDir("agent-1")).toBe(
      join("/tmp/hermes-test-home", "profiles", "agent-1"),
    );
    expect(getProfileDir("agent-1/42")).toBe(
      join("/tmp/hermes-test-home", "profiles", "agent-1", "42"),
    );
  });
});
