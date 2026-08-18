import { detailTitle, filetypeForPath, itemSummary, safeText, short } from "./presentation";

test("presentation helpers sanitize terminal text and classify every supported view", () => {
  expect(safeText(undefined, "fallback")).toBe("fallback");
  expect(safeText("a\u0000b\nc")).toBe("a b c");
  expect(short("abcdefghijklmnop", 4)).toBe("abcd");
  expect(short(undefined)).toBe("—");
  expect(["overview", "diff", "evidence", "policy", "run", "help", "repositories", "runs", "releases"].map((view) => detailTitle(view as Parameters<typeof detailTitle>[0]))).toEqual(["Overview", "Diff", "Evidence trace", "Policy", "Verification run", "Help", "Repositories", "Runs", "Releases"]);
  expect(filetypeForPath("src/app.tsx")).toBe("tsx");
  expect(filetypeForPath("README.MD")).toBe("markdown");
  expect(filetypeForPath("src/unknown.xyz")).toBeUndefined();
  expect(itemSummary(undefined)).toContain("Select a work item");
  expect(itemSummary({ id: "one", group: "NEEDS ATTENTION", status: "fail", glyph: "!", severity: "HIGH", repository: "repo", change: "Change", timestamp: "now", title: "Broken", file: "src/a.ts", line: 4 })).toBe("! Broken · src/a.ts:4");
});
