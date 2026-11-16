jest.mock("../uppy/index.ts", () => ({
  copyS3Object: jest.fn(),
  getS3ObjectMetadataStrict: jest.fn(),
  getS3ObjectSize: jest.fn(),
  listS3ObjectsByPrefix: jest.fn(),
}));
import { getS3ObjectMetadataStrict } from "../uppy/index.ts";
import { getOriginResolver } from "./project-files-s3.ts";

const head = getS3ObjectMetadataStrict as jest.Mock;
const file = { key: "projects/p1/files/a.pdf", lastModified: new Date("2026-11-01T10:00:00Z") };

beforeEach(() => head.mockReset());

it("does not cache a transient HEAD failure as 'user'", async () => {
  const config = { fileUploads: {} } as never;
  const resolve = getOriginResolver(config);
  head.mockRejectedValueOnce(new Error("socket hang up"));
  expect(await resolve(file)).toBe("user");
  head.mockResolvedValueOnce({ "exulu-origin": "agent" });
  expect(await resolve(file)).toBe("agent");
  // Now cached: no third HEAD.
  expect(await resolve(file)).toBe("agent");
  expect(head).toHaveBeenCalledTimes(2);
});

it("caches a genuinely missing object (undefined metadata) as 'user'", async () => {
  const resolve = getOriginResolver({ fileUploads: {} } as never);
  head.mockResolvedValue(undefined);
  expect(await resolve(file)).toBe("user");
  expect(await resolve(file)).toBe("user");
  expect(head).toHaveBeenCalledTimes(1);
});
