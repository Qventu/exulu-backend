# UAT — Tool-call audit layer

**Feature:** general audit layer + tool-call S3 logging (spec `2026-07-28-tool-call-audit-layer-design.md`). Backend-only, no UI. Merged to local `develop` (merge `a9eb594`), off by default.

**What UAT must prove that unit tests couldn't** (unit tests mocked S3/DB): real S3/MinIO writes with the MinIO-safe checksum settings; the real lifecycle rule landing on a real bucket without clobbering existing rules; the actual chokepoint firing during a real agent run; fail-open spool→drain against a genuinely-unreachable S3; and — most important — **no secret material in any object that actually reaches S3**.

## Environment

Pick an S3 target. **MinIO is recommended** for local UAT — it's free, fast, and specifically exercises the S3-compatible path (`s3endpoint` + `forcePathStyle` + the `WHEN_REQUIRED` checksum settings, which are the parts most likely to break against non-AWS stores).

```bash
# MinIO via docker
docker run -d --name exulu-audit-minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data --console-address ":9001"
# create a dedicated audit bucket (via the console at :9001, or mc):
#   mc alias set local http://localhost:9000 minioadmin minioadmin
#   mc mb local/exulu-audit
```

Audit config used throughout (dedicated bucket → lifecycle is auto-managed):

```ts
audit: {
  enabled: true,
  retentionDays: 7,
  s3: {
    s3region: "us-east-1",
    s3key: "minioadmin",
    s3secret: "minioadmin",
    s3Bucket: "exulu-audit",
    s3endpoint: "http://localhost:9000",   // omit for real AWS
    s3prefix: "audit/",
  },
  flush: { maxRecords: 5, maxIntervalMs: 2000 },  // small values so UAT flushes fast
}
```

Inspect S3 with `mc`:
```bash
mc ls -r local/exulu-audit/audit/          # list objects (date/hour partitioned)
mc cat local/exulu-audit/audit/dt=.../...ndjson   # read a record
```

## Two tiers

