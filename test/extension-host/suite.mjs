/**
 * Extension-host test suite — runs inside the VS Code Extension Development
 * Host process. Tests verify activation, command registration, and basic
 * extension wiring without manual interaction.
 *
 * Uses the built-in Node.js test runner (node:test + node:assert) so we
 * don't need Mocha/vitest inside the extension host.
 */

import * as assert from "node:assert/strict";

/** @param {typeof import("vscode")} vscode */
export async function run() {
  // Dynamically import vscode (available inside the extension host)
  const vscode = await import("vscode");

  const results = { passed: 0, failed: 0, errors: [] };

  async function test(name, fn) {
    try {
      await fn();
      results.passed++;
      console.log(`  PASS: ${name}`);
    } catch (err) {
      results.failed++;
      results.errors.push({ name, error: err });
      console.error(`  FAIL: ${name}`);
      console.error(`    ${err.message ?? err}`);
    }
  }

  console.log("\n=== Extension Host Smoke Tests ===\n");

  // ── Activation ──

  await test("extension should be present", () => {
    const ext = vscode.extensions.getExtension("querymt.vscode-querymt");
    assert.ok(ext, "Extension not found");
  });

  await test("extension should activate", async () => {
    const ext = vscode.extensions.getExtension("querymt.vscode-querymt");
    assert.ok(ext, "Extension not found");
    await ext.activate();
    assert.ok(ext.isActive, "Extension did not activate");
  });

  // ── Commands ──

  await test("querymt.restart command should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("querymt.restart"),
      "querymt.restart not registered",
    );
  });

  await test("querymt.showLogs command should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("querymt.showLogs"),
      "querymt.showLogs not registered",
    );
  });

  await test("querymt.manageProvider command should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("querymt.manageProvider"),
      "querymt.manageProvider not registered",
    );
  });

  await test("querymt.statusBarMenu command should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("querymt.statusBarMenu"),
      "querymt.statusBarMenu not registered",
    );
  });

  // ── Configuration ──

  await test("extension settings should have defaults", () => {
    const config = vscode.workspace.getConfiguration("querymt");
    assert.equal(config.get("autoStart"), true);
    assert.equal(config.get("maxRestarts"), 5);
    assert.equal(config.get("defaultProvider"), "anthropic");
    assert.equal(config.get("defaultModel"), "claude-sonnet-4-20250514");
  });

  // ── Summary ──

  console.log(
    `\n=== ${results.passed} passed, ${results.failed} failed ===\n`,
  );

  if (results.failed > 0) {
    for (const { name, error } of results.errors) {
      console.error(`\nFAILED: ${name}`);
      console.error(error);
    }
    throw new Error(`${results.failed} test(s) failed`);
  }
}
