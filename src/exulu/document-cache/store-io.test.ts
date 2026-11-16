const send = jest.fn();
jest.mock("@aws-sdk/client-s3", () => {
  class Cmd {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  }
  const cls = (name: string) => ({ [name]: class extends Cmd {} })[name];
  return {
    S3Client: class {
      send = send;
    },
    GetObjectCommand: cls("GetObjectCommand"),
    HeadObjectCommand: cls("HeadObjectCommand"),
    PutObjectCommand: cls("PutObjectCommand"),
    AbortMultipartUploadCommand: cls("A"),
    CompleteMultipartUploadCommand: cls("B"),
    CopyObjectCommand: cls("C"),
    CreateMultipartUploadCommand: cls("D"),
    ListPartsCommand: cls("E"),
    UploadPartCommand: cls("F"),
    ListObjectsV2Command: cls("G"),
    DeleteObjectCommand: cls("H"),
  };
});
jest.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: jest.fn() }));
jest.mock("@aws-sdk/client-sts", () => ({ STSClient: class {}, GetFederationTokenCommand: class {} }));
jest.mock("../../auth/auth", () => ({ authentication: jest.fn() }));
jest.mock("../../auth/get-token", () => ({ getToken: jest.fn() }));
jest.mock("../../postgres/client", () => ({ postgresClient: jest.fn() }));

import { createStoreIo } from "./store";
import { contentKey, pointerKey } from "./keys";

const config = (s3prefix?: string) =>
  ({ fileUploads: { s3Bucket: "bkt", s3prefix, s3region: "r", s3key: "k", s3secret: "s" } }) as never;

beforeEach(() => send.mockReset());

describe.each([[undefined], ["pre"]])("createStoreIo with s3prefix %p", (prefix) => {
  it("uses the derived keys exactly: no user_ segment, no second prefix", async () => {
    const io = createStoreIo(config(prefix));
    const text = contentKey("a".repeat(64), "fp1", prefix);
    const ptr = pointerKey("bkt", "x/y.pdf", prefix);
    send.mockResolvedValue({});
    await io.putText(text, "body", { "exulu-extractor": "pdftotext@1" });
    await io.putText(ptr, "{}", {});
    send.mockResolvedValueOnce({ ETag: '"e"' });
    await io.head("pre/user_1/a.pdf");
    send.mockResolvedValueOnce({
      Body: { transformToString: async () => "t" },
      LastModified: new Date("2026-01-01"),
    });
    await io.getText(text);
    const inputs = send.mock.calls.map(([c]) => c.input);
    expect(inputs[0]).toMatchObject({
      Bucket: "bkt",
      Key: text,
      Metadata: { "exulu-extractor": "pdftotext@1" },
      ContentType: "text/markdown; charset=utf-8",
    });
    expect(inputs[1]).toMatchObject({ Key: ptr, ContentType: "application/json" });
    expect(inputs[2]).toMatchObject({ Bucket: "bkt", Key: "pre/user_1/a.pdf" });
    expect(inputs[3]).toMatchObject({ Key: text });
    expect(text).toBe(prefix ? `pre/derived/content/${"a".repeat(64)}/fp1.md` : `derived/content/${"a".repeat(64)}/fp1.md`);
    expect(inputs[0].Key).not.toMatch(/user_/);
  });

  it("returns null for a missing object instead of throwing", async () => {
    const io = createStoreIo(config(prefix));
    send.mockRejectedValue({ name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    await expect(io.getText("derived/x")).resolves.toBeNull();
    await expect(io.head("derived/x")).resolves.toBeNull();
  });
});
