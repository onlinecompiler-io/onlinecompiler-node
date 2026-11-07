// verifyWebhook, verifyReceipt and canonicalJson: no client and no network. Run with: npm test
import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { canonicalJson, verifyReceipt, verifyWebhook } from '../dist/index.js';

const SECRET = 'whsec_' + 'a'.repeat(43);
const OLD_SECRET = 'whsec_' + 'b'.repeat(43);
const BODY = '{"event":"submission.finished","submission":"sub_8f2Kq7LmT3xR9vWb1cYd4hNe","status":"finished"}';

const sign = (secret, body, timestamp) =>
	'v1=' + createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');

function headersFor(secrets, { body = BODY, timestamp = Math.floor(Date.now() / 1000) } = {}) {
	return {
		'X-OC-Event': 'submission.finished',
		'X-OC-Delivery': 'dlv_8f2Kq7LmT3xR9vWb1cYd4hNe',
		'X-OC-Timestamp': String(timestamp),
		'X-OC-Signature': secrets.map((secret) => sign(secret, body, timestamp)).join(',')
	};
}

const rename = (headers, convert) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [convert(k), v]));

describe('verifyWebhook', () => {
	test('a correct signature passes', async () => {
		assert.equal(await verifyWebhook(SECRET, BODY, headersFor([SECRET])), true);
	});

	test('during a rotation either secret passes', async () => {
		const both = headersFor([SECRET, OLD_SECRET]);
		assert.match(both['X-OC-Signature'], /,/);
		assert.equal(await verifyWebhook(SECRET, BODY, both), true);
		assert.equal(await verifyWebhook(OLD_SECRET, BODY, both), true);
	});

	test('the receiver may hold several secrets', async () => {
		assert.equal(await verifyWebhook([OLD_SECRET, SECRET], BODY, headersFor([SECRET])), true);
	});

	test('header names match in any case, in a plain object or Headers', async () => {
		const sent = headersFor([SECRET]);
		for (const convert of [(k) => k.toLowerCase(), (k) => k.toUpperCase(), (k) => k]) {
			assert.equal(await verifyWebhook(SECRET, BODY, rename(sent, convert)), true);
		}
		assert.equal(await verifyWebhook(SECRET, BODY, new Headers(sent)), true);
	});

	test('the body may be a string, a Buffer, a Uint8Array or an ArrayBuffer', async () => {
		const sent = headersFor([SECRET]);
		const bytes = new TextEncoder().encode(BODY);
		assert.equal(await verifyWebhook(SECRET, Buffer.from(BODY), sent), true);
		assert.equal(await verifyWebhook(SECRET, bytes, sent), true);
		assert.equal(await verifyWebhook(SECRET, bytes.buffer, sent), true);
		// A view into a larger buffer, as a framework's raw body can be.
		const padded = new Uint8Array(bytes.length + 8);
		padded.set(bytes, 4);
		assert.equal(await verifyWebhook(SECRET, padded.subarray(4, 4 + bytes.length), sent), true);
	});

	test('only the first 8 signatures count', async () => {
		const now = Math.floor(Date.now() / 1000);
		const decoys = Array.from({ length: 8 }, (_, i) => sign(`whsec_decoy${i}`, BODY, now));
		const good = sign(SECRET, BODY, now);
		const eighth = [...decoys.slice(0, 7), good].join(',');
		const ninth = [...decoys, good].join(',');
		assert.equal(await verifyWebhook(SECRET, BODY, { 'X-OC-Timestamp': String(now), 'X-OC-Signature': eighth }), true);
		assert.equal(await verifyWebhook(SECRET, BODY, { 'X-OC-Timestamp': String(now), 'X-OC-Signature': ninth }), false);
	});

	test('a wrong secret fails', async () => {
		assert.equal(await verifyWebhook(OLD_SECRET, BODY, headersFor([SECRET])), false);
		assert.equal(await verifyWebhook(SECRET.slice('whsec_'.length), BODY, headersFor([SECRET])), false);
	});

	test('a changed body fails', async () => {
		assert.equal(await verifyWebhook(SECRET, BODY.replace('finished', 'failed'), headersFor([SECRET])), false);
		assert.equal(await verifyWebhook(SECRET, BODY + '\n', headersFor([SECRET])), false);
	});

	test('a timestamp outside the tolerance fails', async () => {
		const now = Math.floor(Date.now() / 1000);
		assert.equal(await verifyWebhook(SECRET, BODY, headersFor([SECRET], { timestamp: now - 301 })), false);
		assert.equal(await verifyWebhook(SECRET, BODY, headersFor([SECRET], { timestamp: now + 301 })), false);
		assert.equal(await verifyWebhook(SECRET, BODY, headersFor([SECRET], { timestamp: now - 3000 }), { toleranceSeconds: 3600 }), true);
		assert.equal(await verifyWebhook(SECRET, BODY, headersFor([SECRET], { timestamp: now - 3000 })), false);
		assert.equal(await verifyWebhook(SECRET, BODY, headersFor([SECRET]), { toleranceSeconds: NaN }), false);
		// The options are an object, so a bare number (seconds or milliseconds?) is refused, never guessed at.
		assert.equal(await verifyWebhook(SECRET, BODY, headersFor([SECRET]), 3600), false);
		assert.equal(await verifyWebhook(SECRET, BODY, headersFor([SECRET]), null), false);
	});

	test('a missing header fails', async () => {
		for (const name of ['X-OC-Timestamp', 'X-OC-Signature']) {
			const sent = headersFor([SECRET]);
			delete sent[name];
			assert.equal(await verifyWebhook(SECRET, BODY, sent), false, name);
		}
	});

	test('malformed headers fail without throwing', async () => {
		const now = Math.floor(Date.now() / 1000);
		const good = sign(SECRET, BODY, now);
		const cases = {
			'timestamp not digits': { 'X-OC-Timestamp': `${now}.0`, 'X-OC-Signature': good },
			'signed timestamp with a plus sign': { 'X-OC-Timestamp': `+${now}`, 'X-OC-Signature': good },
			'timestamp blank': { 'X-OC-Timestamp': '', 'X-OC-Signature': good },
			'no v1= prefix': { 'X-OC-Timestamp': String(now), 'X-OC-Signature': good.slice(3) },
			'other scheme': { 'X-OC-Timestamp': String(now), 'X-OC-Signature': 'v0=' + good.slice(3) },
			'upper-case hex': { 'X-OC-Timestamp': String(now), 'X-OC-Signature': 'v1=' + good.slice(3).toUpperCase() },
			garbage: { 'X-OC-Timestamp': String(now), 'X-OC-Signature': 'v1=éé, ,,==' },
			empty: { 'X-OC-Timestamp': String(now), 'X-OC-Signature': '' },
			'array timestamp': { 'X-OC-Timestamp': [String(now), String(now)], 'X-OC-Signature': good }
		};
		for (const [label, sent] of Object.entries(cases)) {
			assert.equal(await verifyWebhook(SECRET, BODY, sent), false, label);
		}
	});

	test('bad arguments resolve to false', async () => {
		const sent = headersFor([SECRET]);
		const cases = [[undefined, BODY, sent], ['', BODY, sent], [[], BODY, sent], [[SECRET, 5], BODY, sent],
			[SECRET, 7, sent], [SECRET, null, sent], [SECRET, BODY, null], [SECRET, BODY, 'X-OC-Timestamp: 1']];
		for (const [secret, body, headers] of cases) {
			assert.equal(await verifyWebhook(secret, body, headers), false);
		}
	});
});

