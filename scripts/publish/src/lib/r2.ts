/**
 * R2 client + upload + copy helpers for the releases bucket.
 *
 * Credentials come from env vars (`R2_RELEASES_ACCESS_KEY_ID` +
 * `R2_RELEASES_SECRET_ACCESS_KEY`). R2 hosting of the sidecar binary is a
 * convenience mirror for crates.io consumers — the npm platform packages bundle
 * the binary directly, so R2 upload is release-only and best-effort.
 *
 * Implementation note: we shell out to `aws s3 cp` / `aws s3api copy-object`
 * because Cloudflare R2 does not support the `x-amz-tagging-directive` header
 * the AWS SDK sends even with `--copy-props none`. The `s3api copy-object` path
 * avoids it. See:
 *   https://community.cloudflare.com/t/r2-s3-compat-doesnt-support-net-sdk-for-copy-operations-due-to-tagging-header/616867
 */
import { $ } from "execa";
import { scoped } from "./logger.js";

const log = scoped("r2");

const BUCKET = "rivet-releases";
const ENDPOINT_URL =
	"https://2a94c6a0ced8d35ea63cddc86c2681e7.r2.cloudflarestorage.com";

type R2Env = Record<string, string>;

let cached: R2Env | null = null;

function getR2Env(): R2Env {
	if (cached) return cached;
	const ak = process.env.R2_RELEASES_ACCESS_KEY_ID;
	const sk = process.env.R2_RELEASES_SECRET_ACCESS_KEY;
	if (!ak || !sk) {
		throw new Error(
			"R2_RELEASES_ACCESS_KEY_ID and R2_RELEASES_SECRET_ACCESS_KEY must be set",
		);
	}
	cached = {
		AWS_ACCESS_KEY_ID: ak,
		AWS_SECRET_ACCESS_KEY: sk,
		AWS_DEFAULT_REGION: "auto",
	};
	return cached;
}

export interface ListEntry {
	Key: string;
	Size?: number;
}
export interface ListResult {
	Contents: ListEntry[];
}

export async function listObjects(prefix: string): Promise<ListResult> {
	const env = getR2Env();
	const contents: ListEntry[] = [];
	let continuationToken: string | undefined;

	while (true) {
		const { stdout } = continuationToken
			? await $({
					env,
				})`aws s3api list-objects-v2 --bucket ${BUCKET} --prefix ${prefix} --continuation-token ${continuationToken} --endpoint-url ${ENDPOINT_URL}`
			: await $({
					env,
				})`aws s3api list-objects-v2 --bucket ${BUCKET} --prefix ${prefix} --endpoint-url ${ENDPOINT_URL}`;
		if (!stdout.trim()) break;

		const page = JSON.parse(stdout) as {
			Contents?: ListEntry[];
			IsTruncated?: boolean;
			NextContinuationToken?: string;
		};
		if (Array.isArray(page.Contents)) {
			contents.push(...page.Contents);
		}
		if (!page.IsTruncated || !page.NextContinuationToken) {
			break;
		}
		continuationToken = page.NextContinuationToken;
	}

	return { Contents: contents };
}

/** Upload a single file to R2. */
export async function uploadFile(
	localPath: string,
	r2Key: string,
): Promise<void> {
	const env = getR2Env();
	log.info(`uploading ${localPath} -> ${r2Key}`);
	await $({
		env,
		stdio: "inherit",
	})`aws s3 cp ${localPath} s3://${BUCKET}/${r2Key} --endpoint-url ${ENDPOINT_URL} --checksum-algorithm CRC32`;
}

/** Recursively upload a directory to an R2 prefix. */
export async function uploadDir(
	localDir: string,
	r2Prefix: string,
): Promise<void> {
	const env = getR2Env();
	log.info(`uploading directory ${localDir} -> ${r2Prefix}`);
	await $({
		env,
		stdio: "inherit",
	})`aws s3 cp ${localDir} s3://${BUCKET}/${r2Prefix} --recursive --endpoint-url ${ENDPOINT_URL} --checksum-algorithm CRC32`;
}

/** Delete every object under an R2 prefix. */
export async function deletePrefix(r2Prefix: string): Promise<void> {
	const env = getR2Env();
	log.info(`deleting ${r2Prefix}`);
	await $({
		env,
		stdio: "inherit",
	})`aws s3 rm s3://${BUCKET}/${r2Prefix} --recursive --endpoint-url ${ENDPOINT_URL}`;
}

/**
 * Copy every object under `sourcePrefix` to `targetPrefix`. Uses `s3api
 * copy-object` per-object to avoid the R2 tagging-directive bug.
 */
export async function copyPrefix(
	sourcePrefix: string,
	targetPrefix: string,
): Promise<void> {
	const env = getR2Env();
	log.info(`copying ${sourcePrefix} -> ${targetPrefix}`);

	const list = await listObjects(sourcePrefix);
	if (list.Contents.length === 0) {
		log.warn(
			`source prefix ${sourcePrefix} is empty. Skipping copy to ${targetPrefix}.`,
		);
		return;
	}

	// Delete the target first so stale files from a prior publish are cleaned.
	try {
		await deletePrefix(targetPrefix);
	} catch {
		// Target may not exist yet — that's fine.
	}

	for (const obj of list.Contents) {
		const sourceKey = obj.Key;
		const targetKey = sourceKey.replace(sourcePrefix, targetPrefix);
		log.info(`  ${sourceKey} -> ${targetKey}`);
		await $({
			env,
		})`aws s3api copy-object --bucket ${BUCKET} --key ${targetKey} --copy-source ${BUCKET}/${sourceKey} --endpoint-url ${ENDPOINT_URL}`;
	}
}
