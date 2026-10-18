import { expect, it } from "vitest";
import { validateReleaseMetadata } from "../../../scripts/release-metadata.mjs";

const input = {
  tag: "v1.2.0",
  version: "1.2.0",
  changelog:
    "# Changelog\n\n## [1.2.0] - 2026-10-18\n\n### Improvements\n\n- Recording\n\n## [1.1.1] - 2026-10-15\n\n- Earlier changes\n",
};

it("extracts only the dated release matching the app version", () => {
  expect(validateReleaseMetadata(input)).toEqual({
    version: "1.2.0",
    date: "2026-10-18",
    changes: "### Improvements\n\n- Recording",
  });
  expect(
    validateReleaseMetadata({
      ...input,
      changelog: input.changelog.replaceAll("\n", "\r\n"),
    }),
  ).toEqual(validateReleaseMetadata(input));
});

it.each([
  "Unreleased",
  "2026-02-30",
  "2026-13-01",
  "2026-2-01",
  "2026-10-18 draft",
])(
  "rejects an unpublished or invalid release date: %s",
  (date) => {
    expect(() =>
      validateReleaseMetadata({
        ...input,
        changelog: input.changelog.replace(
          "2026-10-18",
          date,
        ),
      }),
    ).toThrow("dated release notes");
  },
);

it("rejects mismatched tags, missing sections, and empty release notes", () => {
  for (const changes of [
    { tag: "v1.1.1" },
    { tag: "v1.2.0-rc.1" },
    { tag: "v01.2.0" },
    { version: "1.1.1" },
    {
      changelog:
        "## [1.1.1] - 2026-10-15\n\nEarlier changes",
    },
    { changelog: "## [1.2.0] - 2026-10-18\n\n" },
  ]) {
    expect(() =>
      validateReleaseMetadata({ ...input, ...changes }),
    ).toThrow();
  }
});
