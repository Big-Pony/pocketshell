// Compile-time version, baked from package.json (release.sh bumps it). Bun
// bundles the JSON import into the single-file binary, so the running agent
// always reports the exact version it was built from.
import pkg from "../package.json";

export const AGENT_VERSION: string = pkg.version;
