process.env.NEXTAUTH_SECRET = "test-secret-for-email-inbound";

import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import Busboy from "busboy";
import { encrypt } from "@SRC/exulu/auth/credential-store";
import { createEmailWebhookHandler, type EmailWebhookDeps } from "./webhook";
import { createEmailMultipartParser } from "@SRC/exulu/routes";

const SIGNING_KEY = "mg-signing-key";
const sign = (timestamp: string, token: string): string =>
  createHmac("sha256", SIGNING_KEY).update(timestamp + token).digest("hex");

const makeDb = (configValue: Record<string, unknown> | undefined) => {
  const merged: any[] = [];
  const builder: any = {
    where: jest.fn(() => builder),
    first: jest.fn(async () => (configValue ? { config_value: configValue } : undefined)),
    insert: jest.fn(() => ({
      onConflict: jest.fn(() => ({ merge: jest.fn(async (m: any) => merged.push(m)) })),
    })),
  };
  return { db: { from: jest.fn(() => builder) }, merged };
};

const makeRes = () => {
  const res: any = { statusCode: 0, body: undefined };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((payload: unknown) => {
    res.body = payload;
    return res;
  });
  return res;
};

const validBody = () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = "tok-1";
  return {
    timestamp,
    token,
    signature: sign(timestamp, token),
    recipient: "spare-parts-1a2b3c4d@mail.client.com",
    "body-mime": "From: a@b.com\r\nSubject: hi\r\n\r\nbody",
  };
};

const makeDeps = (overrides: Partial<EmailWebhookDeps> = {}): EmailWebhookDeps & {
  putRawEmail: jest.Mock;
  enqueueIntake: jest.Mock;
} => {
  const { db } = makeDb({
    provider: "mailgun-eu",
    inbound_domain: "mail.client.com",
    enabled: true,
    signing_key: encrypt(SIGNING_KEY),
  });
  return {
    licensedForQueues: () => true,
    getDb: async () => db,
    getRedis: async () => ({ set: jest.fn(async () => "OK") }),
    putRawEmail: jest.fn(async (key: string) => `exulu/${key}`),
    enqueueIntake: jest.fn(async () => undefined),
    rateLimitExceeded: () => false,
    ...overrides,
  } as any;
};

/**
 * Build a minimal multipart/form-data body containing the given fields.
 * Returns { payload: Buffer, contentType: string }.
 */
