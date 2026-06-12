/**
 * Single source of truth for the set of packages we publish.
 *
 * Discovery order matters: platform-specific packages are returned first so
 * they land on npm before the meta package that lists them as
 * `optionalDependencies`. `@rivet-dev/agent-os-sidecar` (the meta package users
 * install) resolves the platform-specific binary package for the current host
 * at install time via npm `os`/`cpu`/`libc`, so those platform packages must
 * exist on the registry before anyone installs the meta.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface Package {
	name: string;
	/** Directory containing the package.json (absolute). */
	dir: string;
	/** Directory relative to repo root. */
	relDir: string;
}

export interface DiscoverPackagesOptions {
	/** Reserved for parity with the rivetkit discovery API. */
	includeReleaseOnly?: boolean;
}

/**
 * Packages excluded from discovery (private, built separately, or otherwise
 * not publishable). The `private: true` flag in package.json already excludes
 * most of these; the explicit list is a belt-and-suspenders guard for names
 * that must never be published even if their `private` flag is dropped.
 */
export const EXCLUDED = new Set<string>([
	"@rivet-dev/agent-os-workspace",
	"@rivet-dev/agent-os-dev-shell",
	"@rivet-dev/agent-os-playground",
	"@rivet-dev/agent-os-shell",
	"@rivet-dev/agent-os-quickstart",
	"@rivet-dev/agent-os-registry-types",
	"secure-exec",
	"@secure-exec/typescript",
	"publish",
]);

/**
 * Meta packages that need `optionalDependencies` injected at publish time.
 * The meta package's runtime resolver requires the platform-specific package
 * for the current host. The committed `package.json` deliberately does NOT
 * include these — they would pollute non-CI installs with version pins that do
 * not exist yet — so `bumpPackageJsons` injects them in full (publish-time)
 * mode.
 */
export interface MetaPackageSpec {
	/** Name of the meta package. */
	meta: string;
	/** Prefix of the platform-specific packages to inject. */
	platformPrefix: string;
}

export const META_PACKAGES: readonly MetaPackageSpec[] = [
	{
		meta: "@rivet-dev/agent-os-sidecar",
		platformPrefix: "@rivet-dev/agent-os-sidecar-",
	},
];

/**
 * Platforms whose sidecar binary package is built and published. Kept in sync
 * with the build matrix in `.github/workflows/publish.yaml`. Override via the
 * `SIDECAR_PLATFORMS` env var (space-separated) to publish a different set.
 * arm64 is deferred until its portability fix is verified end-to-end.
 */
export const DEFAULT_SIDECAR_PLATFORMS = ["linux-x64-gnu"] as const;

export function sidecarPlatforms(): string[] {
	const env = process.env.SIDECAR_PLATFORMS?.trim();
	if (env) return env.split(/\s+/).filter(Boolean);
	return [...DEFAULT_SIDECAR_PLATFORMS];
}

function isPublishable(pkg: { name?: string; private?: boolean }): boolean {
	if (!pkg.name) return false;
	if (pkg.private) return false;
	if (EXCLUDED.has(pkg.name)) return false;
	return true;
}

function readPackageJson(
	dir: string,
): { name?: string; private?: boolean } | null {
	const pkgPath = join(dir, "package.json");
	if (!existsSync(pkgPath)) return null;
	try {
		return JSON.parse(readFileSync(pkgPath, "utf8"));
	} catch {
		return null;
	}
}

export function discoverPackages(
	repoRoot: string,
	_opts: DiscoverPackagesOptions = {},
): Package[] {
	const packages: Package[] = [];
	const seen = new Set<string>();

	const add = (dir: string) => {
		const absDir = resolve(dir);
		const pkg = readPackageJson(absDir);
		if (!pkg) return;
		if (!pkg.name) return;
		if (!isPublishable(pkg)) return;
		if (seen.has(pkg.name)) return;
		seen.add(pkg.name);
		packages.push({
			name: pkg.name,
			dir: absDir,
			relDir: relative(repoRoot, absDir),
		});
	};

	// 1. Platform-specific sidecar binary packages first. These are
	//    `optionalDependencies` of the meta package and must exist on npm before
	//    the meta package resolves at install time. Only the allowlisted
	//    platforms are included so unbuilt platform dirs are never published.
	const platformAllowlist = new Set(sidecarPlatforms());
	const npmDir = join(repoRoot, "packages/sidecar-binary/npm");
	if (existsSync(npmDir)) {
		for (const entry of readdirSync(npmDir).sort()) {
			if (!platformAllowlist.has(entry)) continue;
			const platDir = join(npmDir, entry);
			if (!statSync(platDir).isDirectory()) continue;
			add(platDir);
		}
	}

	// 2. pnpm workspace packages (@rivet-dev/agent-os-*). Skip the
	//    registry/software/* WASM command packages — they are built and shipped
	//    separately, never published to npm from this flow.
	const pnpmList = execSync("pnpm -r list --json --depth -1", {
		cwd: repoRoot,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	const workspacePkgs: Array<{
		name: string;
		path: string;
		private?: boolean;
	}> = JSON.parse(pnpmList);
	for (const p of workspacePkgs) {
		if (!p.name) continue;
		if (!p.name.startsWith("@rivet-dev/agent-os-")) continue;
		if (p.path.includes("/registry/software/")) continue;
		add(p.path);
	}

	return packages;
}

/**
 * Returns a map of meta package name → list of platform package names that
 * should be injected as its `optionalDependencies`.
 */
export function buildMetaPlatformMap(
	packages: Package[],
): Map<string, string[]> {
	return new Map(
		META_PACKAGES.map(({ meta, platformPrefix }) => [
			meta,
			packages
				.filter((p) => p.name.startsWith(platformPrefix))
				.map((p) => p.name)
				.sort(),
		]),
	);
}

/**
 * Sanity check — asserts the expected root packages are present. Fail loud in
 * CI if discovery silently regressed. Called at the top of subcommands that
 * touch the full set.
 */
export function assertDiscoverySanity(packages: Package[]): void {
	const byName = new Set(packages.map((p) => p.name));
	const required = ["@rivet-dev/agent-os-core", "@rivet-dev/agent-os-sidecar"];
	const missing = required.filter((r) => !byName.has(r));
	if (missing.length > 0) {
		throw new Error(
			`package discovery missing required packages: ${missing.join(", ")}`,
		);
	}
	// Each meta must have at least one platform package.
	const metaMap = buildMetaPlatformMap(packages);
	for (const { meta } of META_PACKAGES) {
		const plats = metaMap.get(meta) ?? [];
		if (plats.length === 0) {
			throw new Error(
				`meta package ${meta} has zero platform packages discovered`,
			);
		}
	}
}
