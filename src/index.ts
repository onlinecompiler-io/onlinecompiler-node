// Client for the OnlineCompiler.io code execution API. No dependencies: it uses the global fetch and Web Crypto
// (Node 22.13+, Deno, Bun, Cloudflare Workers). Keep the client on the server: an API key in a browser bundle
// can be copied, and the REST API sends no CORS headers.

import { verifyReceipt, type ReceiptKey } from './verify.js';

export {
	canonicalJson,
	verifyReceipt,
	verifyWebhook,
	type HeadersLike,
	type ReceiptKey,
	type WebhookOptions
} from './verify.js';

export const VERSION = '0.9.0';

const DEFAULT_BASE_URL = 'https://api.onlinecompiler.io';
// Long enough for a 30-second run or a 60-second run-tests request, plus queueing and network time.
const DEFAULT_TIMEOUT_MS = 90_000;
const SIGNUP_URL = 'https://api.onlinecompiler.io/compilers/api-keys/';
const RECEIPT_KEYS_PATH = '/.well-known/receipt-keys.json';
const KEYS_MAX_AGE_MS = 3_600_000; // as long as the API allows the key list to be cached
const KEYS_REFETCH_AFTER_MS = 60_000; // before an unknown key_id fetches the list again
// The API answers 404 both for an unknown API key and for an id that is not the caller's.
const KEY_REFUSED = 'Invalid or inactive API key';
// What the API takes as an Idempotency-Key: 1 to 100 printable ASCII characters, space included.
const IDEMPOTENCY_KEY = /^[\x20-\x7e]{1,100}$/;
const REFUSED_ORIGINAL =
	'The original request with this idempotency_key was refused, so it was not judged. Send it again.';

export type Checker = 'trim' | 'exact' | 'tokens' | 'float' | 'rows' | 'table' | 'table_ordered';
export type Scoring = 'all_or_nothing' | 'percent' | 'weighted';
export type Mode = 'all' | 'samples' | 'tests';

/** A file the program can read from its working directory. */
export interface InputFile {
	name: string;
	content: string;
	/** "utf8" (default) or "base64" for binary files. */
	encoding?: 'utf8' | 'base64';
}

/** A file the program wrote to $OUTPUT_DIR. url is null when the file was not stored. */
export interface OutputFile {
	name: string;
	mime: string;
	size: number;
	content_base64: string;
	url: string | null;
}

export interface RunRequest {
	/** A compiler id such as "python-3.14"; see compilers(). */
	compiler: string;
	code: string;
	/** Standard input. */
	input?: string;
	/** Seconds the run may take, above 0 and at most 30. */
	time_limit?: number;
	files?: InputFile[];
	/** Command-line arguments for the program: up to 32 strings, 4,096 bytes in all. Not for sqlite-3, duckdb-1.5
	 * or erlang-29. */
	args?: string[];
	/** Whole MB, 16 to 2048 (512 when left out): above 512, on Pro and Business, it raises the run's memory; a run whose peak memory is over it ends with exit_code 137. */
	memory_limit?: number;
}

export interface SubmitRequest extends RunRequest {
	/** Echoed back in the callback, up to 8 KB of JSON. */
	extra_params?: Record<string, unknown>;
}

/** time, total (seconds) and memory (KB) are decimal strings, as the API sends them. */
export interface RunResult {
	output: string;
	error: string;
	status: string;
	exit_code: number | null;
	signal: number | null;
	time: string;
	total: string;
	memory: string;
	/** The memory_limit the run was given, if any. */
	memory_limit?: number | null;
	truncated: boolean;
	time_limit: number;
	files: OutputFile[];
	files_truncated: boolean;
}

export interface Case {
	input?: string;
	expected_output: string;
	/** A hidden test's result carries only its verdict. */
	hidden?: boolean;
	/** Used with scoring "weighted". */
	weight?: number;
	/** Command-line arguments for this test's run. */
	args?: string[];
}

/** The judge's own options, on runTests and judge. */
export interface JudgingOptions {
	/** true answers at once with the submission id; get the result with waitForSubmission(), submission() or a
	 * signed webhook. */
	async?: boolean;
	/** Where the signed webhook goes; needs async: true. */
	callback_url?: string;
	/** Your own id for the submission, up to 200 characters, signed into the receipt. Use an opaque id. */
	external_ref?: string;
	/** Any JSON object up to 4 KB; it comes back in lookups and webhooks, never in receipts. */
	metadata?: Record<string, unknown>;
	/** Sent as the Idempotency-Key header: repeating a request with it answers with the original result instead
	 * of running again. 1 to 100 printable ASCII characters (checked before sending). */
	idempotency_key?: string;
}

export interface RunTestsRequest extends JudgingOptions {
	compiler: string;
	code: string;
	tests: Case[];
	/** Seconds per test (default 2). */
	time_limit?: number;
	checker?: Checker;
	tolerance?: number;
	scoring?: Scoring;
	stop_on_failure?: boolean;
	/** Shared by every test. */
	files?: InputFile[];
	/** Whole MB, 16 to 2048 (above 512 on Pro and Business; 512 when left out), for every test. */
	memory_limit?: number;
}

