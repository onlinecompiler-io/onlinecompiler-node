// The client against a local stand-in for the API, so these tests need no network or key.
// Run with: npm test
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Console } from 'node:console';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';
import {
	AuthenticationError,
	canonicalJson,
	NotFoundError,
	OnlineCompiler,
	OnlineCompilerError,
	RateLimitError,
	VERSION
} from '../dist/index.js';

let replies = [];
let requests = [];
// A reply that promises more bytes than it sends, then closes the connection.
class Truncated {
	constructor(text) {
		this.text = text;
	}
}
const sent = () => requests.at(-1);
const reply = (status, body) => replies.push([status, body]);

// Answers with the next canned [status, body] and records each request.
const server = createServer(async (req, res) => {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const bytes = Buffer.concat(chunks);
	const json = String(req.headers['content-type']).startsWith('application/json');
	requests.push({ method: req.method, path: req.url, headers: req.headers, bytes, body: bytes.length && json ? JSON.parse(bytes.toString()) : null });
	const [status, body] = replies.shift();
	if (body instanceof Truncated) {
		res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body.text) + 100) });
		res.write(body.text, () => res.destroy());
		return;
	}
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(typeof body === 'string' ? body : JSON.stringify(body));
});

let baseUrl;
let client;

before(async () => {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}/`;
});

after(() => server.close());

beforeEach(() => {
	replies = [];
	requests = [];
	client = new OnlineCompiler({ apiKey: 'key-123', baseUrl });
});

describe('OnlineCompiler', () => {
	test('run posts the program with the bare key and returns the result', async () => {
		reply(200, { output: 'hi\n', error: '', exit_code: 0, time: '0.02', memory: '8192' });
		const result = await client.run({ compiler: 'python-3.14', code: 'print(input())', input: 'hi' });
		assert.equal(result.output, 'hi\n');
		assert.equal(sent().method, 'POST');
		assert.equal(sent().path, '/api/run-code-sync/');
		assert.equal(sent().headers.authorization, 'key-123');
		assert.equal(sent().headers['user-agent'], `onlinecompiler-node/${VERSION}`);
		assert.deepEqual(sent().body, { compiler: 'python-3.14', code: 'print(input())', input: 'hi' });
	});

	test('options are sent only when given', async () => {
		reply(200, { output: '' });
		const files = [{ name: 'data.csv', content: 'a,b\n1,2\n' }];
		await client.run({ compiler: 'python-3.14', code: 'x', time_limit: 5, files });
		assert.deepEqual(sent().body, { input: '', compiler: 'python-3.14', code: 'x', time_limit: 5, files });
	});

	test('runTests sends the cases and chosen options', async () => {
		reply(200, { verdict: 'accepted', score: 100, passed: 1, total: 1, time_limit: 2, compile_error: null, tests: [] });
		const tests = [{ input: '1', expected_output: '2' }, { input: '5', expected_output: '6', hidden: true }];
		const result = await client.runTests({ compiler: 'python-3.14', code: 'c', tests, checker: 'tokens', scoring: 'percent' });
		assert.equal(result.verdict, 'accepted');
		assert.equal(sent().path, '/api/run-tests/');
		assert.deepEqual(sent().body, { compiler: 'python-3.14', code: 'c', tests, checker: 'tokens', scoring: 'percent' });
	});

	test('submit queues with extra_params', async () => {
		reply(202, { status: 'queued', id: 42 });
		const queued = await client.submit({ compiler: 'gcc-15', code: 'int main(){}', extra_params: { user: 7 } });
		assert.equal(queued.id, 42);
		assert.equal(sent().path, '/api/run-code/');
		assert.deepEqual(sent().body.extra_params, { user: 7 });
	});

	test('public endpoints send no key', async () => {
		reply(200, { compilers: [{ id: 'python-3.14', name: 'Python' }] });
		reply(200, { memory_mb: 512 });
		assert.deepEqual(await client.compilers(), [{ id: 'python-3.14', name: 'Python' }]);
		assert.equal((await client.limits()).memory_mb, 512);
		assert.deepEqual(requests.map((r) => r.path), ['/api/compilers/', '/api/limits/']);
		for (const r of requests) assert.equal(r.headers.authorization, undefined);
	});

	test('usage sends the key', async () => {
		reply(200, { submissions: 3, remaining: 99997 });
		assert.equal((await client.usage()).remaining, 99997);
		assert.equal(sent().method, 'GET');
		assert.equal(sent().path, '/api/usage/');
		assert.equal(sent().headers.authorization, 'key-123');
	});

	test('errors carry the API message and status', async () => {
		const cases = [[429, RateLimitError], [404, NotFoundError], [403, AuthenticationError],
			[409, OnlineCompilerError], [400, OnlineCompilerError], [503, OnlineCompilerError]];
		for (const [status, ErrorClass] of cases) {
			reply(status, { error: `refused with ${status}` });
			await assert.rejects(client.run({ compiler: 'python-3.14', code: 'x' }), (err) => {
				assert.ok(err instanceof ErrorClass);
				assert.ok(err instanceof OnlineCompilerError);
				assert.equal(err.status, status);
				assert.equal(err.message, `refused with ${status}`);
				assert.deepEqual(err.body, { error: `refused with ${status}` });
				return true;
			});
		}
	});

	test('an error page that is not JSON keeps its text', async () => {
		reply(502, 'Bad Gateway');
		await assert.rejects(client.run({ compiler: 'python-3.14', code: 'x' }), { status: 502, message: 'Bad Gateway' });
	});

	test('a missing key fails before any request', async () => {
		const saved = process.env.ONLINECOMPILER_API_KEY;
		delete process.env.ONLINECOMPILER_API_KEY;
		try {
			const keyless = new OnlineCompiler({ baseUrl });
			await assert.rejects(keyless.run({ compiler: 'python-3.14', code: 'x' }), (err) => {
				assert.ok(err instanceof AuthenticationError);
				assert.match(err.message, /ONLINECOMPILER_API_KEY/);
				return true;
			});
			assert.deepEqual(requests, []);
		} finally {
			if (saved !== undefined) process.env.ONLINECOMPILER_API_KEY = saved;
		}
	});

	test('the key comes from the environment', async () => {
		const saved = process.env.ONLINECOMPILER_API_KEY;
		process.env.ONLINECOMPILER_API_KEY = 'env-key';
		try {
			reply(200, { output: '' });
			await new OnlineCompiler({ baseUrl }).run({ compiler: 'python-3.14', code: 'x' });
			assert.equal(sent().headers.authorization, 'env-key');
		} finally {
			if (saved === undefined) delete process.env.ONLINECOMPILER_API_KEY;
			else process.env.ONLINECOMPILER_API_KEY = saved;
		}
	});

	test('an unreachable API rejects with status 0', async () => {
		const closed = createServer();
		await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
		const { port } = closed.address();
		await new Promise((resolve) => closed.close(resolve)); // nothing listens there now
		const unreachable = new OnlineCompiler({ apiKey: 'k', baseUrl: `http://127.0.0.1:${port}`, timeout: 2000 });
		await assert.rejects(unreachable.run({ compiler: 'python-3.14', code: 'x' }), (err) => {
			assert.ok(err instanceof OnlineCompilerError);
			assert.equal(err.status, 0);
			return true;
		});
	});
});