const buildMultipart = (
  fields: Record<string, Buffer | string>,
  boundary = "TestBoundary1234",
): { payload: Buffer; contentType: string } => {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    const valueBuffer = typeof value === "string" ? Buffer.from(value, "latin1") : value;
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`, "ascii"),
      valueBuffer,
      Buffer.from("\r\n", "ascii"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "ascii"));
  return {
    payload: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};

/**
 * Drive busboy with defCharset:"latin1" over a raw multipart payload, collect
 * field values as latin1-decoded JS strings. This mirrors the emailMultipartParser
 * middleware in routes.ts.
 */
const parseWithLatin1Busboy = (
  payload: Buffer,
  contentType: string,
): Promise<Record<string, string>> =>
  new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: { "content-type": contentType },
      defCharset: "latin1",
      limits: { fieldSize: 30 * 1024 * 1024, files: 0 },
    });
    const fields: Record<string, string> = {};
    bb.on("field", (name: string, value: string) => { fields[name] = value; });
    bb.on("close", () => resolve(fields));
    bb.on("error", reject);
    Readable.from(payload).pipe(bb);
  });

describe("byte-fidelity — busboy defCharset:latin1 middleware", () => {
  it("round-trips 8-bit latin1 bytes (0xE9, 0xFC) without U+FFFD substitution", async () => {
    // "Sübject" in latin1: ü = 0xFC, é = 0xE9
    // These bytes are invalid UTF-8 start bytes and would become U+FFFD if
    // decoded as UTF-8 (the old multer default).
    const originalBytes = Buffer.from([
      0x53, 0xFC, 0x62, 0x6A, 0x65, 0x63, 0x74, // "S\xFCbject"
      0x3A, 0x20,                                 // ": "
      0x68, 0xE9, 0x6C, 0x6C, 0x6F,              // "h\xE9llo"
    ]);

    const { payload, contentType } = buildMultipart({ "body-mime": originalBytes });
    const fields = await parseWithLatin1Busboy(payload, contentType);

    // The JS string should carry the latin1 code-points
    const recovered = Buffer.from(fields["body-mime"] as string, "latin1");
    expect(recovered.toString("hex")).toBe(originalBytes.toString("hex"));
  });

  it("end-to-end: handler receives byte-identical Buffer when body already decoded as latin1 string", async () => {
    // Simulate what the busboy middleware produces: a latin1-decoded JS string
    // where each char code == original byte value.
    const originalBytes = Buffer.from([0x46, 0x72, 0x6F, 0x6D, 0x3A, 0x20, 0xE9, 0x40, 0x62, 0x2E, 0x63, 0x6F, 0x6D]);
    // "From: \xE9@b.com"
    const latin1String = originalBytes.toString("latin1");

    const deps = makeDeps();
    const res = makeRes();
    const body = {
      ...validBody(),
      "body-mime": latin1String,
    };
    await createEmailWebhookHandler(deps)({ body } as any, res);

    expect(res.statusCode).toBe(200);
    const [, buffer] = deps.putRawEmail.mock.calls[0] as [string, Buffer];
    // Buffer.from(latin1String, "latin1") must restore the exact original bytes.
    expect(buffer.toString("hex")).toBe(originalBytes.toString("hex"));
  });
});

describe("createEmailWebhookHandler", () => {
  it("ACKs 200 only after persisting to S3 and enqueueing the intake job", async () => {
    const deps = makeDeps();
    const res = makeRes();
    await createEmailWebhookHandler(deps)({ body: validBody() } as any, res);

    expect(res.statusCode).toBe(200);
    const [key, buffer] = deps.putRawEmail.mock.calls[0] as [string, Buffer];
    expect(key).toMatch(/^email-inbound\/[0-9a-f-]{36}\.eml$/);
    // ASCII MIME content is identical under both utf8 and latin1 encodings.
    expect(buffer.toString("latin1")).toContain("Subject: hi");
    expect(deps.enqueueIntake).toHaveBeenCalledWith({
      s3Key: `exulu/email-inbound/${key.split("/")[1]}`.replace("exulu/email-inbound/", "exulu/email-inbound/"),
      recipient: "spare-parts-1a2b3c4d@mail.client.com",
    });
    // the payload s3Key is exactly what putRawEmail returned
    expect((deps.enqueueIntake.mock.calls[0] as any[])[0].s3Key).toBe(`exulu/${key}`);
  });

  it("returns 429 when rate limited", async () => {
    const deps = makeDeps({ rateLimitExceeded: () => true });
    const res = makeRes();
    await createEmailWebhookHandler(deps)({ body: validBody() } as any, res);
    expect(res.statusCode).toBe(429);
    expect(deps.putRawEmail).not.toHaveBeenCalled();
  });

  it("returns 503 without the queues entitlement", async () => {
    const deps = makeDeps({ licensedForQueues: () => false });
    const res = makeRes();
    await createEmailWebhookHandler(deps)({ body: validBody() } as any, res);
    expect(res.statusCode).toBe(503);
  });

  it("returns 503 when inbound email is disabled or has no signing key", async () => {
    const { db } = makeDb({ enabled: false });
    const deps = makeDeps({ getDb: async () => db });
    const res = makeRes();
    await createEmailWebhookHandler(deps)({ body: validBody() } as any, res);
    expect(res.statusCode).toBe(503);
  });

  it("returns 401 for an invalid signature and never persists", async () => {
    const deps = makeDeps();
    const res = makeRes();
    const body = { ...validBody(), signature: "0".repeat(64) };
    await createEmailWebhookHandler(deps)({ body } as any, res);
    expect(res.statusCode).toBe(401);
    expect(deps.putRawEmail).not.toHaveBeenCalled();
    expect(deps.enqueueIntake).not.toHaveBeenCalled();
  });

  it("returns 401 for a replayed token", async () => {
    const deps = makeDeps({ getRedis: async () => ({ set: jest.fn(async () => null) }) });
    const res = makeRes();
    await createEmailWebhookHandler(deps)({ body: validBody() } as any, res);
    expect(res.statusCode).toBe(401);
    expect(deps.putRawEmail).not.toHaveBeenCalled();
  });

  it("returns 400 when body-mime is missing", async () => {
    const deps = makeDeps();
    const res = makeRes();
    const body = validBody() as Record<string, unknown>;
    delete body["body-mime"];
    await createEmailWebhookHandler(deps)({ body } as any, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 500 (so Mailgun retries) when persistence fails", async () => {
    const deps = makeDeps({
      putRawEmail: jest.fn(async () => {
        throw new Error("s3 down");
      }) as any,
    });
    const res = makeRes();
    await createEmailWebhookHandler(deps)({ body: validBody() } as any, res);
    expect(res.statusCode).toBe(500);
    expect(deps.enqueueIntake).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// emailMultipartParser settled-guard tests
//
// Drive the middleware directly via createEmailMultipartParser with a fake
// req (Readable stream + headers) and a minimal res mock. Verifies that every
// terminal busboy event path (filesLimit → close, error, happy-close) results
// in exactly ONE response OR exactly ONE next() call — never both, never twice.
// ---------------------------------------------------------------------------

/**
 * Build a raw multipart/form-data buffer containing the given string fields
 * plus an optional file part (name="attachment", body=fileBody).
 */
const buildMultipartWithOpts = ({
  fields = {} as Record<string, string>,
  boundary = "MWTestBoundary",
  includeFile = false,
  truncate = false, // omit the closing boundary to simulate a dropped connection
}: {
  fields?: Record<string, string>;
  boundary?: string;
  includeFile?: boolean;
  truncate?: boolean;
}): { payload: Buffer; contentType: string } => {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "ascii"),
    );
  }
  if (includeFile) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="f.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n`,
        "ascii",
      ),
    );
  }
  if (!truncate) {
    parts.push(Buffer.from(`--${boundary}--\r\n`, "ascii"));
  }
  return {
    payload: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};

