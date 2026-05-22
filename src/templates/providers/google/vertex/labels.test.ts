import {
  sanitizeLabelKey,
  sanitizeLabelValue,
  buildLabels,
  createLabeledFetch,
} from "./labels";

describe("sanitizeLabelKey", () => {
  it("lowercases and replaces invalid chars with dashes", () => {
    expect(sanitizeLabelKey("Hello World!")).toBe("hello-world-");
  });

  it("prefixes keys not starting with a letter", () => {
    expect(sanitizeLabelKey("123abc")).toBe("k_123abc");
    expect(sanitizeLabelKey("_underscore")).toBe("k__underscore");
  });

  it("truncates to 63 chars", () => {
    const key = sanitizeLabelKey("a".repeat(100));
    expect(key).toHaveLength(63);
  });

  it("handles empty input by prefixing", () => {
    expect(sanitizeLabelKey("")).toBe("k_");
  });
});

describe("sanitizeLabelValue", () => {
  it("returns undefined for null and undefined", () => {
    expect(sanitizeLabelValue(undefined)).toBeUndefined();
    expect(sanitizeLabelValue(null)).toBeUndefined();
  });

  it("coerces numbers to strings", () => {
    expect(sanitizeLabelValue(42)).toBe("42");
  });

  it("lowercases and replaces invalid chars", () => {
    expect(sanitizeLabelValue("Gemini-2.5-Flash")).toBe("gemini-2-5-flash");
  });

  it("truncates to 63 chars", () => {
    const value = sanitizeLabelValue("b".repeat(100));
    expect(value).toHaveLength(63);
  });

  it("preserves empty string as empty", () => {
    expect(sanitizeLabelValue("")).toBe("");
  });
});

describe("buildLabels", () => {
  it("emits all six labels when all fields are present", () => {
    const labels = buildLabels({
      providerId: "default_vertex_gemini_2_5_flash_provider",
      providerName: "GEMINI-2.5-FLASH",
      user: 42,
      role: "admin-role",
      project: "proj-1",
      agent: "agent-1",
    });
    expect(labels).toEqual({
      provider_id: "default_vertex_gemini_2_5_flash_provider",
      provider_name: "gemini-2-5-flash",
      user_id: "42",
      role_id: "admin-role",
      project_id: "proj-1",
      agent_id: "agent-1",
    });
  });

  it("drops undefined fields", () => {
    const labels = buildLabels({
      providerId: "p1",
      providerName: "name1",
    });
    expect(Object.keys(labels).sort()).toEqual(["provider_id", "provider_name"]);
  });

  it("drops empty values after sanitization", () => {
    const labels = buildLabels({
      providerId: "p1",
      providerName: "name1",
      role: "...", // all chars get replaced with `-`, never becomes empty though
      project: "", // empty value should be dropped
    });
    expect(labels.project_id).toBeUndefined();
  });

  it("sanitizes provider names with periods", () => {
    const labels = buildLabels({
      providerId: "id1",
      providerName: "GEMINI-2.5-PRO",
    });
    expect(labels.provider_name).toBe("gemini-2-5-pro");
  });
});

describe("createLabeledFetch", () => {
  const labels = { provider_id: "p1", agent_id: "a1" };

  function makeStubFetch() {
    const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    const stub = jest.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response("ok", { status: 200 });
    });
    const original = globalThis.fetch;
    (globalThis as any).fetch = stub;
    return {
      calls,
      restore: () => {
        (globalThis as any).fetch = original;
      },
    };
  }

  it("merges labels into JSON body and forwards", async () => {
    const stub = makeStubFetch();
    try {
      const labeled = createLabeledFetch(labels);
      await labeled("https://x/y", {
        method: "POST",
        body: JSON.stringify({ contents: ["hi"] }),
        headers: { "content-type": "application/json", "content-length": "20" },
      });

      const body = JSON.parse(stub.calls[0].init!.body as string);
      expect(body).toEqual({
        contents: ["hi"],
        labels: { provider_id: "p1", agent_id: "a1" },
      });
      const headers = stub.calls[0].init!.headers as Record<string, string>;
      expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("content-length");
      expect(headers["content-type"]).toBe("application/json");
    } finally {
      stub.restore();
    }
  });

  it("merges with pre-existing labels (caller-supplied wins)", async () => {
    const stub = makeStubFetch();
    try {
      const labeled = createLabeledFetch({ provider_id: "new" });
      await labeled("https://x", {
        method: "POST",
        body: JSON.stringify({ labels: { provider_id: "old", custom: "keep" } }),
      });
      const body = JSON.parse(stub.calls[0].init!.body as string);
      expect(body.labels).toEqual({ provider_id: "new", custom: "keep" });
    } finally {
      stub.restore();
    }
  });

  it("decodes Uint8Array bodies", async () => {
    const stub = makeStubFetch();
    try {
      const labeled = createLabeledFetch(labels);
      const encoded = new TextEncoder().encode(JSON.stringify({ contents: [] }));
      await labeled("https://x", {
        method: "POST",
        body: encoded,
      });
      const body = JSON.parse(stub.calls[0].init!.body as string);
      expect(body.labels).toEqual(labels);
    } finally {
      stub.restore();
    }
  });

  it("forwards non-JSON bodies unchanged", async () => {
    const stub = makeStubFetch();
    try {
      const labeled = createLabeledFetch(labels);
      await labeled("https://x", {
        method: "POST",
        body: "not-json",
      });
      expect(stub.calls[0].init!.body).toBe("not-json");
    } finally {
      stub.restore();
    }
  });

  it("forwards requests with no body unchanged", async () => {
    const stub = makeStubFetch();
    try {
      const labeled = createLabeledFetch(labels);
      await labeled("https://x", { method: "GET" });
      expect(stub.calls[0].init!.body).toBeUndefined();
    } finally {
      stub.restore();
    }
  });
});