const SUB = 'sub_8f2Kq7LmT3xR9vWb1cYd4hNe';
const PROB = 'prob_7Hq2Zp4Wn8Ks1Ab6Ct3Dv5Ex';
const TOKEN = 'pst_' + 'T0k3n'.repeat(6) + 'Zz';
const TESTS = [{ input: '1 2', expected_output: '3' }, { input: '5 7', expected_output: '12', hidden: true }];
const RESULT = {
	verdict: 'accepted', score: 100, passed: 2, total: 2, time_limit: 2, compile_error: null,
	tests: [{ verdict: 'accepted', hidden: false }, { verdict: 'accepted', hidden: true }],
	summary: '1 of 1 sample test passed. 1 of 1 hidden test passed.'
};
const finished = (status = 'finished', fields = {}) => ({
	submission: SUB, status, created: '2026-11-05T09:00:00Z', finished: null, external_ref: null, metadata: null,
	problem: null, result: null, receipt: null, error: null, checker_log: null, hash_salt: 'salt', ...fields
});

describe('judging', () => {
	test('submissions sends each filter given as the query', async () => {
		const page = { submissions: [], next_cursor: null };
		reply(200, page);
		assert.deepEqual(await client.submissions(), page);
		assert.deepEqual([sent().method, sent().path], ['GET', '/api/submissions/']);
		reply(200, page);
		await client.submissions({
			ids: [SUB, `sub_${'b'.repeat(24)}`], external_ref: 'cand 1', problem: 'sum', status: 'finished',
			verdict: 'accepted', since: new Date(Date.UTC(2026, 10, 1)), until: '2026-11-03T09:00:00+05:30', limit: 50,
			cursor: 'abc', problemVersion: undefined
		});
		assert.equal(sent().path, `/api/submissions/?ids=${SUB}%2Csub_${'b'.repeat(24)}&external_ref=cand+1&problem=sum`
			+ '&status=finished&verdict=accepted&since=2026-11-01T00%3A00%3A00.000Z&until=2026-11-03T09%3A00%3A00%2B05%3A30'
			+ '&limit=50&cursor=abc');
		reply(400, { error: 'limit must be a whole number from 1 to 100' });
		await assert.rejects(client.submissions({ limit: 500 }), (err) => {
			assert.equal(err.status, 400);
			assert.equal(err.message, 'limit must be a whole number from 1 to 100');
			return true;
		});
	});

	test('an empty id list is an empty page without a request', async () => {
		assert.deepEqual(await client.submissions({ ids: [] }), { submissions: [], next_cursor: null });
		const listed = [];
		for await (const e of client.iterSubmissions({ ids: [] })) listed.push(e);
		assert.deepEqual([listed, requests], [[], []]);
	});

	test('iterSubmissions follows the cursor with the same filters', async () => {
		const entry = (n) => ({ submission: `sub_${String(n).padStart(24, '0')}`, status: 'queued' });
		reply(200, { submissions: [entry(1), entry(2)], next_cursor: 'c1' });
		reply(200, { submissions: [entry(3)], next_cursor: null });
		const listed = [];
		for await (const e of client.iterSubmissions({ external_ref: 'cand-1', limit: 2 })) listed.push(e.submission);
		assert.deepEqual(listed, [1, 2, 3].map((n) => entry(n).submission));
		assert.deepEqual(requests.map((r) => r.path), [
			'/api/submissions/?external_ref=cand-1&limit=2',
			'/api/submissions/?external_ref=cand-1&limit=2&cursor=c1'
		]);
	});

	test('an unknown key is an AuthenticationError and a missing id is a NotFoundError', async () => {
		reply(404, { error: 'Invalid or inactive API key' });
		await assert.rejects(client.run({ compiler: 'python-3.14', code: 'x' }), AuthenticationError);
		reply(404, { error: 'Submission not found' });
		await assert.rejects(client.submission(SUB), (err) => {
			assert.ok(err instanceof NotFoundError);
			assert.ok(!(err instanceof AuthenticationError));
			assert.equal(err.status, 404);
			assert.equal(err.message, 'Submission not found');
			return true;
		});
	});

	test('async runTests sends the options and the Idempotency-Key header', async () => {
		reply(202, { submission: SUB, status: 'queued' });
		const queued = await client.runTests({
			compiler: 'python-3.14', code: 'c', tests: TESTS, async: true, callback_url: 'https://example.com/hook',
			external_ref: 'attempt-1', metadata: { candidate: 7 }, idempotency_key: 'attempt-1'
		});
		assert.deepEqual(queued, { submission: SUB, status: 'queued' });
		assert.equal(sent().method, 'POST');
		assert.equal(sent().path, '/api/run-tests/');
		assert.equal(sent().headers['idempotency-key'], 'attempt-1');
		assert.deepEqual(sent().body, {
			compiler: 'python-3.14', code: 'c', tests: TESTS, async: true, callback_url: 'https://example.com/hook',
			external_ref: 'attempt-1', metadata: { candidate: 7 }
		});
	});

	test('a sync runTests sends no Idempotency-Key unless given', async () => {
		reply(200, { ...RESULT, submission: SUB, receipt: null });
		const result = await client.runTests({ compiler: 'python-3.14', code: 'c', tests: TESTS });
		assert.equal(result.submission, SUB);
		assert.equal(sent().headers['idempotency-key'], undefined);
		assert.equal('async' in sent().body, false);
	});

	test('callback_url needs async: true', async () => {
		await assert.rejects(client.runTests({ compiler: 'python-3.14', code: 'c', tests: TESTS, callback_url: 'https://example.com/hook' }), TypeError);
		await assert.rejects(client.judge('sum', { compiler: 'python-3.14', code: 'c', callback_url: 'https://example.com/hook', async: false }), TypeError);
		assert.deepEqual(requests, []);
	});

	test('a replayed sync request still running is waited for', async () => {
		// An Idempotency-Key retry while the original sync request is still running answers 202.
		reply(202, { submission: SUB, status: 'running' });
		reply(200, finished('running'));
		reply(200, finished('finished', { result: RESULT, receipt: { receipt: 'rcpt_x' } }));
		const result = await client.runTests({ compiler: 'python-3.14', code: 'c', tests: TESTS, idempotency_key: 'k1' });
		assert.deepEqual(result, { ...RESULT, submission: SUB, receipt: { receipt: 'rcpt_x' } });
		assert.deepEqual(requests.slice(1).map((r) => r.path), [`/api/submissions/${SUB}/`, `/api/submissions/${SUB}/`]);
	});

	test('a replayed sync request that failed rejects with its error', async () => {
		reply(202, { submission: SUB, status: 'running' });
		reply(200, finished('failed', { error: 'Internal error: judging failed. Send the submission again.' }));
		await assert.rejects(client.judge(PROB, { compiler: 'python-3.14', code: 'c', idempotency_key: 'k1' }), (err) => {
			assert.ok(err instanceof OnlineCompilerError);
			assert.match(err.message, /Send the submission again/);
			assert.equal(err.body.status, 'failed');
			return true;
		});
	});

	test('submission and deleteSubmission', async () => {
		reply(200, finished('finished', { result: RESULT }));
		assert.equal((await client.submission(SUB)).result.verdict, 'accepted');
		assert.equal(sent().method, 'GET');
		assert.equal(sent().path, `/api/submissions/${SUB}/`);
		reply(200, { submission: SUB, deleted: true });
		assert.deepEqual(await client.deleteSubmission(SUB), { submission: SUB, deleted: true });
		assert.equal(sent().method, 'DELETE');
		assert.equal(sent().path, `/api/submissions/${SUB}/`);
		assert.equal(sent().headers.authorization, 'key-123');
	});

	test('waitForSubmission polls until it ends', async () => {
		for (const status of ['queued', 'running', 'running']) reply(200, finished(status));
		reply(200, finished('finished', { result: RESULT }));
		const done = await client.waitForSubmission(SUB, { interval: 5, timeout: 5000 });
		assert.equal(done.status, 'finished');
		assert.equal(requests.length, 4);
		reply(200, finished('failed', { error: 'The API key that sent this submission was deleted before it ran.' }));
		assert.equal((await client.waitForSubmission(SUB, { interval: 5 })).status, 'failed');
	});

	test('waitForSubmission gives up after its timeout', async () => {
		for (let i = 0; i < 50; i++) reply(200, finished('queued'));
		const started = Date.now();
		await assert.rejects(client.waitForSubmission(SUB, { interval: 20, timeout: 100 }), (err) => {
			assert.ok(err instanceof OnlineCompilerError);
			assert.match(err.message, /still queued/);
			assert.equal(err.status, 0);
			return true;
		});
		assert.ok(Date.now() - started < 2000);
	});

	test('judge by id or slug reaches the quoted path', async () => {
		for (const [ref, path] of [[PROB, PROB], ['two-sum', 'two-sum'], ['two sum/v2?x#y', 'two%20sum%2Fv2%3Fx%23y']]) {
			reply(200, { ...RESULT, submission: SUB, receipt: null, problem: PROB, version: 3 });
			const result = await client.judge(ref, { compiler: 'python-3.14', code: 'code' });
			assert.equal(result.problem, PROB);
			assert.equal(result.version, 3);
			assert.equal(sent().method, 'POST');
			assert.equal(sent().path, `/api/problems/${path}/submissions/`);
			assert.deepEqual(sent().body, { compiler: 'python-3.14', code: 'code' });
		}
	});

	test('args, memory_limit and tests are sent as given', async () => {
		reply(200, { output: '', memory_limit: 64 });
		const run = await client.run({ compiler: 'python-3.14', code: 'c', args: ['a b', 'é'], memory_limit: 64 });
		assert.equal(run.memory_limit, 64);
		assert.deepEqual(sent().body.args, ['a b', 'é']);
		assert.equal(sent().body.memory_limit, 64);
		reply(200, { submission: SUB, status: 'queued' });
		await client.submit({ compiler: 'python-3.14', code: 'c', args: ['x'], memory_limit: 32 });
		assert.deepEqual([sent().body.args, sent().body.memory_limit], [['x'], 32]);
		reply(200, { ...RESULT, submission: SUB, receipt: null, memory_limit: 128 });
		await client.runTests({ compiler: 'python-3.14', code: 'c', memory_limit: 128, tests: [{ input: '', expected_output: '', args: ['1'] }] });
		assert.equal(sent().body.memory_limit, 128);
		assert.deepEqual(sent().body.tests[0].args, ['1']);
		reply(200, { ...RESULT, submission: SUB, receipt: null, problem: PROB, version: 3 });
		await client.judge('sum', { compiler: 'python-3.14', code: 'c', tests: [1, 3] });
		assert.deepEqual(sent().body.tests, [1, 3]);
	});

	test('rejudge posts only the fields given, to one quoted path segment', async () => {
		const answer = { version: 2, queued: [{ submission: SUB, rejudge_of: 'sub_old' }], skipped: [], remaining: 0 };
		reply(202, answer);
		assert.deepEqual(await client.rejudge('sum'), answer);
		assert.deepEqual([sent().method, sent().path, sent().body], ['POST', '/api/problems/sum/rejudge/', null]);
		reply(202, answer);
		await client.rejudge('two sum/v2', { version: 2, submissions: ['sub_old'], notify: true });
		assert.equal(sent().path, '/api/problems/two%20sum%2Fv2/rejudge/');
		assert.deepEqual(sent().body, { version: 2, submissions: ['sub_old'], notify: true });
		reply(202, answer);
		await client.rejudge(PROB, { notify: false });
		assert.deepEqual(sent().body, { notify: false });
		await assert.rejects(client.rejudge(undefined), TypeError);
	});

	test('judge async with every option', async () => {
		reply(202, { submission: SUB, status: 'queued' });
		const queued = await client.judge('sum', {
			compiler: 'python-3.14', code: 'code', mode: 'samples', async: true, external_ref: 'a-9', metadata: { x: 1 },
			callback_url: 'https://example.com/h', idempotency_key: 'a-9'
		});
		assert.equal(queued.submission, SUB);
		assert.equal(sent().headers['idempotency-key'], 'a-9');
		assert.deepEqual(sent().body, {
			compiler: 'python-3.14', code: 'code', mode: 'samples', async: true, external_ref: 'a-9', metadata: { x: 1 },
			callback_url: 'https://example.com/h'
		});
	});

	test('ids that are not path segments are refused before any request', async () => {
		for (const bad of ['', '.', '..']) {
			await assert.rejects(client.submission(bad), TypeError);
			await assert.rejects(client.problem(bad), TypeError);
			await assert.rejects(client.session('sum', bad), TypeError);
		}
		await assert.rejects(client.judge(undefined, { compiler: 'python-3.14', code: 'x' }), TypeError);
		assert.deepEqual(requests, []);
	});

	test('draft data files: raw bytes in, one encoded segment out', async () => {
		reply(200, { problem: PROB });
		const bin = new Uint8Array([0, 255, 10, 128]);
		assert.deepEqual(await client.putDraftFile('sum', 'my data/x.db', bin), { problem: PROB });
		assert.deepEqual([sent().method, sent().path], ['PUT', '/api/problems/sum/draft/files/my%20data%2Fx.db/']);
		assert.equal(sent().headers['content-type'], 'application/octet-stream');
		assert.equal(sent().headers['content-length'], '4');
		assert.deepEqual([...sent().bytes], [0, 255, 10, 128]);
		reply(200, { problem: PROB });
		await client.putDraftFile('sum', 'a.csv', 'é,1\n');
		assert.deepEqual([...sent().bytes], [...Buffer.from('é,1\n')]);
		reply(200, { problem: PROB });
		await client.putDraftFile('sum', 'empty.txt', '');
		assert.equal(sent().bytes.length, 0);
		assert.equal(sent().headers['content-length'], '0');
		reply(200, { problem: PROB });
		await client.deleteDraftFile('sum', 'a.csv');
		assert.deepEqual([sent().method, sent().path, sent().bytes.length], ['DELETE', '/api/problems/sum/draft/files/a.csv/', 0]);
		const n = requests.length;
		const badName = { name: 'TypeError', message: 'name must be a non-empty file name' };
		for (const bad of ['', '.', '..', 7, undefined]) {
			await assert.rejects(client.putDraftFile('sum', bad, 'x'), badName);
			await assert.rejects(client.deleteDraftFile('sum', bad), badName);
		}
		await assert.rejects(client.putDraftFile('', 'a', 'x'), { name: 'TypeError', message: 'problem must be a non-empty id' });
		await assert.rejects(client.putDraftFile('sum', 'a', 5), TypeError);
		assert.equal(requests.length, n);
		reply(404, { error: 'No such file' });
		await assert.rejects(client.deleteDraftFile('sum', 'gone'), NotFoundError);
	});

	test('problem authoring calls', async () => {
		const spec = { title: 'Sum', slug: 'sum', tests: [{ input: '1 2\n', expected_output: '3\n' }] };
		const calls = [
			[() => client.problems(), { problems: [{ problem: PROB }] }, ['GET', '/api/problems/', null], [{ problem: PROB }]],
			[() => client.createProblem(spec), { problem: PROB }, ['POST', '/api/problems/', spec]],
			[() => client.problem('sum'), { problem: PROB }, ['GET', '/api/problems/sum/', null]],
			[() => client.updateProblem('sum', { public: true }), { problem: PROB }, ['PATCH', '/api/problems/sum/', { public: true }]],
			[() => client.replaceDraft(PROB, { tests: spec.tests }), { problem: PROB }, ['PUT', `/api/problems/${PROB}/draft/`, { tests: spec.tests }]],
			[() => client.publishProblem('sum'), { problem: PROB, version: 1, state: 'published' }, ['POST', '/api/problems/sum/publish/', null]],
			[() => client.archiveProblem('sum'), { problem: PROB }, ['POST', '/api/problems/sum/archive/', null]],
			[() => client.restoreProblem('sum'), { problem: PROB }, ['POST', '/api/problems/sum/restore/', null]]
		];
		for (const [call, answer, [method, path, body], expected] of calls) {
			reply(200, answer);
			assert.deepEqual(await call(), expected ?? answer);
			assert.deepEqual([sent().method, sent().path, sent().body], [method, path, body]);
			assert.equal(sent().headers.authorization, 'key-123');
		}
	});

	test('the public view sends the key only when there is one', async () => {
		reply(200, { title: 'Sum', version: 1 });
		assert.equal((await client.publicProblem(PROB)).title, 'Sum');
		assert.equal(sent().path, `/api/problems/${PROB}/public/`);
		assert.equal(sent().headers.authorization, 'key-123');
		const saved = process.env.ONLINECOMPILER_API_KEY;
		delete process.env.ONLINECOMPILER_API_KEY;
		try {
			reply(200, { title: 'Sum', version: 1 });
			await new OnlineCompiler({ baseUrl }).publicProblem(PROB);
			assert.equal(sent().headers.authorization, undefined);
		} finally {
			if (saved !== undefined) process.env.ONLINECOMPILER_API_KEY = saved;
		}
	});

	test('sessions', async () => {
		const created = { session: 'pss_Qm4Tn8Vx2Kb7Hc3Ld9Wz5Ey1', problem: PROB, version: 2, token: TOKEN };
		reply(201, created);
		const session = await client.createSession('sum', {
			external_ref: 'attempt-7', metadata: { c: 1 }, callback_url: 'https://example.com/h', expires_in: 600, max_submits: 2,
			share_receipts: false
		});
		assert.equal(session.token, TOKEN);
		assert.equal(sent().method, 'POST');
		assert.equal(sent().path, '/api/problems/sum/sessions/');
		assert.deepEqual(sent().body, {
			external_ref: 'attempt-7', metadata: { c: 1 }, callback_url: 'https://example.com/h', expires_in: 600, max_submits: 2,
			share_receipts: false
		});
		reply(201, created);
		await client.createSession(PROB, { external_ref: 'attempt-8' });
		assert.deepEqual(sent().body, { external_ref: 'attempt-8' });
		reply(200, { session: 'pss_Qm4Tn8Vx2Kb7Hc3Ld9Wz5Ey1', submits_used: 1 });
		assert.equal((await client.session('sum', 'pss_Qm4Tn8Vx2Kb7Hc3Ld9Wz5Ey1')).submits_used, 1);
		assert.deepEqual([sent().method, sent().path], ['GET', '/api/problems/sum/sessions/pss_Qm4Tn8Vx2Kb7Hc3Ld9Wz5Ey1/']);
		reply(200, { session: 'pss_Qm4Tn8Vx2Kb7Hc3Ld9Wz5Ey1', revoked: '2026-11-05T10:00:00Z' });
		assert.ok((await client.revokeSession('sum', 'pss_Qm4Tn8Vx2Kb7Hc3Ld9Wz5Ey1')).revoked);
		assert.deepEqual([sent().method, sent().path], ['DELETE', '/api/problems/sum/sessions/pss_Qm4Tn8Vx2Kb7Hc3Ld9Wz5Ey1/']);
	});

	test('a session token never reaches an error', async () => {
		// A reply that is not JSON would normally be quoted in the error; a session's reply never is.
		reply(201, `{"session": "pss_x", "token": "${TOKEN}"`);
		await assert.rejects(client.createSession('sum', { external_ref: 'attempt-7' }), (err) => {
			assert.ok(err instanceof OnlineCompilerError);
			const shown = String(err) + err.stack + inspect(err, { depth: 5, showHidden: true }) + JSON.stringify(err);
			assert.ok(!shown.includes('T0k3n'));
			return true;
		});
		reply(409, { error: 'This problem is archived.' });
		await assert.rejects(client.createSession('sum', { external_ref: 'attempt-7' }), { status: 409, message: 'This problem is archived.' });
	});

	test('receipt keys need no API key and are cached', async () => {
		const keys = [{ key_id: 'oc-2026-11', algorithm: 'Ed25519', public_key: Buffer.alloc(32, 7).toString('base64') }];
		reply(200, { keys });
		assert.deepEqual(await client.receiptKeys(), keys);
		assert.deepEqual(await client.receiptKeys(), keys);
		assert.deepEqual(requests.map((r) => r.path), ['/.well-known/receipt-keys.json']);
		assert.equal(sent().headers.authorization, undefined);
		reply(200, { keys: [] });
		assert.deepEqual(await client.receiptKeys({ refresh: true }), []);
		assert.equal(requests.length, 2);
	});

	test('client.verifyReceipt fetches the keys once, and again for an unknown key at most once a minute', async () => {
		const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
		const raw = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey));
		const key = { key_id: 'new-key', algorithm: 'Ed25519', public_key: raw.toString('base64') };
		const unsigned = { receipt: 'rcpt_x', format: 1, verdict: 'accepted', score: 100, key_id: 'new-key' };
		const signature = await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(canonicalJson(unsigned)));
		const receipt = { ...unsigned, signature: Buffer.from(signature).toString('base64') };
		mock.timers.enable({ apis: ['Date'], now: Date.now() });
		try {
			reply(200, { keys: [key] });
			assert.equal(await client.verifyReceipt(receipt), true);
			assert.equal(await client.verifyReceipt(receipt), true);
			assert.equal(await client.verifyReceipt({ ...receipt, score: 99 }), false);
			assert.equal(requests.length, 1);
			mock.timers.setTime(Date.now() + 61_000); // a minute later
			reply(200, { keys: [key] });
			assert.equal(await client.verifyReceipt({ ...receipt, key_id: 'rotated-key' }), false);
			assert.equal(requests.length, 2);
			assert.equal(await client.verifyReceipt({ ...receipt, key_id: 'rotated-key' }), false);
			assert.equal(requests.length, 2);
		} finally {
			mock.timers.reset();
		}
	});
});

