// The Vercel AI SDK tools against the real `ai` package and a stand-in fetch, so no network or key is needed.
// Run with: npm test
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { onlinecompilerTools, runCode, runTests } from '../dist/ai-sdk.js';
import { OnlineCompiler } from '../dist/index.js';

const RUN = {
	output: '102334155\n', error: '', status: 'success', exit_code: 0, signal: null, time: '0.02', total: '0.03',
	memory: '9000', truncated: false, time_limit: 30, files_truncated: false,
	files: [{ name: 'plot.png', mime: 'image/png', size: 9, content_base64: 'iVBORw0K', url: 'https://x/f/1' }]
};
const JUDGED = {
	submission: 'sub_' + 'a'.repeat(24), verdict: 'wrong_answer', score: 50, passed: 1, total: 2, time_limit: 2,
	compile_error: null, summary: '1 of 2 tests passed', receipt: { signature: 'x'.repeat(200) },
	tests: [
		{ verdict: 'accepted', hidden: false, time: '0.01', output: '3\n', error: '', exit_code: 0, files: [] },
		{ verdict: 'wrong_answer', hidden: false, time: '0.01', output: '31\n', error: '', exit_code: 0, files: [] }
	]
};

// A client whose fetch answers with body and records what was sent.
function stubbed(body) {
	const sent = [];
	const fetch = async (url, init) => {
		sent.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
		return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
	};
	return { client: new OnlineCompiler({ apiKey: 'test-key', fetch }), sent };
}

const call = { toolCallId: 'call-1', messages: [] };

describe('runCode', () => {
	test('runs the program and gives the model a small result', async () => {
		const { client, sent } = stubbed(RUN);
		const result = await runCode({ client }).execute({ compiler: 'python-3.14', code: 'print(1)' }, call);
		assert.equal(sent[0].url, 'https://api.onlinecompiler.io/api/run-code-sync/');
		assert.deepEqual(sent[0].body, { input: '', compiler: 'python-3.14', code: 'print(1)' });
		assert.equal(result.output, '102334155\n');
		assert.equal(result.exit_code, 0);
		assert.deepEqual(result.files, [{ name: 'plot.png', mime: 'image/png', size: 9, url: 'https://x/f/1' }]);
		assert.ok(!JSON.stringify(result).includes('content_base64'));
	});

	test('its input schema names compiler and code as required', async () => {
		const schema = await runCode({ client: stubbed(RUN).client }).inputSchema.jsonSchema;
		assert.deepEqual(schema.required, ['compiler', 'code']);
		assert.match(schema.properties.compiler.description, /python-3\.14/);
	});
});

describe('runTests', () => {
	test('judges against the tests and leaves the receipt out', async () => {
		const { client, sent } = stubbed(JUDGED);
		const tests = [{ input: '1 2', expected_output: '3' }, { input: '10 21', expected_output: '31' }];
		const result = await runTests({ client }).execute({ compiler: 'python-3.14', code: 'x', tests, checker: 'tokens' }, call);
		assert.equal(sent[0].url, 'https://api.onlinecompiler.io/api/run-tests/');
		assert.deepEqual(sent[0].body, { compiler: 'python-3.14', code: 'x', tests, checker: 'tokens' });
		assert.equal(result.verdict, 'wrong_answer');
		assert.equal(result.score, 50);
		assert.deepEqual(result.tests[1], { verdict: 'wrong_answer', output: '31\n', error: '', time: '0.01' });
		assert.equal(result.submission, JUDGED.submission);
		assert.ok(!('receipt' in result));
	});
});

describe('with generateText', () => {
	test('a model that calls runCode gets the run result back', async () => {
		const { client, sent } = stubbed(RUN);
		let step = 0;
		const usage = {
			inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: 1, text: 1, reasoning: 0 }
		};
		const model = new MockLanguageModelV4({
			doGenerate: async () => {
				step += 1;
				if (step === 1) {
					return {
						content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'runCode',
							input: JSON.stringify({ compiler: 'python-3.14', code: 'print(fib(40))' }) }],
						finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: []
					};
				}
				return { content: [{ type: 'text', text: 'It is 102334155.' }],
					finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
			}
		});
		const result = await generateText({
			model, prompt: 'What is the 40th Fibonacci number?', tools: onlinecompilerTools({ client }),
			stopWhen: stepCountIs(3)
		});
		assert.equal(result.text, 'It is 102334155.');
		assert.equal(sent.length, 1);
		const toolResult = result.steps[0].toolResults[0];
		assert.equal(toolResult.toolName, 'runCode');
		assert.equal(toolResult.output.output, '102334155\n');
	});
});
