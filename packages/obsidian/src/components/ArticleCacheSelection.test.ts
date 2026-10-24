import { describe, expect, it } from "vitest";
import { selectCurrentArticleCacheJob } from "./ArticleCacheSelection";

const jobs = [
  { id: "forest", path: "Reading/The Forest and Its Partisans.md" },
  { id: "leash", path: "Reading/Whose Leash.md" },
];

describe("article cache management selection", () => {
  it("selects the currently open article instead of the first saved job", () => {
    expect(
      selectCurrentArticleCacheJob(jobs, "Reading/Whose Leash.md")?.id,
    ).toBe("leash");
  });
  it("does not select an unrelated article when the current note lacks a job", () => {
    expect(
      selectCurrentArticleCacheJob(jobs, "Reading/New Article.md"),
    ).toBeUndefined();
  });
  it("requires explicit selection when no note path is available", () => {
    expect(selectCurrentArticleCacheJob(jobs, undefined)).toBeUndefined();
  });
  it("does not arbitrarily pick between multiple jobs for the same article", () => {
    expect(
      selectCurrentArticleCacheJob(
        [...jobs, { id: "leash-selection", path: jobs[1].path }],
        jobs[1].path,
      ),
    ).toBeUndefined();
  });
});