/** A submission to a stored problem: the problem supplies the tests, checker and limits. */
export interface JudgeRequest extends JudgingOptions {
	compiler: string;
	/** The candidate's code; a driver, if the problem has one for the compiler, wraps it. */
	code: string;
	/** "samples" judges only the visible tests. Default "all". */
	mode?: Mode;
	/** 1-based positions of the version's tests to judge (distinct); makes the submission's mode "tests". */
	tests?: number[];
}

/** What a suite runs: a preset of the test pack, or a custom command, never both. {} runs the pack's default
 * preset (pytest on python-3.14-tests, jest on nodejs-24-tests, junit on openjdk-25-tests, xunit on
 * dotnet-csharp-10-tests). */
export interface Suite {
	/** A preset from the pack's presets in compilers(): pytest on python-3.14-tests; jest, mocha or node-test on
	 * nodejs-24-tests; junit on openjdk-25-tests; xunit or nunit on dotnet-csharp-10-tests. Each writes a JUnit XML
	 * report. */
	preset?: string | null;
	/** A custom command, at most 4,000 bytes as UTF-8, run with bash in /sandbox where the files are. It must write
	 * $OUTPUT_DIR/report.xml (JUnit XML) or $OUTPUT_DIR/results.json (Gradescope's shape); report.xml is read when
	 * both exist. */
	command?: string | null;
	/** Services started in the sandbox before the tests: ['postgresql'] on python-3.14-tests and nodejs-24-tests, for
	 * accounts on Pro and above. A fresh PostgreSQL, seeded from the .sql files under db/, with DATABASE_URL and the
	 * PG* variables set. Send memory_limit 1024 or more with it: the server's memory counts in the run's. */
	services?: string[] | null;
}

/** A suite run: a test pack's test command over your files, in one sandbox. It takes no code, tests, checker,
 * scoring or args, and runs synchronously only. */
export interface RunSuiteRequest extends Omit<JudgingOptions, 'async' | 'callback_url'> {
	/** A test pack: python-3.14-tests, nodejs-24-tests, openjdk-25-tests or dotnet-csharp-10-tests (a compiler with
	 * pack in compilers()). */
	compiler: string;
	/** Default {}: the pack's default preset. */
	suite?: Suite;
	/** Every source: the code under test, the tests and any fixtures (up to 20 files, 1 MB in all). On
	 * nodejs-24-tests, files under node_modules/ are refused: the pack provides node_modules. */
	files: InputFile[];
	/** Seconds the whole suite may run, above 0 and at most 30 (default 20). */
	time_limit?: number;
	/** Whole MB, 16 to 2048 (above 512 on Pro and Business; 512 when left out). */
	memory_limit?: number;
}

type Async = { async: true };
type Sync = { async?: false; callback_url?: undefined };

/** Hidden and skipped tests carry only verdict and hidden. */
export interface CaseResult {
	verdict: string;
	hidden: boolean;
	time?: string;
	memory?: string;
	exit_code?: number | null;
	signal?: number | null;
	output?: string;
	error?: string;
	truncated?: boolean;
	files?: OutputFile[];
	files_truncated?: boolean;
}

/** A signed receipt (see https://onlinecompiler.io/docs/receipts). A stored problem's receipt has problem in
 * place of tests_sha256 and files_sha256. Check it with verifyReceipt. */
export interface Receipt {
	receipt: string;
	format: number;
	submission: string;
	account: string;
	external_ref: string | null;
	issued: string;
	compiler: { id: string; version: string; image: string | null };
	code_sha256: string;
	tests_sha256?: string;
	files_sha256?: string | null;
	problem?: { id: string; version: number; mode: Mode; tests?: number[]; tests_sha256: string };
	settings: Record<string, unknown>;
	verdict: string;
	score: number;
	passed: number;
	total: number;
	tests: { verdict: string; hidden: boolean; time?: string }[];
	key_id: string;
	signature: string;
	[field: string]: unknown;
}

/** A finished submission's result, as GET /api/submissions/{id}/ and webhooks give it. */
export interface SubmissionResult {
	verdict: string;
	score: number;
	passed: number;
	total: number;
	time_limit: number;
	/** The memory_limit the submission was judged with, if any. */
	memory_limit?: number | null;
	compile_error: string | null;
	tests: CaseResult[];
	/** The result in plain words; hidden tests appear only as counts. */
	summary: string;
	/** Set for a stored problem's submission. */
	problem?: string;
	version?: number;
}

export interface RunTestsResult extends SubmissionResult {
	/** The id this request is stored under. */
	submission: string;
	/** null when no receipt could be signed. */
	receipt: Receipt | null;
}

/** A stored problem's result: the run-tests result with the problem's id and the version judged. */
export interface JudgeResult extends RunTestsResult {
	problem: string;
	version: number;
}

/** A suite's verdict: the run's own problem first (compilation_error, time_limit_exceeded, memory_limit_exceeded,
 * output_limit_exceeded, runtime_error for too many processes, internal_error on our side); then no_report when the
 * command left no readable report; else accepted when the report names at least one test and every test passed,
 * failed otherwise. A non-zero exit alone is no problem: test runners exit 1 when a test fails. */
