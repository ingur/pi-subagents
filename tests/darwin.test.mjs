import assert from "node:assert/strict";
import test from "node:test";
import { parseProcessTable } from "../src/lib/process/darwin.mjs";

test("macOS ps rows parse and odd rows are skipped", () => {
  const output = [
    "    1     0     1 Ss   Sun Nov 15 08:00:01 2026",
    "  412     1   412 S    Sun Nov  1 08:00:05 2026",
    " 1234   412  1234 S+   Sun Nov 15 10:12:01 2026",
    " 1300  1234  1234 Z    Sun Nov 15 10:12:09 2026",
    " 1301  1234  1234 ?    Sun Nov 15 10:12:09 2026",
    " 1302  1234  1234 R",
    "",
  ].join("\n");
  assert.deepEqual(parseProcessTable(output), new Map([
    [1, { pid: 1, parent: 0, group: 1, state: "S", start: "Sun Nov 15 08:00:01 2026" }],
    [412, { pid: 412, parent: 1, group: 412, state: "S", start: "Sun Nov 1 08:00:05 2026" }],
    [1234, { pid: 1234, parent: 412, group: 1234, state: "S", start: "Sun Nov 15 10:12:01 2026" }],
    [1300, { pid: 1300, parent: 1234, group: 1234, state: "Z", start: "Sun Nov 15 10:12:09 2026" }],
  ]));
});
