/**
 * Extension-host smoke test runner.
 *
 * Downloads a VS Code instance (cached), installs the locally-packaged
 * extension, and runs the Mocha test suite inside the Extension Development
 * Host. No manual install required.
 *
 * Usage:
 *   npm run test:extension
 *
 * Requires QMTCODE_BIN env var to point to the qmtcode binary.
 * Optionally set QMTCODE_CONFIG to a TOML config path.
 */

import { runTests, downloadAndUnzipVSCode } from "@vscode/test-electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");

async function main() {
  const vscodeExecutablePath = await downloadAndUnzipVSCode("stable");

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: projectRoot,
    extensionTestsPath: resolve(__dirname, "suite.mjs"),
    launchArgs: [
      "--disable-extensions",
      "--disable-gpu",
      resolve(projectRoot), // open workspace
    ],
    extensionTestsEnv: {
      QMTCODE_BIN: process.env.QMTCODE_BIN ?? "",
      QMTCODE_CONFIG: process.env.QMTCODE_CONFIG ?? "",
    },
  });
}

main().catch((err) => {
  console.error("Extension host tests failed:", err);
  process.exit(1);
});