export type SuiteVerdict =
	| 'accepted'
	| 'failed'
	| 'compilation_error'
	| 'time_limit_exceeded'
	| 'memory_limit_exceeded'
	| 'output_limit_exceeded'
	| 'runtime_error'
	| 'no_report'
	| 'internal_error';

/** One test as the suite's report gave it, in report order. */
export interface SuiteTestResult {
	/** At most 500 characters, as are classname and file. */
	name: string;
	/** Its class, module or describe block, as the report names it. */
	classname: string | null;
	/** The file the report names, passed through as given. */
	file: string | null;
	status: 'passed' | 'failed' | 'error' | 'skipped';
	/** Seconds, as the report gave them. */
	time: number | null;
	/** The failure, error or skip message, or a results.json test's output; at most 4,096 characters. */
	message: string | null;
	/** A results.json test's score and max_score; null otherwise. */
	score: number | null;
	max_score: number | null;
}

/** The suite's run itself: the test command's exit, and its stdout and stderr cut to 4,096 characters. Unlike
 * run()'s result, time (seconds) and memory (peak KB) are numbers. */
export interface SuiteRun {
	exit_code: number;
	signal: number | null;
	time: number;
	memory: number;
	output: string;
	error: string;
	/** True when output or error was cut. */
	truncated: boolean;
}

/** A finished suite's result, as GET /api/submissions/{id}/ gives it. */
export interface SuiteResult {
	verdict: SuiteVerdict;
	/** false for no_report and internal_error: there are no results to grade by. */
	gradable: boolean;
	passed: number;
	failed: number;
	errors: number;
	skipped: number;
	/** Tests in the report (at most 1,000 are read). */
	total: number;
	/** 0 to 100: the percentage of tests passed, or for a results.json whose every test has score and max_score,
	 * their scores over their maximums. */
	score: number;
	/** Empty when the run stopped (a run problem as the verdict) or left no report. */
	tests: SuiteTestResult[];
	run: SuiteRun;
	compiler: string;
	/** The preset that ran; null for a custom command. */
	preset: string | null;
	/** The pack's version, which changes only when its frameworks or libraries do. */
	pack: { version: string };
	/** True when the report had more than 1,000 tests. */
	report_truncated: boolean;
	/** The seconds the whole suite could run. */
	time_limit: number;
	/** The memory limit used, in MB. */
	memory_limit: number;
	/** The result in plain words from the counts, never a test's name or message. */
	summary: string;
}

/** A suite's signed receipt: the suite by its preset, its command's hash and the pack's version, the files by
 * hash, and each test's status only (never a test's name or message). Check it with verifyReceipt. */
export interface SuiteReceipt {
	receipt: string;
	format: number;
	submission: string;
	account: string;
	external_ref: string | null;
	issued: string;
	compiler: { id: string; version: string; image: string | null };
	/** services is there only when the suite started any. */
	suite: { preset: string | null; command_sha256: string; pack_version: string; services?: string[] };
	files_sha256: string | null;
	settings: { time_limit: number; memory_limit: number };
	verdict: SuiteVerdict;
	score: number;
	passed: number;
	total: number;
	tests: { status: SuiteTestResult['status'] }[];
	key_id: string;
	signature: string;
	[field: string]: unknown;
}

export interface RunSuiteResult extends SuiteResult {
	/** The id this request is stored under. */
	submission: string;
	/** null when no receipt could be signed. */
	receipt: SuiteReceipt | null;
}

/** An async submission's answer: its id and status ("queued", or the original's status for a replayed
 * Idempotency-Key). */
export interface SubmissionQueued {
	submission: string;
	status: string;
}

/** A submission as its account sees it. failed means it was not judged, and error says why. hash_salt salts the
 * receipt's tests and files hashes. */
export interface Submission {
	submission: string;
	status: 'queued' | 'running' | 'finished' | 'failed';
	created: string;
	finished: string | null;
	external_ref: string | null;
	metadata: Record<string, unknown> | null;
	problem: { id: string; version: number } | null;
	mode: Mode | null;
	rejudge_of: string | null;
	result: SubmissionResult | null;
	receipt: Receipt | null;
	error: string | null;
	checker_log: string | null;
	hash_salt: string;
}

export interface SubmissionDeleted {
	submission: string;
	deleted: true;
}

/** A submission in a list: Submission without result, receipt, checker_log and hash_salt, plus the result's
 * verdict, score, passed and total (null until it has finished). submission(id) gives the rest. */
export interface SubmissionSummary {
	submission: string;
	status: Submission['status'];
	created: string;
	finished: string | null;
	external_ref: string | null;
	metadata: Record<string, unknown> | null;
	problem: { id: string; version: number } | null;
	/** Which tests a stored problem's submission ran; null for run-tests. */
	mode: Mode | null;
	/** The id of the submission this one re-judged, or null. */
	rejudge_of: string | null;
	verdict: string | null;
	score: number | null;
	passed: number | null;
	total: number | null;
	error: string | null;
}

