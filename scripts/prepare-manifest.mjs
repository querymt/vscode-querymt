#!/usr/bin/env node
/**
 * Prepare package.json for target-specific VSIX packaging.
 *
 * Usage:
 *   node scripts/prepare-manifest.mjs vscode   # keep full manifest (no-op backup)
 *   node scripts/prepare-manifest.mjs ovsx     # strip chat/LM contributions
 *   node scripts/prepare-manifest.mjs restore  # restore from backup
 *
 * The script creates a `.package.json.bak` before modifying and restores
 * from it when called with "restore".
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkgPath = resolve(root, "package.json");
const bakPath = resolve(root, ".package.json.bak");

const target = process.argv[2];

if (!target || !["vscode", "ovsx", "restore"].includes(target)) {
  console.error("Usage: prepare-manifest.mjs <vscode|ovsx|restore>");
  process.exit(1);
}

if (target === "restore") {
  if (existsSync(bakPath)) {
    copyFileSync(bakPath, pkgPath);
    console.log("Restored package.json from backup.");
  } else {
    console.log("No backup found — nothing to restore.");
  }
  process.exit(0);
}

// Back up the original
copyFileSync(pkgPath, bakPath);
console.log(`Backed up package.json to .package.json.bak`);

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

if (target === "vscode") {
  // VS Code Marketplace — keep everything as-is.
  console.log("Target: vscode — manifest unchanged.");
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  process.exit(0);
}

// ── Open VSX target — strip proprietary contribution points ──

console.log("Target: ovsx — stripping chat/LM contributions...");

const contributes = pkg.contributes ?? {};

// Remove chatParticipants
if (contributes.chatParticipants) {
  delete contributes.chatParticipants;
  console.log("  Removed contributes.chatParticipants");
}

// Remove languageModelChatProviders
if (contributes.languageModelChatProviders) {
  delete contributes.languageModelChatProviders;
  console.log("  Removed contributes.languageModelChatProviders");
}

// Replace activationEvents — remove onChatParticipant, keep onStartupFinished
pkg.activationEvents = (pkg.activationEvents ?? []).filter(
  (e) => !e.startsWith("onChatParticipant:"),
);
if (!pkg.activationEvents.includes("onStartupFinished")) {
  pkg.activationEvents.push("onStartupFinished");
}
console.log(`  activationEvents: ${JSON.stringify(pkg.activationEvents)}`);

pkg.contributes = contributes;

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("Manifest prepared for Open VSX.");