describe('fix round', () => {
	test('the API key never shows in console.log, util.inspect or JSON.stringify', () => {
		const secretKey = 'oc_live_SECRETKEY123';
		const keyed = new OnlineCompiler({ apiKey: secretKey, baseUrl });
		const out = new PassThrough();
		new Console(out).log(keyed);
		const logged = String(out.read());
		assert.match(logged, /OnlineCompiler/);
		for (const shown of [logged, inspect(keyed), inspect(keyed, { showHidden: true, depth: 5 }),
			inspect(keyed, { customInspect: false, showHidden: true }), JSON.stringify(keyed), String(Object.keys(keyed))]) {
			assert.ok(!shown.includes('SECRETKEY'), shown);
		}
		assert.equal('apiKey' in keyed, false);
	});

	test('no readable environment falls back to the missing-key error', async () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
		const clients = [];
		// As on Deno without --allow-env, where reading process.env throws, and where there is no process at all.
		for (const stand of [{ get env() { throw new Error('PermissionDenied: env access'); } }, undefined]) {
			Object.defineProperty(globalThis, 'process', { value: stand, configurable: true, writable: true });
			try {
				clients.push(new OnlineCompiler({ baseUrl }));
			} finally {
				Object.defineProperty(globalThis, 'process', descriptor);
			}
		}
		for (const keyless of clients) {
			await assert.rejects(keyless.run({ compiler: 'python-3.14', code: 'x' }), (err) => {
				assert.ok(err instanceof AuthenticationError);
				assert.match(err.message, /No API key/);
				return true;
			});
		}
		assert.deepEqual(requests, []);
	});

	test('a replay whose original was refused says to send it again', async () => {
		reply(202, { submission: SUB, status: 'running' });
		reply(404, { error: 'Submission not found' });
		await assert.rejects(client.runTests({ compiler: 'python-3.14', code: 'c', tests: TESTS, idempotency_key: 'k1' }), (err) => {
			assert.ok(err instanceof OnlineCompilerError);
			assert.ok(!(err instanceof NotFoundError));
			assert.match(err.message, /refused/);
			assert.match(err.message, /[Ss]end it again/);
			return true;
		});
	});

	test('the replay wait is bounded by the client timeout', async () => {
		const quick = new OnlineCompiler({ apiKey: 'key-123', baseUrl, timeout: 500 });
		reply(202, { submission: SUB, status: 'running' });
		for (let i = 0; i < 5; i++) reply(200, finished('running'));
		const started = Date.now();
		await assert.rejects(quick.judge(PROB, { compiler: 'python-3.14', code: 'c', idempotency_key: 'k1' }), /still running/);
		assert.ok(Date.now() - started < 2000);
		assert.ok(requests.length <= 2);
	});

	test('a cut-off reply is a transport error', async () => {
		reply(200, new Truncated('{"output": "hi"'));
		await assert.rejects(client.run({ compiler: 'python-3.14', code: 'x' }), (err) => {
			assert.ok(err instanceof OnlineCompilerError);
			assert.equal(err.status, 0);
			assert.match(err.message, /Could not reach/);
			return true;
		});
	});

	test('a cut-off session reply carries no token anywhere', async () => {
		reply(201, new Truncated(`{"session": "pss_x", "token": "${TOKEN}"`));
		await assert.rejects(client.createSession('sum', { external_ref: 'attempt-7' }), (err) => {
			assert.ok(err instanceof OnlineCompilerError);
			const shown = String(err) + err.stack + inspect(err, { depth: 10, showHidden: true });
			assert.ok(!shown.includes('T0k3n'));
			assert.equal(err.cause, undefined);
			return true;
		});
	});

	test('receipt keys are copies', async () => {
		const keys = [{ key_id: 'oc-2026-11', algorithm: 'Ed25519', public_key: Buffer.alloc(32, 7).toString('base64') }];
		reply(200, { keys });
		const first = await client.receiptKeys();
		first[0].key_id = 'changed';
		first.push({ key_id: 'added' });
		assert.deepEqual(await client.receiptKeys(), keys);
		assert.equal(requests.length, 1);
	});

	test('an idempotency_key the API would refuse is refused before any request', async () => {
		for (const bad of ['', 'x'.repeat(101), 'caf\u00e9', 'line\nbreak', 'tab\there', '\x7f', 5]) {
			await assert.rejects(client.runTests({ compiler: 'python-3.14', code: 'c', tests: TESTS, idempotency_key: bad }),
				(err) => err instanceof TypeError && /1 to 100 printable ASCII characters/.test(err.message));
			await assert.rejects(client.judge('sum', { compiler: 'python-3.14', code: 'c', idempotency_key: bad }), TypeError);
		}
		assert.deepEqual(requests, []);
		for (const good of ['x'.repeat(100), 'attempt 42 ~']) {
			reply(202, { submission: SUB, status: 'queued' });
			await client.runTests({ compiler: 'python-3.14', code: 'c', tests: TESTS, async: true, idempotency_key: good });
			assert.equal(sent().headers['idempotency-key'], good);
		}
	});

	test('client.verifyReceipt of null is false without a request', async () => {
		assert.equal(await client.verifyReceipt(null), false);
		assert.equal(await client.verifyReceipt(undefined), false);
		assert.deepEqual(requests, []);
	});
});