/** What rejudge() sends; give only what you need. */
export interface RejudgeRequest {
	/** A published version number; default the current one. */
	version?: number;
	/** Up to 100 submission ids; default every earlier submission that qualifies. */
	submissions?: string[];
	/** Send the original's callback_url a webhook for each re-judge. Default false. */
	notify?: boolean;
}

export interface RejudgeResult {
	version: number;
	queued: { submission: string; rejudge_of: string }[];
	skipped: { submission: string; reason: string; rejudge?: string }[];
	/** Candidates left for another call. */
	remaining: number;
}

/** A page of submissions, newest first. next_cursor, when not null, fetches the next page. */
export interface SubmissionPage {
	submissions: SubmissionSummary[];
	next_cursor: string | null;
}

/** What submissions() lists; every filter given narrows it. */
export interface SubmissionFilters {
	/** Up to 100 submission ids. */
	ids?: string[] | string;
	external_ref?: string;
	/** A stored problem's id or slug. */
	problem?: string;
	status?: Submission['status'];
	/** An overall verdict, such as "accepted" or "wrong_answer". */
	verdict?: string;
	/** Created at or after: a Date, or ISO 8601 text (UTC when it has no offset). */
	since?: Date | string;
	/** Created before, in the same form as since. */
	until?: Date | string;
	/** Entries a page, 1 to 100 (default 20). */
	limit?: number;
	/** The previous page's next_cursor. */
	cursor?: string;
}

/** A problem's spec or a part of it, sent as given (see https://onlinecompiler.io/docs/problems). */
export type ProblemSpec = Record<string, unknown>;
/** A problem as the API answers it, as a plain object. */
export type ProblemBody = Record<string, any>;

export interface PublishResult {
	problem: string;
	version: number;
	/** "published" at once, or "checking" while the reference check runs. */
	state: 'published' | 'checking';
	warnings?: string[];
	/** With state "checking": the reference check's submission id. */
	check?: string;
}

export interface SessionRequest {
	/** Your opaque reference for the candidate or attempt (the page sees it; never a name or email). */
	external_ref: string;
	metadata?: Record<string, unknown>;
	callback_url?: string;
	/** Seconds the session stays open, 60 to 86,400 (default 3,600). */
	expires_in?: number;
	/** Submits it takes, 1 to 20 (default 1). */
	max_submits?: number;
	/** Whether each Submit's signed receipt is public by link, so the widget can link to it (default true). A
	 * shared receipt shows external_ref and your account reference, never the code, tests or output. */
	share_receipts?: boolean;
}

/** A widget session as its owner sees it, never with its token. */
export interface ProblemSession {
	session: string;
	problem: string;
	version: number;
	external_ref: string;
	metadata: Record<string, unknown> | null;
	callback_url: string;
	max_submits: number;
	share_receipts: boolean;
	submits_used: number;
	expires: string;
	revoked: string | null;
	created: string;
	submissions: string[];
}

/** A new session with its token, which the API shows only this once: render it into the candidate's page as
 * the widget's data-session, and keep it out of logs. */
export interface ProblemSessionCreated extends ProblemSession {
	token: string;
}

export interface Queued {
	status: string;
	id: number;
}

export interface Compiler {
	id: string;
	name: string;
	packages?: { name: string; version: string }[];
	/** Only on a test pack, which runSuite() runs on: its version, its presets, the preset an empty suite runs, and the
	 * services runSuite() can start on it (sorted; empty when it has none). */
	pack?: { version: string; presets: string[]; default: string; services: string[] };
}

export interface Usage {
	month: string;
	submissions: number;
	monthly_limit: number;
	remaining: number;
	resets_at: string;
	submissions_per_minute: number;
	pending_submissions: number;
	running_submissions: number;
	/** The highest memory_limit (MB) this account's runs may send: 512, or 2048 on Pro and Business or with an exam tier. */
	max_memory_mb: number;
	key?: { submissions: number; monthly_limit: number | null; remaining: number | null };
}

/** The API refused or failed a request. status is the HTTP status, or 0 when no response arrived
 * (network error or timeout); body is the parsed error response, if any. */
export class OnlineCompilerError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(message: string, status = 0, body: unknown = undefined, options?: { cause?: unknown }) {
		super(message, options);
		this.name = new.target.name;
		this.status = status;
		this.body = body;
	}
}

/** HTTP 401 or 403, or 404 for the key itself: the API key is missing, unknown, inactive, of the wrong kind, or
 * not allowed from this address, or the account may not make this request (a 403 such as a plan's problem limit;
 * the message says which). */
export class AuthenticationError extends OnlineCompilerError {}

/** HTTP 404 for an id: the submission, problem or session does not exist or is not this account's. */
export class NotFoundError extends OnlineCompilerError {}

/** HTTP 429: the monthly allowance, the per-minute rate, the pending runs or the account's sandboxes
 * are used up. The message says which, and when it is the plan, how to raise it. */
export class RateLimitError extends OnlineCompilerError {}

