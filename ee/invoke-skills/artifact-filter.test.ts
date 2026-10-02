import { isIgnoredArtifactPath, capArtifacts, needsDownload } from "./artifact-filter";

describe("isIgnoredArtifactPath — dependency and cache trees are not session artifacts", () => {
  it("ignores virtualenvs, node_modules, caches and VCS metadata at any depth", () => {
    for (const p of [
      "venv/pyvenv.cfg",
      "venv/lib/python3.11/site-packages/docx/api.py",
      ".venv/bin/python",
      "node_modules/lodash/index.js",
      "scripts/__pycache__/create.cpython-311.pyc",
      ".cache/pip/http/x",
      ".git/objects/ab/cd",
      "project/env/lib/python3.11/site-packages/x.py",
    ]) {
      expect(isIgnoredArtifactPath(p)).toBe(true);
    }
  });

  it("keeps the files the agent actually produces", () => {
    for (const p of ["Besprechungsprotokoll.docx", "create_minutes.py", "out/report.pdf", "Angebot/Angebot_107426.docx"]) {
      expect(isIgnoredArtifactPath(p)).toBe(false);
    }
  });
});

describe("capArtifacts — a bash command that touches thousands of files must not flood the tool result", () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ relativePath: `out/file_${i}.txt`, url: `https://s3/${i}` }));

  it("returns everything below the cap untouched", () => {
    const { kept, omitted } = capArtifacts(many.slice(0, 10), 50);
    expect(kept).toHaveLength(10);
    expect(omitted).toBe(0);
  });

  it("keeps only the first N and reports how many were omitted", () => {
    const { kept, omitted } = capArtifacts(many, 50);
    expect(kept).toHaveLength(50);
    expect(kept[0]!.relativePath).toBe("out/file_0.txt");
    expect(omitted).toBe(200);
  });
});

describe("needsDownload — resyncing S3 session files into a live sandbox", () => {
  it("downloads when the local file is missing or differs in size, skips identical files", () => {
    expect(needsDownload(undefined, 100)).toBe(true);
    expect(needsDownload(99, 100)).toBe(true);
    expect(needsDownload(100, 100)).toBe(false);
  });
});
