/**
 * Tools for the Vercel AI SDK (`ai`, version 5 or later): let a model run code, or judge code against tests, in
 * the OnlineCompiler.io sandbox.
 *
 *   import { generateText, stepCountIs } from 'ai';
 *   import { onlinecompilerTools } from 'onlinecompiler/ai-sdk';
 *
 *   const { text } = await generateText({
 *     model: 'openai/gpt-5-mini',
 *     tools: onlinecompilerTools(), // reads ONLINECOMPILER_API_KEY
 *     stopWhen: stepCountIs(5),
 *     prompt: 'What is the 40th Fibonacci number? Compute it.',
 *   });
 *
 * Each run, and each test of runTests, counts toward your API key's allowance. What the model gets back is the
 * result without the bulky parts (file contents, the receipt), so it stays small in the model's context.
 */
import { jsonSchema, type Tool, tool } from 'ai';

import { type Checker, type ClientOptions, OnlineCompiler, type RunResult, type RunTestsResult } from './index.js';

export interface OnlineCompilerToolOptions extends ClientOptions {
	/** A client to use instead of making one from apiKey, baseUrl, timeout and fetch. */
	client?: OnlineCompiler;
}

export interface RunCodeInput {
	compiler: string;
	code: string;
	input?: string;
}

export interface RunTestsInput {
	compiler: string;
	code: string;
	tests: { input?: string; expected_output: string }[];
	checker?: Checker;
	tolerance?: number;
	time_limit?: number;
}

/** What runCode gives the model: the run's result, files by name and link only. */
export interface RunCodeOutput {
	status: string;
	exit_code: number | null;
	output: string;
	error: string;
	time: string;
	memory: string;
	truncated: boolean;
	files: { name: string; mime: string; size: number; url: string | null }[];
}

/** What runTests gives the model: the verdicts and score, without the receipt. */
export interface RunTestsOutput {
	verdict: string;
	score: number;
	passed: number;
	total: number;
	compile_error: string | null;
	summary: string;
	tests: { verdict: string; output?: string; error?: string; time?: string }[];
	submission: string;
}

const COMPILER = {
	type: 'string',
	description:
		'The compiler id, for example python-3.14, nodejs-24, typescript-deno, gcc-15, g++-15, openjdk-25, go-1.26, ' +
		'rust-1.93, dotnet-csharp-10, php-8.5, ruby-4.0, bash-5.2 or sqlite-3. All 46: https://onlinecompiler.io/docs/compilers',
} as const;

const CODE = { type: 'string', description: 'The whole program, as one source file.' } as const;

function clientFor(options: OnlineCompilerToolOptions): OnlineCompiler {
	return options.client ?? new OnlineCompiler(options);
}

function runOutput(result: RunResult): RunCodeOutput {
	return {
		status: result.status,
		exit_code: result.exit_code,
		output: result.output,
		error: result.error,
		time: result.time,
		memory: result.memory,
		truncated: result.truncated,
		files: (result.files ?? []).map(({ name, mime, size, url }) => ({ name, mime, size, url })),
	};
}

function testsOutput(result: RunTestsResult): RunTestsOutput {
	return {
		verdict: result.verdict,
		score: result.score,
		passed: result.passed,
		total: result.total,
		compile_error: result.compile_error,
		summary: result.summary,
		tests: result.tests.map(({ verdict, output, error, time }) => ({ verdict, output, error, time })),
		submission: result.submission,
	};
}

/** A tool that runs a program in the sandbox and returns its output, errors, exit code, time and memory. */
export function runCode(options: OnlineCompilerToolOptions = {}): Tool<RunCodeInput, RunCodeOutput> {
	const client = clientFor(options);
	return tool({
		description:
			'Run a program in a sandbox (no network, up to 30 seconds, 512 MB) and get its standard output, standard ' +
			'error, exit code, time and memory. Use it to compute answers or check code instead of guessing. Exit ' +
			'code 124 means it ran out of time. Files the program writes to $OUTPUT_DIR come back as links.',
		inputSchema: jsonSchema<RunCodeInput>({
			type: 'object',
			properties: {
				compiler: COMPILER,
				code: CODE,
				input: { type: 'string', description: 'Standard input for the program. Optional.' },
			},
			required: ['compiler', 'code'],
			additionalProperties: false,
		}),
		execute: async ({ compiler, code, input }): Promise<RunCodeOutput> =>
			runOutput(await client.run({ compiler, code, input: input ?? '' })),
	});
}

/** A tool that judges a program against test cases: a verdict per test, an overall verdict and a score. */
export function runTests(options: OnlineCompilerToolOptions = {}): Tool<RunTestsInput, RunTestsOutput> {
	const client = clientFor(options);
	return tool({
		description:
			'Judge a program against test cases in a sandbox: each test gives the program its input and compares the ' +
			'output with expected_output. Returns an overall verdict (accepted, wrong_answer, time_limit_exceeded, ' +
			'runtime_error, compilation_error...), a score from 0 to 100 and a verdict per test. Each test counts as ' +
			'one run.',
		inputSchema: jsonSchema<RunTestsInput>({
			type: 'object',
			properties: {
				compiler: COMPILER,
				code: CODE,
				tests: {
					type: 'array',
					minItems: 1,
					items: {
						type: 'object',
						properties: {
							input: { type: 'string', description: 'Standard input for this test.' },
							expected_output: { type: 'string', description: 'The output a correct program prints.' },
						},
						required: ['expected_output'],
						additionalProperties: false,
					},
				},
				checker: {
					type: 'string',
					enum: ['trim', 'exact', 'tokens', 'float', 'rows', 'table', 'table_ordered'],
					description:
						'How output is compared: trim ignores trailing whitespace (default), exact is byte for byte, tokens ' +
						'ignores all whitespace differences, float compares numbers within tolerance, rows ignores line order, ' +
						'table compares CSV tables with a header row by column name, rows in any order (print df.to_csv()), ' +
						'and table_ordered does the same with rows in order.',
				},
				tolerance: {
					type: 'number',
					minimum: 0,
					maximum: 1,
					description: 'For checkers float, rows, table and table_ordered: the largest allowed difference, from 0 to 1.'
				},
				time_limit: {
					type: 'number',
					exclusiveMinimum: 0,
					maximum: 30,
					description: 'Seconds each test may take (default 2, at most 30).'
				},
			},
			required: ['compiler', 'code', 'tests'],
			additionalProperties: false,
		}),
		execute: async ({ compiler, code, tests, checker, tolerance, time_limit }): Promise<RunTestsOutput> => {
			const result = await client.runTests({ compiler, code, tests, checker, tolerance, time_limit });
			return testsOutput(result);
		},
	});
}

/** Both tools, sharing one client: `tools: onlinecompilerTools()`. */
export function onlinecompilerTools(options: OnlineCompilerToolOptions = {}): {
	runCode: Tool<RunCodeInput, RunCodeOutput>;
	runTests: Tool<RunTestsInput, RunTestsOutput>;
} {
	const client = clientFor(options);
	return { runCode: runCode({ client }), runTests: runTests({ client }) };
}
