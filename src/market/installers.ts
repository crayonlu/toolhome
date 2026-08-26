import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../domain/errors.js';
import type { MarketEntry } from './catalog.js';

export interface InstallerCommandOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface InstallerCommandResult {
  code: number;
  output: string;
}

export interface InstallerContext {
  marketDir: string;
  uvEnv: Record<string, string>;
  update: (patch: { step?: string; output?: string }) => void;
  runCommand: (
    command: string,
    args: string[],
    options?: InstallerCommandOptions,
  ) => Promise<InstallerCommandResult>;
}

export type MarketArtifact =
  | {
      type: 'npm';
      package: string;
      bin: string;
      version?: string;
    }
  | {
      type: 'go';
      module: string;
      bin: string;
      version?: string;
    }
  | {
      type: 'github-release';
      repository: string;
      tag: string;
      asset: string;
      url: string;
      bin: string;
      archive?: 'tar.gz' | 'zip';
    }
  | {
      type: 'uvx';
      package: string;
      bin: string;
      version?: string;
      with?: string[];
    }
  | {
      type: 'docker';
      image: string;
      entrypoint?: string | null;
      dockerfile?: string;
      name?: string;
    };

export interface InstalledArtifactRuntime {
  command: string;
  executionMode: 'host' | 'docker';
  entrypoint: string | null;
}

/**
 * Resolves the hidden installer recipe for a curated Market entry.
 * Legacy catalog kinds remain supported while installer technologies stay out
 * of the product-facing entry identity.
 */
export function installerForEntry(entry: MarketEntry): MarketArtifact | null {
  if (entry.installer !== undefined) {
    return { ...entry.installer, ...(entry.installer.type === 'docker' ? { name: entry.id } : {}) };
  }
  switch (entry.kind) {
    case 'home-stdio':
      return {
        type: 'npm',
        package: entry.package ?? entry.id,
        bin: entry.bin ?? entry.id,
        ...(entry.version === undefined ? {} : { version: entry.version }),
      };
    case 'uvx':
      return {
        type: 'uvx',
        package: entry.package ?? entry.id,
        bin: entry.bin ?? entry.id,
        ...(entry.version === undefined ? {} : { version: entry.version }),
        ...(entry.uvWith === undefined ? {} : { with: entry.uvWith }),
      };
    case 'docker':
    case 'cli-image':
      return {
        type: 'docker',
        image: entry.image ?? '',
        ...(entry.entrypoint === undefined ? {} : { entrypoint: entry.entrypoint }),
        ...(entry.dockerfile === undefined ? {} : { dockerfile: entry.dockerfile }),
        name: entry.id,
      };
    case 'remote':
    case 'cli-binary':
      return null;
  }
}

export async function installArtifact(
  artifact: MarketArtifact,
  context: InstallerContext,
  options: { force?: boolean } = {},
): Promise<InstalledArtifactRuntime> {
  switch (artifact.type) {
    case 'npm':
      return installNpmArtifact(artifact, context);
    case 'go':
      return installGoArtifact(artifact, context);
    case 'github-release':
      return installGithubReleaseArtifact(artifact, context);
    case 'uvx':
      return installUvxArtifact(artifact, context);
    case 'docker':
      return installDockerArtifact(artifact, context, options.force === true);
  }
}

function installNpmArtifact(
  artifact: Extract<MarketArtifact, { type: 'npm' }>,
  context: InstallerContext,
): Promise<InstalledArtifactRuntime> {
  const pinned = pinNpm(artifact.package, artifact.version);
  return runHostInstall(
    context,
    'npm',
    ['install', '--prefix', context.marketDir, '--no-audit', '--no-fund', pinned],
    `npm install ${pinned}`,
    300_000,
    `npm install failed`,
  ).then(() => ({
    command: join(context.marketDir, 'node_modules', '.bin', artifact.bin),
    executionMode: 'host',
    entrypoint: null,
  }));
}

function installGoArtifact(
  artifact: Extract<MarketArtifact, { type: 'go' }>,
  context: InstallerContext,
): Promise<InstalledArtifactRuntime> {
  const goBinDir = join(context.marketDir, 'go', 'bin');
  const pinned = pinGo(artifact.module, artifact.version);
  return runHostInstall(
    context,
    'go',
    ['install', pinned],
    `go install ${pinned}`,
    300_000,
    'go install failed',
    { GOBIN: goBinDir },
  ).then(() => ({
    command: join(goBinDir, artifact.bin),
    executionMode: 'host',
    entrypoint: null,
  }));
}

