// Checks that need no client and no network: webhook signatures, receipt signatures and the canonical JSON
// receipts are signed over. They use Web Crypto (globalThis.crypto.subtle), so they run in Node, Deno, Bun,
// Cloudflare Workers and browsers, with no dependency.

const encoder = new TextEncoder();
const TIMESTAMP = /^[0-9]{1,15}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;
const MAX_SIGNATURES = 8; // X-OC-Signature entries looked at; the API sends one, or two during a secret rotation
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A published receipt signing key: the base64 of its raw 32-byte Ed25519 public key. */
export interface ReceiptKey {
	key_id: string;
	algorithm: string;
	public_key: string;
}

export interface WebhookOptions {
	/** How far X-OC-Timestamp may be from now, in seconds (default 300). */
	toleranceSeconds?: number;
}

/** Request headers as a plain object (Node, Express, Fastify) or a Headers object (fetch, Deno, Workers). */
export type HeadersLike =
	| { get(name: string): string | null }
	| Record<string, string | readonly string[] | undefined>;

/**
 * The canonical JSON of a value: what receipts are signed over, and what their tests and files hashes are
 * taken of. Object keys sorted by UTF-16 code units, no whitespace, non-ASCII text left as it is, numbers as
 * ECMAScript writes them; encoded as UTF-8, the same bytes as the API's own canonical form for any value the API
 * signs. Parity stops at two edges the API never signs: an integer beyond 2^53, which a JavaScript number cannot
 * hold (JSON.parse has already rounded it), and a string holding a lone surrogate, written here as a \uXXXX
 * escape where the API refuses it. Throws TypeError for anything JSON cannot hold, NaN and Infinity included.
 */
export function canonicalJson(value: unknown): string {
	if (value === null) return 'null';
	switch (typeof value) {
		case 'boolean':
		case 'string':
			return JSON.stringify(value);
		case 'number':
			if (!Number.isFinite(value)) throw new TypeError('NaN and Infinity cannot be canonicalized');
			return JSON.stringify(value); // -0 is written 0, as the API writes it
		case 'object': {
			if (Array.isArray(value)) return '[' + Array.from(value, (item) => canonicalJson(item)).join(',') + ']';
			const object = value as Record<string, unknown>;
			const keys = Object.keys(object).sort(); // the default sort compares UTF-16 code units
			return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(object[key])).join(',') + '}';
		}
		default:
			throw new TypeError(`cannot canonicalize ${typeof value}`);
	}
}

function bytesOf(body: unknown): Uint8Array | undefined {
	if (typeof body === 'string') return encoder.encode(body);
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	return undefined;
}

function header(headers: unknown, name: string): string | undefined {
	if (headers === null || typeof headers !== 'object') return undefined;
	const getter = (headers as { get?: unknown }).get;
	if (typeof getter === 'function') {
		const value: unknown = getter.call(headers, name);
		return typeof value === 'string' ? value : undefined;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== name) continue;
		if (typeof value === 'string') return value;
		if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join(',');
		return undefined;
	}
	return undefined;
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** Equal in time that depends only on the lengths, which are fixed here. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
	return difference === 0;
}