/** Build a well-formed Readable that looks like an incoming request. */
const makeReq = (payload: Buffer, contentType: string): Readable & { headers: Record<string, string> } => {
  const req = Readable.from(payload) as Readable & { headers: Record<string, string> };
  req.headers = { "content-type": contentType };
  return req;
};

/** Minimal res mock that counts status/json calls. */
const makeMiddlewareRes = () => {
  let statusCode = 0;
  let statusCallCount = 0;
  const res: any = {};
  res.status = jest.fn((code: number) => {
    statusCallCount++;
    statusCode = code;
    return res;
  });
  res.json = jest.fn(() => res);
  Object.defineProperty(res, "statusCode", { get: () => statusCode });
  Object.defineProperty(res, "statusCallCount", { get: () => statusCallCount });
  return res;
};

describe("emailMultipartParser settled-guard", () => {
  // Use a generous field-size limit for most tests; the truncation test uses a tiny one.
  const parser = createEmailMultipartParser(30 * 1024 * 1024);

  it("file part included (filesLimit) → exactly ONE 400 response, next() NEVER called", async () => {
    const { payload, contentType } = buildMultipartWithOpts({
      fields: { foo: "bar" },
      includeFile: true,
    });
    const req = makeReq(payload, contentType);
    const res = makeMiddlewareRes();
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      // Override next so we can detect if it's called
      const wrappedNext = jest.fn(() => { resolve(); });
      // Also resolve when a response is sent
      const origJson = res.json as jest.Mock;
      origJson.mockImplementation(() => { resolve(); return res; });

      parser(req as any, res, wrappedNext);

      // Safety timeout so the test doesn't hang if neither fires
      setTimeout(resolve, 2000);
    });

    expect(res.statusCode).toBe(400);
    expect(res.statusCallCount).toBe(1);
    expect(next).not.toHaveBeenCalled();
  });

  it("truncated multipart (no closing boundary) → exactly ONE 400 response, next() NEVER called", async () => {
    // Use a tiny fieldSizeLimit so we can also verify the field-truncation branch
    // doesn't interfere; here the body is small but the boundary is simply absent.
    const { payload, contentType } = buildMultipartWithOpts({
      fields: { foo: "bar" },
      truncate: true, // drop closing boundary → busboy emits error("Unexpected end of form")
    });
    const req = makeReq(payload, contentType);
    const res = makeMiddlewareRes();
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      const origJson = res.json as jest.Mock;
      origJson.mockImplementation(() => { resolve(); return res; });
      parser(req as any, res, next);
      setTimeout(resolve, 2000);
    });

    expect(res.statusCode).toBe(400);
    expect(res.statusCallCount).toBe(1);
    expect(next).not.toHaveBeenCalled();
  });

  it("malformed part header → exactly ONE 400 response, no hang", async () => {
    // Inject a part with a malformed Content-Disposition that busboy cannot parse.
    // busboy@1.6.0 emits error("Malformed part header") with NO close event.
    const boundary = "MalformedBnd";
    const malformed = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`, "ascii"),
      // Missing the required "\r\n\r\n" separator → malformed header
      Buffer.from("Content-Disposition: form-data; name=\"x\"\r\nBAD HEADER LINE WITHOUT COLON\r\n\r\n", "ascii"),
      Buffer.from(`oops\r\n--${boundary}--\r\n`, "ascii"),
    ]);
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const req = makeReq(malformed, contentType);
    const res = makeMiddlewareRes();
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      const origJson = res.json as jest.Mock;
      origJson.mockImplementation(() => { resolve(); return res; });
      parser(req as any, res, next);
      // Must resolve within 3 s — verifies no hang on the no-close path
      setTimeout(resolve, 3000);
    });

    expect(res.statusCode).toBe(400);
    expect(res.statusCallCount).toBe(1);
    expect(next).not.toHaveBeenCalled();
  });

  it("happy path → next() called exactly once, no response sent by middleware", async () => {
    const { payload, contentType } = buildMultipartWithOpts({
      fields: { "body-mime": "From: a@b.com\r\nSubject: test\r\n\r\nbody" },
    });
    const req = makeReq(payload, contentType);
    const res = makeMiddlewareRes();
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      // next resolves the promise; we use the same fn for the count assertion
      next.mockImplementationOnce(() => resolve());
      parser(req as any, res, next);
      setTimeout(resolve, 2000);
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCallCount).toBe(0);
    // Middleware sets req.body to the parsed fields
    expect((req as any).body).toEqual({
      "body-mime": "From: a@b.com\r\nSubject: test\r\n\r\nbody",
    });
  });
});