- **Tier A — automated pipeline check against MinIO (fast, covers the security gates).** A **gated jest integration test** (copy the code below to `src/exulu/audit/pipeline.uat.integration.test.ts`). It's `describe.skip` by default and only runs when `EXULU_AUDIT_UAT=true`, exactly like the existing `s3-writer.integration.test.ts`. It drives the real pipeline — `initAudit` → `recordToolCall` for plain / secret-laden / auth-short-circuit / built-in / volume calls → `flush` → reads the objects back from MinIO and asserts shape, key layout, **zero secrets**, the retention rule (preserving a pre-seeded rule), and fail-open spool→self-heal. This exercises emitter → describe → redact → sink → s3-writer → real S3 + lifecycle without needing a model/agent. Covers TC2, TC4, TC5, TC6, TC7, TC9, TC11.

  Run it (skipped otherwise):
  ```bash
  EXULU_AUDIT_UAT=true npx jest src/exulu/audit/pipeline.uat.integration.test.ts --runInBand
  # optional overrides: EXULU_AUDIT_UAT_ENDPOINT / _BUCKET / _KEY / _SECRET
  ```

  ```ts
  // src/exulu/audit/pipeline.uat.integration.test.ts
  // Tier A audit UAT against MinIO. SKIPPED unless EXULU_AUDIT_UAT=true.
  const enabled = process.env.EXULU_AUDIT_UAT === "true";
  const describeIf = enabled ? describe : describe.skip;

  import {
    S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectsCommand,
    PutBucketLifecycleConfigurationCommand, GetBucketLifecycleConfigurationCommand,
  } from "@aws-sdk/client-s3";
  import os from "os";
  import path from "path";
  import { promises as fs } from "fs";
  import { initAudit, __resetAuditForTests } from "@SRC/exulu/audit/logger";

  const ENDPOINT = process.env.EXULU_AUDIT_UAT_ENDPOINT ?? "http://localhost:9000";
  const KEY = process.env.EXULU_AUDIT_UAT_KEY ?? "minioadmin";
  const SECRET = process.env.EXULU_AUDIT_UAT_SECRET ?? "minioadmin";
  const BUCKET = process.env.EXULU_AUDIT_UAT_BUCKET ?? "exulu-audit";
  const PREFIX = "audit/";
  const SECRETS = ["SUPER_SECRET_TOKEN", "hunter2", "sk-live-DEADBEEF", "SHOULD_NOT_APPEAR"];

  const baseS3 = { s3region: "us-east-1", s3key: KEY, s3secret: SECRET, s3Bucket: BUCKET, s3endpoint: ENDPOINT, s3prefix: PREFIX };
  const cfg = (over: any = {}) => ({ audit: { enabled: true, retentionDays: 7, s3: baseS3, flush: { maxRecords: 100, maxIntervalMs: 60000 }, ...over } });

  const s3 = new S3Client({
    region: "us-east-1", endpoint: ENDPOINT, forcePathStyle: true,
    credentials: { accessKeyId: KEY, secretAccessKey: SECRET },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
  });

  const wipe = async () => {
    const l = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX }));
    const keys = (l.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys } }));
  };
  const listKeys = async () => ((await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX }))).Contents ?? []).map((o) => o.Key!);
  const readAll = async () => {
    const rows: any[] = [];
    for (const k of await listKeys()) {
      const body = await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: k }))).Body!.transformToString();
      for (const line of body.split("\n").filter(Boolean)) rows.push(JSON.parse(line));
    }
    return rows;
  };
  const ctx = (over: any = {}) => ({
    durationMs: 5, agent: { id: "ag_support", name: "Support" },
    tool: { id: "my_tool", name: "my_tool", category: "default" }, builtin: false,
    user: { id: 7, email: "u@x.com", role: { id: 3 } }, projectId: "proj_1",
    sessionID: "sess_uat", toolCallId: "tc_1", input: { query: "hello" },
    output: { result: "done" }, status: "ok", ...over,
  });

  describeIf("audit layer UAT (MinIO)", () => {
    beforeAll(async () => { process.env.NEXTAUTH_SECRET ??= "uat-secret"; await wipe(); });
    afterEach(() => __resetAuditForTests());
    afterAll(async () => { await wipe(); });

    it("TC7 applies retention lifecycle, preserving unrelated rules", async () => {
      await s3.send(new PutBucketLifecycleConfigurationCommand({
        Bucket: BUCKET,
        LifecycleConfiguration: { Rules: [{ ID: "unrelated-uat", Status: "Enabled", Filter: { Prefix: "other/" }, Expiration: { Days: 99 } }] },
      }));
      await initAudit(cfg(), { builtinToolIds: new Set() });
      const lc = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }));
      expect((lc.Rules ?? []).map((r: any) => r.ID)).toContain("unrelated-uat");
      expect((lc.Rules ?? []).find((r: any) => r.ID === "exulu-audit-retention")?.Expiration?.Days).toBe(7);
    }, 30000);

    it("TC2/TC4/TC5/TC6/TC11 records land redacted with the right shape", async () => {
      await wipe();
      const logger = await initAudit(cfg(), { builtinToolIds: new Set() });
      await logger.recordToolCall(ctx());                                          // TC2 plain
      await logger.recordToolCall(ctx({ input: { q: "x", password: "hunter2", apiKey: "sk-live-DEADBEEF", oauth: { accessToken: "SUPER_SECRET_TOKEN" } } })); // TC4
      await logger.recordToolCall(ctx({                                            // TC5 auth short-circuit (user_credentials → no Postgres)
        tool: { id: "moco_tool", name: "moco_tool", authentication: { authType: "user_credentials", provider: "moco", fields: [] } },
        output: { credentialRequest: { provider: "moco", nonce: "SHOULD_NOT_APPEAR", submitUrl: "https://x/s?state=SHOULD_NOT_APPEAR" } },
      }));
      await logger.recordToolCall(ctx({ tool: { id: "todo", name: "todo" }, builtin: true })); // TC11
      for (let i = 0; i < 8; i++) await logger.recordToolCall(ctx({ toolCallId: "v" + i })); // TC6 volume
      await logger.flush();

      const rows = await readAll();
      const blob = JSON.stringify(rows);
      for (const s of SECRETS) expect(blob).not.toContain(s);                       // TC4 hard security gate
      expect(rows.some((r) => r.type === "tool.call" && r.status === "ok" && r.agent?.id === "ag_support" &&
        r.target?.id === "my_tool" && r.actor?.userId === "7" && r.actor?.projectId === "proj_1" &&
        typeof r.durationMs === "number" && r.data?.input && r.data?.output)).toBe(true); // TC2
      const auth = rows.find((r) => r.target?.id === "moco_tool");                  // TC5
      expect(auth?.status).toBe("auth_required");
      expect(auth?.data?.output).toBeUndefined();
      expect(auth?.credential?.provider).toBe("moco");
      expect(rows.some((r) => r.target?.id === "todo" && r.target?.builtin === true)).toBe(true); // TC11
      for (const k of await listKeys()) expect(k).toMatch(/^audit\/dt=\d{4}-\d{2}-\d{2}\/\d{2}\/\d+-[0-9a-f-]+\.ndjson$/); // TC6
    }, 30000);

    it("TC9 fail-open spools on dead S3, then self-heals on recovery", async () => {
      const spoolDir = path.join(os.tmpdir(), "exulu-audit-uat-spool");
      await fs.rm(spoolDir, { recursive: true, force: true });
      const dead = await initAudit(cfg({ s3: { ...baseS3, s3endpoint: "http://127.0.0.1:9" }, spoolDir, manageLifecycle: false }), { builtinToolIds: new Set() });
      await expect(dead.recordToolCall(ctx())).resolves.toBeUndefined();
      await expect(dead.flush()).resolves.toBeUndefined();                          // fail-open: never throws
      expect((await fs.readdir(spoolDir).catch(() => [])).some((f) => f.endsWith(".ndjson"))).toBe(true);
      __resetAuditForTests();
      await wipe();
      const heal = await initAudit(cfg({ spoolDir, manageLifecycle: false }), { builtinToolIds: new Set() }); // good endpoint, same spool dir
      await heal.recordToolCall(ctx({ toolCallId: "heal" }));
      await heal.flush();                                                           // writes new batch + drains the spool
      expect((await fs.readdir(spoolDir).catch(() => [])).filter((f) => f.endsWith(".ndjson")).length).toBe(0);
      expect((await readAll()).length).toBeGreaterThanOrEqual(1);
    }, 30000);
  });
  ```

