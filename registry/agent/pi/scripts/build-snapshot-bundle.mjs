/**
 * Builds the Pi SDK snapshot bundle (Step 2a).
 *
 * Bundles src/snapshot-entry.ts into a single IIFE at dist/pi-sdk-snapshot.js that
 * evaluates the SDK graph and publishes it on globalThis.__PI_SDK_RUNTIME__. node:
 * builtins stay external (provided by the V8 runtime's bridge polyfills, already in
 * the snapshot heap); heavy provider SDKs reached only via dynamic import() stay
 * external so they remain lazy and load post-restore from the VFS.
 *
 * The build env intentionally clears DISPLAY/WAYLAND_DISPLAY (C0 mitigation): the
 * optional @mariozechner/clipboard NAPI addon is behind a DISPLAY guard; with it
 * unset the SDK bakes `clipboard = null` so no native pointer enters the snapshot.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

// esbuild lives in the workspace pnpm store; resolve it from there.
const require = createRequire(import.meta.url);
const repoRoot = join(pkgRoot, "..", "..", "..");
let esbuildPath;
try {
	esbuildPath = require.resolve("esbuild", { paths: [pkgRoot, repoRoot] });
} catch {
	const { globSync } = await import("node:fs");
	const matches = globSync(
		join(repoRoot, "node_modules/.pnpm/esbuild@*/node_modules/esbuild/lib/main.js"),
	);
	if (matches.length === 0) throw new Error("esbuild not found in workspace");
	esbuildPath = matches.sort().reverse()[0];
}
const { build } = await import(pathToFileURL(esbuildPath).href);
const outfile = join(pkgRoot, "dist", "pi-sdk-snapshot.js");

// Provider SDKs the pi-ai layer pulls only via dynamic import(); keep them lazy.
const lazyExternals = [
	"@anthropic-ai/sdk",
	"openai",
	"@google/genai",
	"@mistralai/mistralai",
	"@aws-sdk/client-bedrock-runtime",
	"proxy-agent",
	"@mariozechner/clipboard",
];

// The adapter deliberately imports deep `dist/core/*` paths to skip the SDK's TUI
// graph, but the package `exports` map only exposes `.`/`./hooks`. Mirror the
// adapter: resolve the deep specifiers to absolute file paths under the package's
// dist dir, bypassing the exports map (esbuild bundles absolute paths fine).
const { realpathSync, existsSync } = await import("node:fs");
const piCodingRoot = [
	join(pkgRoot, "node_modules/@mariozechner/pi-coding-agent"),
	join(repoRoot, "node_modules/@mariozechner/pi-coding-agent"),
].find((p) => existsSync(p));
if (!piCodingRoot) throw new Error("pi-coding-agent not found in node_modules");
const piCodingReal = realpathSync(piCodingRoot);
const piCodingDist = join(piCodingReal, "dist");
// pnpm sibling layout: pi-coding-agent's own deps (incl. pi-agent-core) live in the
// same `.pnpm/<hash>/node_modules/@mariozechner` dir. Resolve transitive
// @mariozechner/* deps from there so we bundle exactly what the SDK links against.
const piSiblingScope = dirname(piCodingReal); // .../node_modules/@mariozechner
const deepImportPlugin = {
	name: "pi-deep-imports",
	setup(b) {
		b.onResolve({ filter: /^@mariozechner\/pi-coding-agent\/dist\// }, (a) => {
			const rel = a.path.replace("@mariozechner/pi-coding-agent/dist/", "");
			return { path: join(piCodingDist, rel) };
		});
		b.onResolve({ filter: /^@mariozechner\/pi-agent-core/ }, (a) => {
			const sub = a.path.replace("@mariozechner/pi-agent-core", "") || "/dist/index.js";
			return { path: join(piSiblingScope, "pi-agent-core", sub) };
		});
	},
};

// esbuild stubs `import.meta` to `{}` in IIFE output, so import.meta.url is
// undefined and the SDK's top-level install-detection (fileURLToPath(import.meta.url))
// crashes. Pin it to a single deterministic URL: the SDK's projected guest path, so
// any top-level dir/version computation resolves to where the SDK actually lives in
// the VM. Override with PI_SNAPSHOT_BASE_URL (e.g. the real host path for testing).
const baseUrl =
	process.env.PI_SNAPSHOT_BASE_URL ||
	"file:///root/node_modules/@mariozechner/pi-coding-agent/dist/index.js";

const result = await build({
	entryPoints: [join(pkgRoot, "src", "snapshot-entry.ts")],
	outfile,
	bundle: true,
	format: "iife",
	platform: "node", // node: builtins become external require() calls
	target: "esnext",
	external: lazyExternals,
	plugins: [deepImportPlugin],
	define: {
		"import.meta.url": JSON.stringify(baseUrl),
		// C0 mitigation: force the headless path in the clipboard native-addon
		// guard so `require("@mariozechner/clipboard")` (a NAPI addon) is never
		// triggered at snapshot-eval time, regardless of the sidecar's env.
		"process.env.DISPLAY": '""',
		"process.env.WAYLAND_DISPLAY": '""',
		"process.env.TERMUX_VERSION": '""',
	},
	legalComments: "none",
	logLevel: "info",
	metafile: true,
});

const bytes = readFileSync(outfile);
const sha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(`${outfile}.sha256`, `${sha256}\n`);

const inputs = Object.keys(result.metafile.inputs).length;
console.log(
	`\npi-sdk-snapshot.js: ${(bytes.length / 1024).toFixed(0)} KiB · ${inputs} modules inlined · sha256 ${sha256.slice(0, 12)}…`,
);