async function installGithubReleaseArtifact(
  artifact: Extract<MarketArtifact, { type: 'github-release' }>,
  context: InstallerContext,
): Promise<InstalledArtifactRuntime> {
  const archivePath = join(context.marketDir, 'downloads', artifact.asset);
  const extractDir = join(context.marketDir, 'github-releases', artifact.repository, artifact.tag);
  const binDir = join(context.marketDir, 'bin');
  mkdirSync(join(context.marketDir, 'downloads'), { recursive: true });
  mkdirSync(extractDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const download = await runInstallerCommand(
    context,
    'curl',
    ['-fsSL', '--retry', '3', '-o', archivePath, artifact.url],
    { timeoutMs: 300_000, step: `downloading ${artifact.repository}@${artifact.tag}` },
  );
  if (download.code !== 0) {
    throw new AppError(
      'market_install_failed',
      `GitHub Release download failed (${download.code}): ${download.output.slice(-400)}`,
      500,
    );
  }
  const extract =
    artifact.archive === 'zip'
      ? await runInstallerCommand(context, 'unzip', ['-oq', archivePath, '-d', extractDir], {
          timeoutMs: 300_000,
          step: `extracting ${artifact.asset}`,
        })
      : await runInstallerCommand(context, 'tar', ['-xzf', archivePath, '-C', extractDir], {
          timeoutMs: 300_000,
          step: `extracting ${artifact.asset}`,
        });
  if (extract.code !== 0) {
    throw new AppError(
      'market_install_failed',
      `GitHub Release extraction failed (${extract.code}): ${extract.output.slice(-400)}`,
      500,
    );
  }
  const source = join(extractDir, artifact.bin);
  const destination = join(binDir, artifact.bin);
  const copy = await runInstallerCommand(context, 'cp', [source, destination], {
    timeoutMs: 60_000,
    step: `installing ${artifact.bin}`,
  });
  if (copy.code !== 0) {
    throw new AppError(
      'market_install_failed',
      `GitHub Release binary installation failed (${copy.code}): ${copy.output.slice(-400)}`,
      500,
    );
  }
  chmodSync(destination, 0o755);
  return { command: destination, executionMode: 'host', entrypoint: null };
}

function installUvxArtifact(
  artifact: Extract<MarketArtifact, { type: 'uvx' }>,
  context: InstallerContext,
): Promise<InstalledArtifactRuntime> {
  const pinned = pinUvx(artifact.package, artifact.version);
  const args = ['tool', 'install', pinned];
  for (const dependency of artifact.with ?? []) args.push('--with', dependency);
  return runHostInstall(
    context,
    'uv',
    args,
    `uv tool install ${pinned}`,
    300_000,
    'uv tool install failed',
    context.uvEnv,
  ).then(() => ({
    command: join(context.uvEnv.UV_TOOL_BIN_DIR ?? '', artifact.bin),
    executionMode: 'host',
    entrypoint: null,
  }));
}

async function installDockerArtifact(
  artifact: Extract<MarketArtifact, { type: 'docker' }>,
  context: InstallerContext,
  force: boolean,
): Promise<InstalledArtifactRuntime> {
  if (artifact.image === '') {
    throw new AppError('market_install_failed', 'Docker entry is missing an image', 500);
  }

  if (!force) {
    const inspect = await runInstallerCommand(context, 'docker', [
      'image',
      'inspect',
      artifact.image,
    ]);
    if (inspect.code === 0) return dockerRuntime(artifact);
  }

  const pull = await runInstallerCommand(context, 'docker', ['pull', artifact.image]);
  if (pull.code === 0) return dockerRuntime(artifact);

  if (artifact.dockerfile !== undefined) {
    const directory = join(context.marketDir, 'dockerfiles', artifact.name ?? 'entry');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'Dockerfile'), artifact.dockerfile);
    const build = await runInstallerCommand(context, 'docker', [
      'build',
      '-t',
      artifact.image,
      directory,
    ]);
    if (build.code === 0) return dockerRuntime(artifact);
    throw new AppError(
      'market_install_failed',
      `Docker image ${artifact.image} could not be pulled or built: ${pull.output.slice(-240)}`,
      500,
    );
  }

  throw new AppError(
    'market_install_failed',
    `Docker image ${artifact.image} could not be pulled: ${pull.output.slice(-240)}`,
    500,
  );
}

async function runHostInstall(
  context: InstallerContext,
  command: string,
  args: string[],
  step: string,
  timeoutMs: number,
  failurePrefix: string,
  env?: Record<string, string>,
): Promise<void> {
  const result = await runInstallerCommand(context, command, args, { env, timeoutMs, step });
  if (result.code !== 0) {
    throw new AppError(
      'market_install_failed',
      `${failurePrefix} (${result.code}): ${result.output.slice(-400)}`,
      500,
    );
  }
}

async function runInstallerCommand(
  context: InstallerContext,
  command: string,
  args: string[],
  options: InstallerCommandOptions & { step?: string } = {},
): Promise<InstallerCommandResult> {
  context.update({ step: options.step ?? `${command} ${args.join(' ')}` });
  const result = await context.runCommand(command, args, options);
  if (result.output !== '') context.update({ output: result.output });
  return result;
}

function dockerRuntime(
  artifact: Extract<MarketArtifact, { type: 'docker' }>,
): InstalledArtifactRuntime {
  return {
    command: artifact.image,
    executionMode: 'docker',
    entrypoint: artifact.entrypoint ?? null,
  };
}

function pinNpm(packageName: string, version: string | undefined): string {
  return version === undefined ? packageName : `${packageName}@${version}`;
}

function pinGo(module: string, version: string | undefined): string {
  return version === undefined ? module : `${module}@${version}`;
}

function pinUvx(packageName: string, version: string | undefined): string {
  return version === undefined ? packageName : `${packageName}==${version}`;
}
