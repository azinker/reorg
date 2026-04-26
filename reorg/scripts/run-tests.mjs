import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

function collectTests(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectTests(full, out);
    } else if (entry.endsWith(".test.ts")) {
      out.push(relative(process.cwd(), full));
    }
  }
  return out;
}

const tests = collectTests(join(process.cwd(), "src")).sort();

if (tests.length === 0) {
  console.error("No source tests found under src/**/*.test.ts");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const result = spawnSync(process.execPath, [tsxCli, "--test", ...tests], {
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
