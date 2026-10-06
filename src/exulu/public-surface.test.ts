import { isPublicSurface, PUBLIC_SURFACE_HEADER, treatAsGuest } from "./public-surface";

const req = (headers: Record<string, unknown>) => ({ headers });

describe("isPublicSurface", () => {
  it("is true for the values the proxy sends", () => {
    expect(isPublicSurface(req({ [PUBLIC_SURFACE_HEADER]: "1" }))).toBe(true);
    expect(isPublicSurface(req({ [PUBLIC_SURFACE_HEADER]: "true" }))).toBe(true);
  });

  // Node lower-cases incoming header names, and repeated headers arrive as an
  // array — a caller sending it twice must not slip past the check.
  it("reads the first value when the header repeats", () => {
    expect(isPublicSurface(req({ [PUBLIC_SURFACE_HEADER]: ["1", "0"] }))).toBe(true);
  });

  it("is false for every other request", () => {
    expect(isPublicSurface(req({}))).toBe(false);
    expect(isPublicSurface(req({ [PUBLIC_SURFACE_HEADER]: "0" }))).toBe(false);
    expect(isPublicSurface(req({ [PUBLIC_SURFACE_HEADER]: "" }))).toBe(false);
    expect(isPublicSurface(undefined)).toBe(false);
    expect(isPublicSurface({} as never)).toBe(false);
  });
});

describe("treatAsGuest", () => {
  const user = { id: 7 };
  const publicReq = req({ [PUBLIC_SURFACE_HEADER]: "1" });

  it("treats a signed-in visitor on the public surface as a guest", () => {
    // The bug this fixes: the page rendered in guest mode while the data did not.
    expect(treatAsGuest(publicReq, user)).toBe(true);
  });

  it("still treats anyone anonymous as a guest", () => {
    expect(treatAsGuest(req({}), null)).toBe(true);
    expect(treatAsGuest(req({}), undefined)).toBe(true);
    expect(treatAsGuest(req({}), {})).toBe(true);
  });

  // The regular chat must not change: a signed-in user there keeps user
  // treatment even for an agent that is also published to guests.
  it("leaves a signed-in user on the normal surface alone", () => {
    expect(treatAsGuest(req({}), user)).toBe(false);
  });
});