export interface ClientOptions {
	/** Defaults to the ONLINECOMPILER_API_KEY environment variable. */
	apiKey?: string;
	baseUrl?: string;
	/** Milliseconds before a request is abandoned (default 90,000). */
	timeout?: number;
	/** A fetch implementation, if the global one isn't available or you want to wrap it. */
	fetch?: typeof fetch;
}

export interface WaitOptions {
	/** Milliseconds between lookups (default 2,000). */
	interval?: number;
	/** Milliseconds before giving up (default 600,000). */
	timeout?: number;
}

function apiError(status: number, text: string): OnlineCompilerError {
	let body: unknown;
	let message = text;
	try {
		body = JSON.parse(text);
		if (body && typeof body === 'object' && 'error' in body) message = String(body.error);
	} catch {
		body = undefined;
	}
	message ||= `HTTP ${status}`;
	if (status === 404 && message !== KEY_REFUSED) return new NotFoundError(message, status, body);
	if (status === 401 || status === 403 || status === 404) return new AuthenticationError(message, status, body);
	if (status === 429) return new RateLimitError(message, status, body);
	return new OnlineCompilerError(message, status, body);
}

/** ONLINECOMPILER_API_KEY, or undefined where it cannot be read: no process (a browser or Worker), or an
 * environment that refuses the read (Deno without --allow-env). */
function keyFromEnvironment(): string | undefined {
	try {
		const value: unknown = globalThis.process?.env?.ONLINECOMPILER_API_KEY;
		return typeof value === 'string' && value ? value : undefined;
	} catch {
		return undefined;
	}
}

/** value as one encoded path segment; an id, slug or file name that could not be one is refused before any
 * request. kind names what value is in the message: an id, or a file name. */