// Hard-coded canonical forms, checked byte for byte against the API's own canonical_json
// (backend/judge/canonical.py) when they were written.
const CANONICAL_CASES = [
	[{ b: 1, a: { d: [3, { z: null, y: true }], c: false } }, '{"a":{"c":false,"d":[3,{"y":true,"z":null}]},"b":1}'],
	[{ 'é': 1, e: 2, '\u{1f600}': 3, '｡': 4 }, '{"e":2,"é":1,"\u{1f600}":3,"｡":4}'],
	['café \u{1f680} 中文', '"café \u{1f680} 中文"'],
	['quote " backslash \\ slash / nl \n tab \t cr \r bs \b ff \f nul \x00 us \x1f del \x7f ls  ',
		'"quote \\" backslash \\\\ slash / nl \\n tab \\t cr \\r bs \\b ff \\f nul \\u0000 us \\u001f del \x7f ls  "'],
	[[0, 1, -1, 42, 9007199254740991, -9007199254740991], '[0,1,-1,42,9007199254740991,-9007199254740991]'],
	[[1.0, 0.1, 1e21, 1e-7, -0.0, 1e20, 1e-6, 100.0, 33.33, 1.5e300, 5e-324, 0.000123],
		'[1,0.1,1e+21,1e-7,0,100000000000000000000,0.000001,100,33.33,1.5e+300,5e-324,0.000123]'],
	[{ score: 33.33, tolerance: 1e-6, time_limit: 2.5, passed: 1 }, '{"passed":1,"score":33.33,"time_limit":2.5,"tolerance":0.000001}']
];

describe('canonicalJson', () => {
	test('canonical forms', () => {
		for (const [value, expected] of CANONICAL_CASES) assert.equal(canonicalJson(value), expected);
	});

	test('values JSON cannot hold are refused', () => {
		for (const value of [NaN, Infinity, undefined, () => 1, 10n, Symbol('s'), { a: undefined }, [undefined]]) {
			assert.throws(() => canonicalJson(value), TypeError);
		}
	});
});

const receiptFields = () => ({
	receipt: 'rcpt_7Hq2Zp4Wn8Ks1Ab6Ct3Dv5Ex', format: 1, submission: 'sub_8f2Kq7LmT3xR9vWb1cYd4hNe',
	account: 'acct_3k9Fj2Lq8Rt5Wm1Z', external_ref: 'attempt-4821 é\u{1f600}', issued: '2026-11-05T09:14:22Z',
	compiler: { id: 'python-3.14', version: '3.14', image: null },
	code_sha256: '0'.repeat(64), tests_sha256: '1'.repeat(64), files_sha256: null,
	settings: { checker: 'trim', tolerance: 1e-6, scoring: 'percent', time_limit: 2, stop_on_failure: false },
	verdict: 'wrong_answer', score: 33.33, passed: 1, total: 3,
	tests: [{ verdict: 'accepted', hidden: false, time: '0.0213' }, { verdict: 'wrong_answer', hidden: true },
		{ verdict: 'wrong_answer', hidden: true }]
});

