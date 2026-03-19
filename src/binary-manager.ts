/**
 * Binary manager for qmtcode.
 *
 * Resolves platform target triples, finds release assets, downloads and extracts
 * the binary into extension global storage.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type ReleaseChannel = "stable" | "nightly";

export interface DownloadProgress {
  report(value: { message?: string; increment?: number }): void;
}

interface LoggerLike {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  assets: ReleaseAsset[];
}

interface BinaryMetadata {
  channel: ReleaseChannel;
  releaseTag: string;
  assetName: string;
  downloadedAt: string;
  version?: string;
}

export function getStoredBinaryPath(globalStoragePath: string): string | undefined {
  const binaryName = process.platform === "win32" ? "qmtcode.exe" : "qmtcode";
  const fullPath = join(globalStoragePath, "bin", binaryName);
  return existsSync(fullPath) ? fullPath : undefined;
}

export function getBundledBinaryCandidates(): string[] {
  const ext = process.platform === "win32" ? ".exe" : "";
  const candidates: string[] = [];

  // Legacy naming used in this extension.
  let osName: string = process.platform;
  if (process.platform === "win32") osName = "windows";
  let cpuName: string = process.arch;
  if (process.arch === "x64") cpuName = "amd64";
  candidates.push(`qmtcode-${osName}-${cpuName}${ext}`);

  // Rust target-triple naming used by release artifacts.
  candidates.push(`qmtcode-${getTargetTriple()}${ext}`);

  return candidates;
}

export async function ensureDownloadedBinary(
  globalStoragePath: string,
  channel: ReleaseChannel,
  progress: DownloadProgress | undefined,
  log: LoggerLike,
): Promise<string> {
  const target = getTargetTriple();
  const ext = process.platform === "win32" ? "zip" : "tar.gz";

  progress?.report({ message: `Resolving ${channel} release for ${target}...` });
  const release = await fetchRelease(channel);
  const asset = selectAsset(release, target, channel, ext);

  const tmpRoot = mkdtempSync(join(tmpdir(), "qmtcode-download-"));
  const archivePath = join(tmpRoot, `qmtcode.${ext}`);
  const extractDir = join(tmpRoot, "extract");

  try {
    mkdirSync(extractDir, { recursive: true });
    progress?.report({ message: `Downloading ${asset.name}...` });
    await downloadToFile(asset.browser_download_url, archivePath);

    progress?.report({ message: "Extracting qmtcode..." });
    extractArchive(archivePath, extractDir, ext);

    const discovered = findBinaryInDir(
      extractDir,
      process.platform === "win32" ? "qmtcode.exe" : "qmtcode",
    );
    if (!discovered) {
      throw new Error("Downloaded archive did not contain qmtcode");
    }

    const installDir = join(globalStoragePath, "bin");
    mkdirSync(installDir, { recursive: true });
    const installedPath = join(
      installDir,
      process.platform === "win32" ? "qmtcode.exe" : "qmtcode",
    );

    copyFileSync(discovered, installedPath);
    if (process.platform !== "win32") {
      chmodSync(installedPath, 0o755);
    }

    const version = getBinaryVersion(installedPath);
    const metadata: BinaryMetadata = {
      channel,
      releaseTag: release.tag_name,
      assetName: asset.name,
      downloadedAt: new Date().toISOString(),
      version,
    };
    writeFileSync(join(installDir, "qmtcode-metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");

    log.info(`Downloaded qmtcode (${asset.name}) to ${installedPath}`);
    return installedPath;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export function getTargetTriple(): string {
  const arch = process.arch;
  const platform = process.platform;

  switch (platform) {
    case "darwin":
      if (arch === "x64") return "x86_64-apple-darwin";
      if (arch === "arm64") return "aarch64-apple-darwin";
      break;
    case "linux":
      if (arch === "x64") return "x86_64-unknown-linux-musl";
      if (arch === "arm64") return "aarch64-unknown-linux-musl";
      break;
    case "freebsd":
      if (arch === "x64") return "x86_64-unknown-freebsd";
      break;
    case "win32":
      if (arch === "x64") return "x86_64-pc-windows-msvc";
      if (arch === "arm64") return "aarch64-pc-windows-msvc";
      break;
    default:
      break;
  }

  throw new Error(`Unsupported platform/architecture: ${platform}/${arch}`);
}

async function fetchRelease(channel: ReleaseChannel): Promise<GithubRelease> {
  const url =
    channel === "nightly"
      ? "https://api.github.com/repos/querymt/querymt/releases/tags/nightly"
      : "https://api.github.com/repos/querymt/querymt/releases/latest";

  const res = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "vscode-querymt",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to query releases API (${res.status} ${res.statusText})`);
  }
  const json = (await res.json()) as GithubRelease;
  if (!json?.assets || !Array.isArray(json.assets)) {
    throw new Error("Unexpected releases API response");
  }
  return json;
}

function selectAsset(
  release: GithubRelease,
  target: string,
  channel: ReleaseChannel,
  ext: string,
): ReleaseAsset {
  const regex =
    channel === "nightly"
      ? new RegExp(`^qmtcode-nightly-.*-${escapeRegex(target)}\\.${escapeRegex(ext)}$`)
      : new RegExp(`^qmtcode-.*-${escapeRegex(target)}\\.${escapeRegex(ext)}$`);

  const asset = release.assets.find((a) => regex.test(a.name));
  if (!asset) {
    throw new Error(
      `Could not find qmtcode asset for target ${target} in release ${release.tag_name}`,
    );
  }
  return asset;
}

function extractArchive(archivePath: string, extractDir: string, ext: string): void {
  if (ext === "tar.gz") {
    execFileSync("tar", ["-xzf", archivePath, "-C", extractDir], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20000,
    });
    return;
  }

  if (ext === "zip" && process.platform === "win32") {
    const command = `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`;
    execFileSync("powershell", ["-NoProfile", "-Command", command], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20000,
    });
    return;
  }

  throw new Error(`Unsupported archive format for this platform: ${ext}`);
}

async function downloadToFile(url: string, outPath: string): Promise<void> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "vscode-querymt",
    },
  });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status} ${res.statusText})`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(outPath, bytes);
}

function findBinaryInDir(dir: string, fileName: string): string | undefined {
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === fileName) {
        return fullPath;
      }
    }
  }
  return undefined;
}

function getBinaryVersion(binaryPath: string): string | undefined {
  try {
    const out = execFileSync(binaryPath, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim().split("\n")[0] || undefined;
  } catch {
    return undefined;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