- **Tier B — full app E2E (proves the real chokepoint).** Enable `audit` in your actual Exulu app config, boot it, and have an agent call a tool for real (a normal chat that triggers a tool). Confirm an object lands in S3 for that call. This is the **only** tier that exercises the generator wrapper in `convert-exulu-tools-to-ai-sdk-tools.ts`, and the natural place for **TC3** (a real OAuth tool with a Postgres-stored token): make the agent call it, then confirm the record carries `credential.scopes`/`expiresAt` but **no access/refresh token**. TC3 needs a live Postgres + a seeded token (`credentialStore.upsert({ provider, userId, authType:"oauth", data:{ accessToken, refreshToken, tokenType, scopes:"a b", expiresAt:"<iso>" } })`), which is why it lives here rather than in Tier A. Also verify here: **TC1** (boot with no `audit` config → no objects, no overhead), **TC8** (shared-bucket lifecycle not auto-applied — rule only logged), **TC10** (`failureMode:"closed"` + S3 down → tool call blocks), **TC12** (SIGTERM flushes the buffer), **TC13** (bad config throws at `create()`).

## Test cases

Priorities: P1 = must pass to accept; P2 = should pass; P3 = edge.

| # | Pri | Case | Setup | Steps | Expected |
|---|-----|------|-------|-------|----------|
| TC1 | P1 | **Off by default** | No `audit` in config | Boot the app / run any tool call | No objects under `audit/`; no S3 client built; no `SIGTERM` handler added; zero behavior change. |
| TC2 | P1 | **Happy path — tool logged** | audit enabled | Agent calls a plain tool (Tier B) or `recordToolCall` for a plain tool (Tier A) | One NDJSON line in S3 with `type:"tool.call"`, `agent{id,name}`, `tool{id,name,category,builtin:false}`, `actor{userId,email,roleId,projectId}`, `context{sessionId,toolCallId}`, `data.input`, `data.output`, `status:"ok"`, `durationMs`. |
| TC3 | P1 | **Credential identity, never secret** | An oauth tool with a stored token | Call it | Record has `credential{provider,authType:"oauth",account,scopes,expiresAt}` and **grep the object for the real access token / refresh token → 0 hits**. |
| TC4 | P1 | **Redaction safety-net** | Tool whose input contains `{ password, apiKey, token, oauth:{accessToken} }` | Call it | None of those values appear in the S3 object; object-valued secret keys show `"[redacted]"`, primitive secret keys dropped. |
| TC5 | P1 | **Auth short-circuit → no payload** | An authenticated tool with **no** stored credential for the user | Call it | Record `status:"auth_required"`, `credential.provider` present, **no** `data.output`, and no nonce / authorization URL anywhere in the object. |
| TC6 | P2 | **Batching + key layout** | flush.maxRecords=5 | Fire 12 tool calls | Objects keyed `audit/dt=YYYY-MM-DD/HH/<epochMs>-<uuid>.ndjson`; ~3 objects; each is valid newline-delimited JSON. |
| TC7 | P1 | **Retention lifecycle** | Dedicated bucket, retentionDays=7; pre-seed one unrelated lifecycle rule | Boot with audit enabled | Bucket has a rule `ID=exulu-audit-retention`, `Expiration.Days=7`, `Filter.Prefix=audit/` — **and the pre-seeded rule still present** (`mc ilm ls local/exulu-audit`). |
| TC8 | P2 | **Shared-bucket lifecycle NOT auto-applied** | Omit `audit.s3` (fall back to `fileUploads`), don't set `manageLifecycle` | Boot | No lifecycle rule auto-added to the shared bucket; the exact rule JSON is logged at startup for manual application. |
| TC9 | P1 | **Fail-open + spool + self-heal** | Point `audit.s3.s3endpoint` at a dead port (e.g. `:9999`) | Fire a tool call | Tool call still succeeds; a warning is logged; a spool file appears under the spool dir (default `os.tmpdir()/exulu-audit-spool`). Then fix the endpoint and fire another call → the spooled record drains into S3 and the spool file is removed. |
| TC10 | P2 | **Fail-closed blocks** | `failureMode:"closed"`, S3 dead | Fire a tool call | The tool call errors/blocks (durable write enforced) — contrast with TC9. |
| TC11 | P2 | **Scope filter** | `sources.toolCalls.exclude:["<tool id>"]` | Call the excluded tool and a normal tool | Excluded tool produces no record; normal tool does. Built-in tools (todo/question/perplexity/email) show `builtin:true`. |
| TC12 | P2 | **Graceful shutdown flush** | Buffer a few records below maxRecords | Send `SIGTERM` to the process | Buffered records are flushed to S3 before exit (no loss). |
| TC13 | P3 | **Config validation** | `enabled:true` with no `s3` and no `fileUploads`; then `retentionDays:0` | Boot | `create()` throws a clear error mentioning the S3 target / `retentionDays`. |

## Acceptance verdict

**PASS** requires all P1 (TC1, TC2, TC3, TC4, TC5, TC7, TC9) green. TC3/TC4/TC5 are the security gates — any secret found in an S3 object is an automatic **FAIL**. Record results in `2026-07-28-tool-call-audit-layer-uat-results.md`.