const SUITE_FILES = [
	{ name: 'calculator.py', content: 'def add(a, b):\n    return a + b\n' },
	{ name: 'tests/test_calculator.py', content: 'from calculator import add\n\ndef test_add():\n    assert add(2, 3) == 5\n' }
];
const SUITE_RESULT = {
	verdict: 'failed', gradable: true, passed: 1, failed: 1, errors: 0, skipped: 0, total: 2, score: 50,
	tests: [
		{ name: 'test_add', classname: 'tests.test_calculator', file: null, status: 'passed', time: 0.001, message: null, score: null, max_score: null },
		{ name: 'test_add_negative', classname: 'tests.test_calculator', file: null, status: 'failed', time: 0.002,
			message: 'AssertionError: assert -1 == -2', score: null, max_score: null }
	],
	run: { exit_code: 1, signal: null, time: 1.42, memory: 61234, output: '1 failed, 1 passed', error: '', truncated: false },
	compiler: 'python-3.14-tests', preset: 'pytest', pack: { version: '1.0' }, report_truncated: false,
	time_limit: 20, memory_limit: 512, summary: '1 of 2 tests passed.'
};
const SUITE_RECEIPT = {
	receipt: 'rcpt_s', format: 1, submission: SUB, account: 'acct_1', external_ref: null, issued: '2026-11-11T09:00:00Z',
	compiler: { id: 'python-3.14-tests', version: '3.14-1.0-b1', image: null },
	suite: { preset: 'pytest', command_sha256: 'a'.repeat(64), pack_version: '1.0' }, files_sha256: 'b'.repeat(64),
	settings: { time_limit: 20, memory_limit: 512 }, verdict: 'failed', score: 50, passed: 1, total: 2,
	tests: [{ status: 'passed' }, { status: 'failed' }], key_id: 'oc-2026-11', signature: 'c2ln'
};

