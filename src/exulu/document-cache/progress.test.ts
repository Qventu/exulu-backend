import { isInterimToolStatus, throttleProgress } from "./progress";

describe("throttleProgress", () => {
  it("passes the first event, drops those within the interval, lets a final one through", () => {
    let t = 0;
    const seen: number[] = [];
    const fn = throttleProgress((p) => seen.push(p.pagesDone), 1000, () => t);
    fn({ phase: "ocr", pagesDone: 1, pagesTotal: 4 });
    t = 400;
    fn({ phase: "ocr", pagesDone: 2, pagesTotal: 4 });
    t = 800;
    fn({ phase: "ocr", pagesDone: 3, pagesTotal: 4 });
    t = 900;
    fn({ phase: "ocr", pagesDone: 4, pagesTotal: 4 });
    expect(seen).toEqual([1, 4]);
  });

  it("passes an event once the interval has elapsed", () => {
    let t = 0;
    const seen: number[] = [];
    const fn = throttleProgress((p) => seen.push(p.pagesDone), 1000, () => t);
    fn({ phase: "ocr", pagesDone: 1, pagesTotal: 9 });
    t = 1000;
    fn({ phase: "ocr", pagesDone: 2, pagesTotal: 9 });
    expect(seen).toEqual([1, 2]);
  });
});

describe("throttleProgress across phases", () => {
  it("lets the first event of a new phase through even inside the interval", () => {
    let t = 0;
    const seen: string[] = [];
    const fn = throttleProgress((p) => seen.push(`${p.phase}:${p.pagesDone}`), 1000, () => t);
    fn({ phase: "ocr", pagesDone: 10, pagesTotal: 10 });
    t = 100;
    fn({ phase: "vision", pagesDone: 1, pagesTotal: 10 });
    t = 200;
    fn({ phase: "vision", pagesDone: 2, pagesTotal: 10 });
    expect(seen).toEqual(["ocr:10", "vision:1"]);
  });
});

describe("isInterimToolStatus", () => {
  it("recognises only reading status objects", () => {
    expect(isInterimToolStatus({ status: "reading", filename: "a.pdf", phase: "ocr", pagesDone: 1, pagesTotal: 2 })).toBe(true);
    expect(isInterimToolStatus({ content: "x" })).toBe(false);
    expect(isInterimToolStatus(undefined)).toBe(false);
    expect(isInterimToolStatus(null)).toBe(false);
    expect(isInterimToolStatus("reading")).toBe(false);
  });
});