function base64Bytes(value: unknown): Uint8Array<ArrayBuffer> {
	if (typeof value !== 'string' || !BASE64.test(value)) throw new TypeError('expected base64 text');
	return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

/**
 * Whether a webhook delivery is genuine: true when X-OC-Signature holds a v1= HMAC-SHA256 of
 * "{X-OC-Timestamp}.{rawBody}" made with secret (the whole whsec_ string), and the timestamp is within
 * toleranceSeconds (default 300) of now. Only the first 8 entries of X-OC-Signature are looked at.
 *
 * rawBody is the request body exactly as received, before any JSON parsing: a string, or bytes (a Buffer,
 * Uint8Array or ArrayBuffer). A parsed and re-serialized body never matches. headers is a plain object or a
 * Headers object; names match in any case. secret may be a list, for while you rotate it on your side; during a
 * rotation on ours the header holds two signatures, and one match is enough. Each is compared in constant time.
 * Any missing, malformed or wrong input resolves to false; it never rejects.
 */
export async function verifyWebhook(
	secret: string | readonly string[],
	rawBody: string | Uint8Array | ArrayBuffer,
	headers: HeadersLike,
	options: WebhookOptions = {}
): Promise<boolean> {
	try {
		// An object, so that a bare number (seconds or milliseconds?) is refused rather than guessed at.
		if (options === null || typeof options !== 'object') return false;
		const toleranceSeconds = options.toleranceSeconds ?? 300;
		const secrets: unknown[] = typeof secret === 'string' ? [secret] : Array.isArray(secret) ? [...secret] : [];
		if (!secrets.length || !secrets.every((item) => typeof item === 'string' && item)) return false;
		const bytes = bytesOf(rawBody);
		const timestamp = header(headers, 'x-oc-timestamp');
		const signature = header(headers, 'x-oc-signature');
		if (!bytes || timestamp === undefined || signature === undefined || !TIMESTAMP.test(timestamp)) return false;
		// Written so that a NaN tolerance fails.
		if (!(Math.abs(Date.now() / 1000 - Number(timestamp)) <= toleranceSeconds)) return false;
		const sent = signature
			.split(',', MAX_SIGNATURES)
			.map((value) => value.trim())
			.filter((value) => value.startsWith('v1=') && SIGNATURE.test(value.slice(3)))
			.map((value) => hexBytes(value.slice(3)));
		if (!sent.length) return false;
		const prefix = encoder.encode(`${timestamp}.`);
		const message = new Uint8Array(prefix.length + bytes.length);
		message.set(prefix);
		message.set(bytes, prefix.length);
		let matched = false;
		for (const item of secrets as string[]) {
			const key = await crypto.subtle.importKey('raw', encoder.encode(item), { name: 'HMAC', hash: 'SHA-256' }, false, [
				'sign'
			]);
			const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, message)); // once per secret
			for (const value of sent) matched = sameBytes(expected, value) || matched;
		}
		return matched;
	} catch {
		return false; // bad input of any kind is a failed check, never an error
	}
}

/**
 * Whether a receipt's Ed25519 signature is valid: over the canonical JSON of every field but signature, with the
 * key the receipt names in key_id. keys is the published key list, as client.receiptKeys() resolves it, or the
 * whole { keys: [...] } document from https://api.onlinecompiler.io/.well-known/receipt-keys.json. No network.
 * Resolves to false for a changed field, an unknown key_id, a malformed signature, null (a submission without a
 * receipt) or any other bad input. Rejects with a NotSupportedError DOMException only on a runtime whose Web
 * Crypto has no Ed25519, so that it is never mistaken for a forged receipt.
 */
export async function verifyReceipt(
	receipt: Record<string, unknown> | null | undefined,
	keys: readonly ReceiptKey[] | { keys: readonly ReceiptKey[] } | null | undefined
): Promise<boolean> {
	try {
		const list: unknown = Array.isArray(keys) ? keys : (keys as { keys?: unknown } | null | undefined)?.keys;
		if (!Array.isArray(list) || receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
		const { signature, ...unsigned } = receipt;
		const entry: unknown = list.find((key) => key !== null && typeof key === 'object' && key.key_id === receipt.key_id);
		if (!entry || !('key_id' in receipt)) return false;
		const { algorithm = 'Ed25519', public_key } = entry as Partial<ReceiptKey>;
		if (algorithm !== 'Ed25519') return false;
		const publicKey = await crypto.subtle.importKey('raw', base64Bytes(public_key), { name: 'Ed25519' }, false, ['verify']);
		const message = encoder.encode(canonicalJson(unsigned));
		return await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, base64Bytes(signature), message);
	} catch (error) {
		if ((error as { name?: unknown } | null)?.name === 'NotSupportedError') throw error; // no Ed25519 here
		return false;
	}
}
