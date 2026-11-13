import { resolve } from "node:path";

// Capture the running entrypoint and wrapper-adjusted environment, not a later PATH lookup.
export function capturePiCommand(host = process) {
  return {
    executable: host.execPath,
    args: [...host.execArgv, ...(host.argv[1] ? [resolve(host.argv[1])] : [])],
    env: { ...host.env },
  };
}