function segment(value: unknown, what: string, kind = 'id'): string {
	if (typeof value !== 'string' || value === '' || value === '.' || value === '..') {
		throw new TypeError(`${what} must be a non-empty ${kind}`);
	}
	return encodeURIComponent(value);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The request body without the header-only idempotency_key, and the headers it adds. */
function judging<T extends JudgingOptions>(request: T): [Omit<T, 'idempotency_key'>, Record<string, string>] {
	if (request.callback_url !== undefined && request.async !== true) {
		throw new TypeError('callback_url needs async: true: the result goes to the URL, not into the response');
	}
	const { idempotency_key, ...body } = request;
	if (idempotency_key === undefined) return [body, {}];
	if (typeof idempotency_key !== 'string' || !IDEMPOTENCY_KEY.test(idempotency_key)) {
		throw new TypeError('idempotency_key must be 1 to 100 printable ASCII characters');
	}
	return [body, { 'Idempotency-Key': idempotency_key }];
}

/**
 * A client for the OnlineCompiler.io code execution API. Get a free key at
 * https://api.onlinecompiler.io/compilers/api-keys/. Requests are never retried, since every
 * accepted run counts toward your allowance.
 */
export class OnlineCompiler {
	readonly baseUrl: string;
	readonly timeout: number;
	// Private fields, so that console.log, util.inspect and JSON.stringify never show the key.
	readonly #apiKey: string | undefined;
	readonly #fetch: typeof fetch;
	#keys: Promise<ReceiptKey[]> | undefined;
	#keysFetchedAt = 0;

	constructor(options: ClientOptions = {}) {
		this.#apiKey = options.apiKey ?? keyFromEnvironment();
		this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
		this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
		this.#fetch = options.fetch ?? globalThis.fetch;
	}

	/** What console.log and util.inspect show: never the key. */
	[Symbol.for('nodejs.util.inspect.custom')](_depth: number, options: object, inspect?: (value: unknown, options?: object) => string): string {
		const shown = { baseUrl: this.baseUrl, timeout: this.timeout, apiKey: this.#apiKey ? '(set)' : '(not set)' };
		return `OnlineCompiler ${inspect ? inspect(shown, options) : JSON.stringify(shown)}`;
	}

	/** Run a program and wait for its result: output, error, exit_code, time, memory and any files it wrote. */
	run(request: RunRequest): Promise<RunResult> {
		return this.request('POST', '/api/run-code-sync/', { input: '', ...request });
	}

	/** Judge a program against test cases: an overall verdict, a score, a verdict per test, the submission id and
	 * a signed receipt. Each test counts as one run. With async: true it answers at once with the submission id. */
	runTests(request: RunTestsRequest & Async): Promise<SubmissionQueued>;
	runTests(request: RunTestsRequest & Sync): Promise<RunTestsResult>;
	runTests(request: RunTestsRequest): Promise<RunTestsResult | SubmissionQueued>;
	async runTests(request: RunTestsRequest): Promise<RunTestsResult | SubmissionQueued> {
		const [body, headers] = judging(request);
		const answer = await this.request<RunTestsResult | SubmissionQueued>('POST', '/api/run-tests/', body, { headers });
		return request.async ? answer : this.settled(answer);
	}

	/** Run a test pack's test command over your files in one sandbox: a named result per test from the report it
	 * writes, a score, the run's own output, the submission id and a signed receipt. The whole suite counts as one
	 * run, and runs synchronously only. compiler is a test pack (python-3.14-tests, nodejs-24-tests, openjdk-25-tests
	 * or dotnet-csharp-10-tests); suite is { preset } or { command }, and {} (the default) runs the pack's default
	 * preset; add services: ['postgresql'] for a database in the sandbox. external_ref, metadata and
	 * idempotency_key work as in runTests(). A RateLimitError (429) when no sandbox came free in time counts
	 * nothing, so send it again. */
	async runSuite(request: RunSuiteRequest): Promise<RunSuiteResult> {
		const options = request as RunSuiteRequest & JudgingOptions; // a JavaScript caller may send them anyway
		if (options.async || options.callback_url !== undefined) {
			throw new TypeError('runSuite is synchronous: send it without async or callback_url');
		}
		const { suite = {}, ...rest } = request;
		if (suite.preset != null && suite.command != null) {
			throw new TypeError('suite takes preset or command, not both');
		}
		const [body, headers] = judging({ ...rest, suite });
		const answer = await this.request<RunSuiteResult | SubmissionQueued>('POST', '/api/run-tests/', body, { headers });
		return this.settled(answer);
	}

	/** Queue a run and return at once with its id. The result is POSTed to the callback URL set on
	 * the API key in your dashboard, with extra_params echoed back. */
	submit(request: SubmitRequest): Promise<Queued> {
		return this.request('POST', '/api/run-code/', { input: '', ...request });
	}

	/** A submission of this account: its status, and once it has ended its result and receipt (or error). */
	async submission(id: string): Promise<Submission> {
		return this.request('GET', `/api/submissions/${segment(id, 'id')}/`);
	}

	/** Delete a queued, finished or failed submission and what it kept; a running one is refused with 409. Runs
	 * already counted stay counted. Frees its Idempotency-Key. */
	async deleteSubmission(id: string): Promise<SubmissionDeleted> {
		return this.request('DELETE', `/api/submissions/${segment(id, 'id')}/`);
	}

	/** One page of this account's submissions, newest first; draft tests and reference checks are not listed.
	 * For the next page, pass next_cursor back as cursor with the same filters, or use iterSubmissions(). ids given
	 * alone answers all of them on one page; an empty ids array answers an empty page without a request. */
	async submissions(filters: SubmissionFilters = {}): Promise<SubmissionPage> {
		if (Array.isArray(filters.ids) && filters.ids.length === 0) return { submissions: [], next_cursor: null };
		const query = new URLSearchParams();
		for (const [name, value] of Object.entries(filters)) {
			if (value === undefined || value === null) continue;
			const text = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join(',') : String(value);
			query.set(name, text);
		}
		const text = query.toString();
		return this.request('GET', `/api/submissions/${text ? `?${text}` : ''}`);
	}

	/** Every submission the filters match, newest first, fetching the pages one after another as you go; limit
	 * is the page size. */
	async *iterSubmissions(filters: Omit<SubmissionFilters, 'cursor'> = {}): AsyncGenerator<SubmissionSummary> {
		let cursor: string | undefined;
		do {
			const page = await this.submissions({ ...filters, cursor });
			yield* page.submissions;
			cursor = page.next_cursor ?? undefined;
		} while (cursor !== undefined);
	}

	/** Look the submission up every interval until it is finished or failed, and resolve to it. A failed one has
	 * error and no result. Rejects with an OnlineCompilerError (status 0) if it is still queued or running after
	 * timeout; it is still judged, so look it up again later. */
	async waitForSubmission(id: string, { interval = 2_000, timeout = 600_000 }: WaitOptions = {}): Promise<Submission> {
		const deadline = Date.now() + timeout;
		for (;;) {
			const current = await this.submission(id);
			if (current.status === 'finished' || current.status === 'failed') return current;
			if (Date.now() + interval > deadline) {
				throw new OnlineCompilerError(`Submission ${id} is still ${current.status} after ${timeout} ms`, 0, current);
			}
			await sleep(interval);
		}
	}

	/** Judge code against a stored problem's current version. problem is its id (prob_...) or your slug for it.
	 * The result is the run-tests result with problem and version; async, callback_url, external_ref, metadata and
	 * idempotency_key work as in runTests(). Send async: true for a problem with a custom checker. */
	judge(problem: string, request: JudgeRequest & Async): Promise<SubmissionQueued>;
	judge(problem: string, request: JudgeRequest & Sync): Promise<JudgeResult>;
	judge(problem: string, request: JudgeRequest): Promise<JudgeResult | SubmissionQueued>;
	async judge(problem: string, request: JudgeRequest): Promise<JudgeResult | SubmissionQueued> {
		const path = `/api/problems/${segment(problem, 'problem')}/submissions/`;
		const [body, headers] = judging(request);
		const answer = await this.request<JudgeResult | SubmissionQueued>('POST', path, body, { headers });
		return request.async ? answer : this.settled(answer);
	}

	/** Re-judge earlier submissions against a published version (default the current one): each is queued as a
	 * new async submission with rejudge_of set. At most 100 a call; remaining says how many are left. */
	async rejudge(problem: string, request: RejudgeRequest = {}): Promise<RejudgeResult> {
		const path = `/api/problems/${segment(problem, 'problem')}/rejudge/`;
		const body: RejudgeRequest = {};
		if (request.version !== undefined) body.version = request.version;
		if (request.submissions !== undefined) body.submissions = request.submissions;
		if (request.notify !== undefined) body.notify = request.notify;
		return this.request('POST', path, Object.keys(body).length ? body : undefined);
	}

	/** This account's problems, newest first, without their tests. */
	async problems(): Promise<ProblemBody[]> {
		return (await this.request<{ problems: ProblemBody[] }>('GET', '/api/problems/')).problems;
	}

	/** A problem by id or slug, with its draft and current version in full, hidden tests included. */
	async problem(problem: string): Promise<ProblemBody> {
		return this.request('GET', `/api/problems/${segment(problem, 'problem')}/`);
	}

	/** Create a problem from a title, an optional slug and public flag, and its first draft's fields (tests,
	 * statement, checker, drivers, reference_solution...), sent as given. */
	createProblem(spec: ProblemSpec): Promise<ProblemBody> {
		return this.request('POST', '/api/problems/', spec);
	}

	/** Change a problem's title, slug or public flag. */
	async updateProblem(problem: string, fields: ProblemSpec): Promise<ProblemBody> {
		return this.request('PATCH', `/api/problems/${segment(problem, 'problem')}/`, fields);
	}

	/** Replace the problem's draft with these fields (as createProblem takes, without title). */
	async replaceDraft(problem: string, draft: ProblemSpec): Promise<ProblemBody> {
		return this.request('PUT', `/api/problems/${segment(problem, 'problem')}/draft/`, draft);
	}

	/** Put one data file (a database, a CSV, any bytes) on the draft, as its raw bytes: a string is sent as UTF-8,
	 * a Uint8Array as is. The name is one path segment (no slashes). Answers the changed problem. */
	async putDraftFile(problem: string, name: string, data: Uint8Array | string): Promise<ProblemBody> {
		if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
			throw new TypeError('data must be a string or a Uint8Array');
		}
		const path = `/api/problems/${segment(problem, 'problem')}/draft/files/${segment(name, 'name', 'file name')}/`;
		return this.request('PUT', path, undefined, { raw: { data, contentType: 'application/octet-stream' } });
	}

	/** Remove one data file from the draft. Answers the changed problem; a missing file is a NotFoundError. */
	async deleteDraftFile(problem: string, name: string): Promise<ProblemBody> {
		return this.request('DELETE', `/api/problems/${segment(problem, 'problem')}/draft/files/${segment(name, 'name', 'file name')}/`);
	}

	/** Publish the draft as the next version: at once without a reference solution (state "published"), else once
	 * its reference check passes (state "checking"; problem() shows how the check went). */
	async publishProblem(problem: string): Promise<PublishResult> {
		return this.request('POST', `/api/problems/${segment(problem, 'problem')}/publish/`);
	}

	/** Stop new submissions and free a problem slot. */
	async archiveProblem(problem: string): Promise<ProblemBody> {
		return this.request('POST', `/api/problems/${segment(problem, 'problem')}/archive/`);
	}

	/** Undo archiveProblem, if the plan has a free problem slot. */
	async restoreProblem(problem: string): Promise<ProblemBody> {
		return this.request('POST', `/api/problems/${segment(problem, 'problem')}/restore/`);
	}

	/** The current version as a candidate sees it: statement, languages, starter code and the visible tests. A
	 * public problem answers by id with no API key; the key, when the client has one, also shows your own private
	 * problems and works with a slug. */
	async publicProblem(problem: string): Promise<ProblemBody> {
		return this.request('GET', `/api/problems/${segment(problem, 'problem')}/public/`, undefined, { auth: Boolean(this.#apiKey) });
	}

	/** Let one candidate's widget Submit to a problem's current version. Resolves to the session with its token,
	 * shown only this once: render it into the candidate's page as data-session and keep it out of logs. */
	async createSession(problem: string, request: SessionRequest): Promise<ProblemSessionCreated> {
		return this.request('POST', `/api/problems/${segment(problem, 'problem')}/sessions/`, request, { secret: true });
	}

	/** A session: its Submits used, expiry and the ids of its submissions. Never the token. */
	async session(problem: string, id: string): Promise<ProblemSession> {
		return this.request('GET', this.sessionPath(problem, id));
	}

	/** End a session now: its next Submit is refused. Submissions already made are judged as usual. */
	async revokeSession(problem: string, id: string): Promise<ProblemSession> {
		return this.request('DELETE', this.sessionPath(problem, id));
	}

	/** The published receipt signing keys. Needs no API key. Kept on the client for an hour; refresh: true
	 * fetches them again. */
	async receiptKeys({ refresh = false }: { refresh?: boolean } = {}): Promise<ReceiptKey[]> {
		if (refresh || !this.#keys || Date.now() - this.#keysFetchedAt > KEYS_MAX_AGE_MS) {
			this.#keysFetchedAt = Date.now();
			const keys = this.request<{ keys: ReceiptKey[] }>('GET', RECEIPT_KEYS_PATH, undefined, { auth: false }).then(
				(body) => body.keys
			);
			this.#keys = keys;
			keys.catch(() => {
				if (this.#keys === keys) this.#keys = undefined; // a failed fetch is not kept
			});
		}
		return (await this.#keys).map((key) => ({ ...key })); // copies, so that changing them leaves the cache alone
	}

	/** Whether a receipt's signature is valid, against the published keys (fetched once and kept; fetched again,
	 * at most once a minute, for a key_id they lack). null (a submission without a receipt) is false, with no
	 * request. See verifyReceipt to verify with keys you already hold. */
	async verifyReceipt(receipt: Receipt | Record<string, unknown> | null | undefined): Promise<boolean> {
		if (receipt === null || typeof receipt !== 'object') return false;
		let keys = await this.receiptKeys();
		if (!keys.some((key) => key.key_id === receipt.key_id) && Date.now() - this.#keysFetchedAt > KEYS_REFETCH_AFTER_MS) {
			keys = await this.receiptKeys({ refresh: true });
		}
		return verifyReceipt(receipt, keys);
	}

	/** Every compiler id and its language name, with pack on a test pack. Needs no API key. */
	async compilers(): Promise<Compiler[]> {
		const body = await this.request<{ compilers: Compiler[] }>('GET', '/api/compilers/', undefined, { auth: false });
		return body.compilers;
	}

	/** This month's runs and remaining allowance for the account, and for the key itself. */
	usage(): Promise<Usage> {
		return this.request('GET', '/api/usage/');
	}

	/** Per-run limits (memory, time, output) and default account limits. Needs no API key. */
	limits(): Promise<Record<string, number>> {
		return this.request('GET', '/api/limits/', undefined, { auth: false });
	}

	private sessionPath(problem: string, id: string): string {
		return `/api/problems/${segment(problem, 'problem')}/sessions/${segment(id, 'id')}/`;
	}

	/** A sync judging answer. A retry whose Idempotency-Key finds the original still running answers 202 with its
	 * id; wait for it and answer as the original would have. */
	private async settled<T extends RunTestsResult | RunSuiteResult>(answer: T | SubmissionQueued): Promise<T> {
		if ('verdict' in answer || !('submission' in answer)) return answer as T;
		let done: Submission;
		try {
			// Bounded by the client's own timeout: the original was a sync request, which ends well within it.
			done = await this.waitForSubmission(answer.submission, { interval: 1_000, timeout: this.timeout });
		} catch (error) {
			// The 202 named a submission that was then refused (a 400 or 429 leaves none behind).
			if (error instanceof NotFoundError) throw new OnlineCompilerError(REFUSED_ORIGINAL, error.status, error.body);
			throw error;
		}
		if (done.status !== 'finished' || !done.result) {
			throw new OnlineCompilerError(done.error || `Submission ${done.submission} was not judged`, 202, done);
		}
		return { ...done.result, submission: done.submission, receipt: done.receipt } as T;
	}

	/** auth: send the key (default true). secret: the answer holds a secret (a session token), so no error
	 * quotes it. */
	private async request<T>(
		method: string,
		path: string,
		body?: object,
		{
			auth = true,
			headers: extra = {},
			secret = false,
			raw
		}: {
			auth?: boolean;
			headers?: Record<string, string>;
			secret?: boolean;
			/** A body sent as is, with its own Content-Type, instead of JSON. */
			raw?: { data: Uint8Array | string; contentType: string };
		} = {}
	): Promise<T> {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			'User-Agent': `onlinecompiler-node/${VERSION}`,
			...extra
		};
		if (auth) {
			if (!this.#apiKey) {
				throw new AuthenticationError(
					`No API key: pass apiKey or set ONLINECOMPILER_API_KEY. Get a free key at ${SIGNUP_URL}`
				);
			}
			headers.Authorization = this.#apiKey;
		}
		if (raw) headers['Content-Type'] = raw.contentType;
		else if (body !== undefined) headers['Content-Type'] = 'application/json';

		let response: Response;
		let text: string;
		try {
			response = await this.#fetch(this.baseUrl + path, {
				method,
				headers,
				body: raw ? (raw.data as BodyInit) : body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeout)
			});
			text = await response.text();
		} catch (cause) {
			if (secret) {
				// The cause of a reply cut off mid-body may hold part of it, so the secret's kind of reply keeps none.
				const kind = (cause as { name?: unknown } | null)?.name;
				throw new OnlineCompilerError(`Could not reach ${this.baseUrl}: ${typeof kind === 'string' ? kind : 'Error'}`, 0);
			}
			throw new OnlineCompilerError(`Could not reach ${this.baseUrl}: ${String(cause)}`, 0, undefined, { cause });
		}
		if (!response.ok) throw apiError(response.status, text);
		try {
			return JSON.parse(text) as T;
		} catch {
			const shown = secret ? '' : `, got: ${text.slice(0, 200)}`;
			throw new OnlineCompilerError(`Expected JSON from ${path}${shown}`, response.status);
		}
	}
}