describe('suites', () => {
	test('runSuite posts the suite and files to run-tests and returns the named results', async () => {
		reply(200, { ...SUITE_RESULT, submission: SUB, receipt: SUITE_RECEIPT });
		const result = await client.runSuite({ compiler: 'python-3.14-tests', suite: { preset: 'pytest' }, files: SUITE_FILES });
		assert.deepEqual([sent().method, sent().path], ['POST', '/api/run-tests/']);
		assert.equal(sent().headers.authorization, 'key-123');
		assert.equal(sent().headers['idempotency-key'], undefined);
		assert.deepEqual(sent().body, { compiler: 'python-3.14-tests', files: SUITE_FILES, suite: { preset: 'pytest' } });
		assert.deepEqual(result, { ...SUITE_RESULT, submission: SUB, receipt: SUITE_RECEIPT });
		assert.deepEqual(result.tests.map((t) => [t.name, t.status]), [['test_add', 'passed'], ['test_add_negative', 'failed']]);
	});

	test('an empty suite runs the default preset, and every option given is sent', async () => {
		reply(200, { ...SUITE_RESULT, submission: SUB, receipt: null });
		await client.runSuite({ compiler: 'nodejs-24-tests', files: SUITE_FILES });
		assert.deepEqual(sent().body, { compiler: 'nodejs-24-tests', files: SUITE_FILES, suite: {} });
		reply(200, { ...SUITE_RESULT, preset: null, submission: SUB, receipt: null });
		const result = await client.runSuite({
			compiler: 'python-3.14-tests', suite: { command: 'python grade.py' }, files: SUITE_FILES, time_limit: 25,
			memory_limit: 1024, external_ref: 'attempt-3', metadata: { learner: 9 }, idempotency_key: 'attempt-3'
		});
		assert.equal(result.preset, null);
		assert.equal(sent().headers['idempotency-key'], 'attempt-3');
		assert.deepEqual(sent().body, {
			compiler: 'python-3.14-tests', suite: { command: 'python grade.py' }, files: SUITE_FILES, time_limit: 25,
			memory_limit: 1024, external_ref: 'attempt-3', metadata: { learner: 9 }
		});
	});

	test('a null preset beside a command is sent as given', async () => {
		reply(200, { ...SUITE_RESULT, preset: null, submission: SUB, receipt: null });
		await client.runSuite({ compiler: 'python-3.14-tests', suite: { preset: null, command: 'python grade.py' }, files: SUITE_FILES });
		assert.deepEqual(sent().body.suite, { preset: null, command: 'python grade.py' });
	});

	test('services go in the suite, and the receipt signs them', async () => {
		const receipt = { ...SUITE_RECEIPT, suite: { ...SUITE_RECEIPT.suite, services: ['postgresql'] } };
		reply(200, { ...SUITE_RESULT, submission: SUB, receipt });
		const result = await client.runSuite({
			compiler: 'python-3.14-tests', suite: { preset: 'pytest', services: ['postgresql'] }, memory_limit: 1024, files: SUITE_FILES
		});
		assert.deepEqual(sent().body.suite, { preset: 'pytest', services: ['postgresql'] });
		assert.equal(sent().body.memory_limit, 1024);
		assert.deepEqual(result.receipt.suite.services, ['postgresql']);
		reply(400, { error: 'PostgreSQL in a suite needs 32 processes at once: Pro and above (https://onlinecompiler.io/pricing)' });
		await assert.rejects(client.runSuite({ compiler: 'nodejs-24-tests', suite: { services: ['postgresql'] }, files: SUITE_FILES }),
			(err) => err instanceof OnlineCompilerError && err.status === 400 && /Pro and above/.test(err.message));
		assert.deepEqual(sent().body.suite, { services: ['postgresql'] });
	});

	test('what the API would refuse is refused before any request', async () => {
		const files = SUITE_FILES;
		await assert.rejects(client.runSuite({ compiler: 'python-3.14-tests', suite: { preset: 'pytest', command: 'pytest' }, files }),
			(err) => err instanceof TypeError && /preset or command, not both/.test(err.message));
		await assert.rejects(client.runSuite({ compiler: 'python-3.14-tests', files, async: true }),
			(err) => err instanceof TypeError && /synchronous/.test(err.message));
		await assert.rejects(client.runSuite({ compiler: 'python-3.14-tests', files, callback_url: 'https://example.com/hook' }), TypeError);
		await assert.rejects(client.runSuite({ compiler: 'python-3.14-tests', files, idempotency_key: '' }), TypeError);
		assert.deepEqual(requests, []);
	});

	test('a refused suite and a busy runner keep the API message and status', async () => {
		reply(400, { error: 'tests cannot be sent with suite: a suite\'s test command decides its tests' });
		await assert.rejects(client.runSuite({ compiler: 'python-3.14-tests', files: SUITE_FILES }), (err) => {
			assert.ok(err instanceof OnlineCompilerError);
			assert.ok(!(err instanceof RateLimitError));
			assert.equal(err.status, 400);
			assert.match(err.message, /cannot be sent with suite/);
			return true;
		});
		reply(429, { error: 'Too many runs in progress. Please try again shortly.' });
		await assert.rejects(client.runSuite({ compiler: 'python-3.14-tests', files: SUITE_FILES }), (err) => {
			assert.ok(err instanceof RateLimitError);
			assert.equal(err.status, 429);
			assert.match(err.message, /try again shortly/);
			return true;
		});
	});

	test('a replayed suite request still running is waited for', async () => {
		reply(202, { submission: SUB, status: 'running' });
		reply(200, finished('finished', { result: SUITE_RESULT, receipt: SUITE_RECEIPT }));
		const result = await client.runSuite({ compiler: 'python-3.14-tests', files: SUITE_FILES, idempotency_key: 'k1' });
		assert.deepEqual(result, { ...SUITE_RESULT, submission: SUB, receipt: SUITE_RECEIPT });
		assert.deepEqual(requests.slice(1).map((r) => r.path), [`/api/submissions/${SUB}/`]);
	});

	test('compilers passes a test pack\'s pack through', async () => {
		const pack = { version: '1.1', presets: ['jest', 'mocha', 'node-test'], default: 'jest', services: ['postgresql'] };
		reply(200, { compilers: [{ id: 'nodejs-24-tests', name: 'Node.js 24 (tests)', pack }], retired: {} });
		assert.deepEqual((await client.compilers())[0].pack, pack);
	});
});

// Two real runs against api.onlinecompiler.io; each counts toward the key's allowance.
describe('live API', { skip: !process.env.ONLINECOMPILER_API_KEY && 'set ONLINECOMPILER_API_KEY to run' }, () => {
	test('run and runTests', async () => {
		const live = new OnlineCompiler();
		assert.equal((await live.run({ compiler: 'python-3.14', code: 'print(input()[::-1])', input: 'abc' })).output, 'cba\n');
		const result = await live.runTests({
			compiler: 'python-3.14',
			code: 'print(int(input()) * 2)',
			tests: [{ input: '21', expected_output: '42' }]
		});
		assert.equal(result.verdict, 'accepted');
	});
});
