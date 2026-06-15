/**
 * Tests for activity-client.ts. Mirrors supervisor.test.ts style (jest.mock
 * + global fetch stub). Focused on the parts that have actual logic:
 *   - getTagDailyActivity query-string assembly
 *   - listTagsByPrefix sanitisation + filter
 *   - 30s tag-list cache
 *   - LiteLLMAdminError on non-2xx
 */

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import {
  getTagDailyActivity,
  listTagsByPrefix,
  __resetActivityClientCacheForTesting,
} from "./activity-client";
import { LiteLLMAdminError } from "./env";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockFetch.mockReset();
  __resetActivityClientCacheForTesting();
  process.env.LITELLM_HOST = "127.0.0.1";
  process.env.LITELLM_PORT = "4000";
  process.env.LITELLM_MASTER_KEY = "sk-test";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function okJson(body: any) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function errResp(status: number, text: string) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(text),
  });
}

describe("getTagDailyActivity", () => {
  it("forwards start_date, end_date and pagination to /tag/daily/activity with Bearer auth", async () => {
    mockFetch.mockReturnValueOnce(okJson({ ok: true }));

    await getTagDailyActivity({
      startDate: "2026-06-01",
      endDate: "2026-06-15",
      page: 1,
      pageSize: 50,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://127.0.0.1:4000/tag/daily/activity?start_date=2026-06-01&end_date=2026-06-15&page=1&page_size=50",
    );
    expect((init as any).method).toBe("GET");
    expect((init as any).headers.Authorization).toBe("Bearer sk-test");
  });

  it("joins tags as CSV and forwards model + exclude_team_tags when provided", async () => {
    mockFetch.mockReturnValueOnce(okJson({}));

    await getTagDailyActivity({
      startDate: "2026-06-01",
      endDate: "2026-06-15",
      tags: ["agent_id_a", "agent_id_b"],
      model: "gpt-4o",
      excludeTeamTags: true,
    });

    const [url] = mockFetch.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.searchParams.get("tags")).toBe("agent_id_a,agent_id_b");
    expect(u.searchParams.get("model")).toBe("gpt-4o");
    expect(u.searchParams.get("exclude_team_tags")).toBe("true");
  });

  it("throws LiteLLMAdminError on non-2xx", async () => {
    mockFetch.mockReturnValueOnce(errResp(502, "upstream gone"));

    await expect(
      getTagDailyActivity({ startDate: "2026-06-01", endDate: "2026-06-15" }),
    ).rejects.toBeInstanceOf(LiteLLMAdminError);
  });

  it("throws LiteLLMAdminError when LITELLM_MASTER_KEY is missing", async () => {
    delete process.env.LITELLM_MASTER_KEY;
    await expect(
      getTagDailyActivity({ startDate: "2026-06-01", endDate: "2026-06-15" }),
    ).rejects.toBeInstanceOf(LiteLLMAdminError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("listTagsByPrefix", () => {
  function mockTagList(names: string[]) {
    mockFetch.mockReturnValueOnce(
      okJson(names.map((name) => ({ name }))),
    );
  }

  it("returns names matching the sanitised prefix", async () => {
    mockTagList([
      "agent_id_abc",
      "agent_id_xyz",
      "user_id_42",
      "agent_name_demo",
    ]);

    const result = await listTagsByPrefix("agent_id_");

    expect(result.sanitisedPrefix).toBe("agent_id_");
    expect(result.names.sort()).toEqual(["agent_id_abc", "agent_id_xyz"]);
  });

  it("sanitises uppercase / unsupported chars to match buildTags pipeline", async () => {
    mockTagList(["project_id_acme-co-", "project_id_other"]);

    // Mimic a caller that hasn't pre-sanitised — uppercase and a dot.
    const result = await listTagsByPrefix("Project_ID_Acme.");

    expect(result.sanitisedPrefix).toBe("project_id_acme-");
    expect(result.names).toEqual(["project_id_acme-co-"]);
  });

  it("returns empty arrays on empty prefix without hitting /tag/list", async () => {
    const result = await listTagsByPrefix("");
    expect(result).toEqual({ sanitisedPrefix: "", names: [] });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("caches /tag/list across consecutive calls within 30s", async () => {
    mockTagList(["agent_id_a", "user_id_1"]);

    await listTagsByPrefix("agent_id_");
    await listTagsByPrefix("user_id_");

    // Only one upstream fetch — the second call hits the cache.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