const base64 = (bytes) => Buffer.from(bytes).toString('base64');

// Signed as the API signs: every field but the signature, key_id included, in canonical JSON.
async function signedReceipt() {
	const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
	const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
	const keys = [
		{ key_id: 'older-key', algorithm: 'Ed25519', public_key: base64(new Uint8Array(32).fill(1)) },
		{ key_id: 'test-key', algorithm: 'Ed25519', public_key: base64(raw) }
	];
	const unsigned = { ...receiptFields(), key_id: 'test-key' };
	const signature = await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(canonicalJson(unsigned)));
	return { receipt: { ...unsigned, signature: base64(new Uint8Array(signature)) }, keys };
}

describe('verifyReceipt', () => {
	test('a signed receipt passes, with the key list or the whole published document', async () => {
		const { receipt, keys } = await signedReceipt();
		assert.equal(await verifyReceipt(receipt, keys), true);
		assert.equal(await verifyReceipt(receipt, { keys }), true);
		assert.equal(await verifyReceipt(JSON.parse(JSON.stringify(receipt)), keys), true);
	});

	test('key order does not matter', async () => {
		const { receipt, keys } = await signedReceipt();
		assert.equal(await verifyReceipt(Object.fromEntries(Object.entries(receipt).reverse()), keys), true);
	});

	test('a tampered field fails', async () => {
		const { receipt, keys } = await signedReceipt();
		for (const [field, value] of [['verdict', 'accepted'], ['score', 100], ['passed', 3],
			['external_ref', 'attempt-4822'], ['issued', '2026-11-05T09:14:23Z']]) {
			assert.equal(await verifyReceipt({ ...receipt, [field]: value }, keys), false, field);
		}
		const nested = { ...receipt, tests: [{ verdict: 'accepted', hidden: true }, ...receipt.tests.slice(1)] };
		assert.equal(await verifyReceipt(nested, keys), false);
		assert.equal(await verifyReceipt({ ...receipt, extra: 1 }, keys), false);
	});

	test('an unknown key_id fails', async () => {
		const { receipt, keys } = await signedReceipt();
		assert.equal(await verifyReceipt({ ...receipt, key_id: 'other-key' }, keys), false);
		assert.equal(await verifyReceipt(receipt, keys.slice(0, 1)), false);
		assert.equal(await verifyReceipt(receipt, []), false);
	});

	test('a bad signature fails', async () => {
		const { receipt, keys } = await signedReceipt();
		for (const signature of ['not base64!', receipt.signature.slice(0, -2), '', 'AAAA', null, 12]) {
			assert.equal(await verifyReceipt({ ...receipt, signature }, keys), false, String(signature));
		}
		const flipped = Buffer.from(receipt.signature, 'base64');
		flipped[0] ^= 1;
		assert.equal(await verifyReceipt({ ...receipt, signature: flipped.toString('base64') }, keys), false);
	});

	test('deeply nested hostile JSON fails without rejecting', async () => {
		const { receipt, keys } = await signedReceipt();
		let deep = 'x';
		for (let i = 0; i < 50000; i++) deep = [deep];
		assert.equal(await verifyReceipt({ ...receipt, deep }, keys), false);
	});

	test('null is false', async () => {
		const { receipt, keys } = await signedReceipt();
		assert.equal(await verifyReceipt(null, keys), false);
		assert.equal(await verifyReceipt(undefined, keys), false);
		assert.equal(await verifyReceipt(receipt, null), false);
	});

	test('a runtime without Ed25519 in Web Crypto is an error, not a false', async () => {
		const { receipt, keys } = await signedReceipt();
		const importKey = mock.method(crypto.subtle, 'importKey', async () => {
			throw new DOMException('Unrecognized algorithm name', 'NotSupportedError');
		});
		try {
			await assert.rejects(verifyReceipt(receipt, keys), { name: 'NotSupportedError' });
		} finally {
			importKey.mock.restore();
		}
		assert.equal(await verifyReceipt(receipt, keys), true);
	});

	test('bad input fails', async () => {
		const { receipt, keys } = await signedReceipt();
		const { signature, ...missing } = receipt;
		assert.ok(signature);
		const cases = [[missing, keys], [receipt, keys.map((k) => ({ ...k, algorithm: 'RSA' }))],
			[receipt, [{ ...keys[1], public_key: '%%%' }]], [null, keys], ['receipt', keys], [receipt, null],
			[receipt, 'keys'], [{ ...receipt, score: NaN }, keys]];
		for (const [r, k] of cases) assert.equal(await verifyReceipt(r, k), false);
	});
});
