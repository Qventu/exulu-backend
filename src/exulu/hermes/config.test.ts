import { join } from "node:path";
import {
  exuluMcpUrlFor,
  getExuluMcpBaseUrl,
  getExuluMcpKey,
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

describe("ExuluTools MCP helpers", () => {
  it("getExuluMcpKey prefers EXULU_MCP_KEY, falls back to LITELLM_MASTER_KEY", () => {
    process.env.LITELLM_MASTER_KEY = "sk-master";
    delete process.env.EXULU_MCP_KEY;
    expect(getExuluMcpKey()).toBe("sk-master");
    process.env.EXULU_MCP_KEY = "mcp-secret";
    expect(getExuluMcpKey()).toBe("mcp-secret");
  });

  it("getExuluMcpBaseUrl honors EXULU_MCP_BASE_URL, else 127.0.0.1:<port>", () => {
    delete process.env.EXULU_MCP_BASE_URL;
    delete process.env.EXULU_PORT;
    process.env.PORT = "4567";
    expect(getExuluMcpBaseUrl()).toBe("http://127.0.0.1:4567");
    process.env.EXULU_MCP_BASE_URL = "https://exulu.internal:9000/";
    expect(getExuluMcpBaseUrl()).toBe("https://exulu.internal:9000");
  });

  it("exuluMcpUrlFor builds the per-agent path", () => {
    process.env.EXULU_MCP_BASE_URL = "http://127.0.0.1:3000";
    expect(exuluMcpUrlFor("agent-xyz")).toBe("http://127.0.0.1:3000/mcp/agent-xyz");
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
