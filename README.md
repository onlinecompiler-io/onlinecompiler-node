# OnlineCompiler.io Node.js client

Run code in 46 languages from JavaScript or TypeScript, or judge it against test cases, through the
[OnlineCompiler.io](https://onlinecompiler.io/?utm_source=npm) code execution API. Every run gets a
fresh gVisor sandbox with no network, 512 MB of memory and a 30-second limit. Free up to 100,000 runs
a month, commercial use included.

No dependencies: it uses the global `fetch` and Web Crypto, so it works on Node 22.13+, Deno, Bun and
Cloudflare Workers. Types are included.

```bash
npm install onlinecompiler
```

Get a free API key at https://api.onlinecompiler.io/compilers/api-keys/ and set it as
`ONLINECOMPILER_API_KEY`, or pass it to the client. Use the client on your server: a key in a browser
bundle can be copied. To run code in the browser, use the
[embeddable editor](https://onlinecompiler.io/embeddable-code-editor?utm_source=npm), whose keys can be
restricted to your domain.

## Run a program

```js
import { OnlineCompiler } from 'onlinecompiler';

const client = new OnlineCompiler(); // reads ONLINECOMPILER_API_KEY

const result = await client.run({
  compiler: 'python-3.14',
  code: "name = input()\nprint(f'Hello, {name}!')",
  input: 'Ada',
});
console.log(result.output); // Hello, Ada!
console.log(result.exit_code, result.time, result.memory);
```

The result has `output` (stdout), `error` (stderr or compiler errors), `exit_code`, `signal`, `time`
and `total` (seconds), `memory` (KB), `truncated`, `time_limit` and `files`. `time`, `total` and
`memory` are decimal strings, as the API sends them. Compiler ids such as `gcc-15`, `openjdk-25` and
`nodejs-24` come from `client.compilers()`. Pass `time_limit` (seconds, up to 30) to stop a run sooner.
Pass `args` (up to 32 strings) to give the program command-line arguments, and `memory_limit` (whole MB,
16 to 512) to end a run whose peak memory is over it with exit code 137. Both also work on `submit()`;
in `runTests()` `args` goes on each test and `memory_limit` applies to all of them. `sqlite-3`,
`duckdb-1.5` and `erlang-29` take no arguments.
Request and response fields use the API's own snake_case names, so the
[API docs](https://onlinecompiler.io/docs?utm_source=npm) apply as written.

## Judge a solution against test cases

```js
const result = await client.runTests({
  compiler: 'python-3.14',
  code: 'a, b = map(int, input().split())\nprint(a + b)',
  tests: [
    { input: '1 2', expected_output: '3' },
    { input: '10 20', expected_output: '30', hidden: true },
  ],
});
console.log(result.verdict, result.score, `${result.passed}/${result.total}`);
for (const test of result.tests) console.log(test.verdict);
```

Each test counts as one run. Hidden tests return only their verdict. `checker` picks how output is
compared (`trim` by default, `exact`, `tokens`, `float` or `rows`), `scoring` is `all_or_nothing`
(default), `percent` or `weighted` (with a `weight` per test), and `time_limit` is seconds per test
(default 2). See the [run-tests docs](https://onlinecompiler.io/docs/run-tests?utm_source=npm).

Every run-tests result also has `summary` (the result in plain words), `submission` (its id) and a
signed `receipt`.

## Judge in the background

```js
const queued = await client.runTests({
  compiler: 'python-3.14',
  code: 'a, b = map(int, input().split())\nprint(a + b)',
  tests: [{ input: '1 2', expected_output: '3' }, { input: '10 20', expected_output: '30', hidden: true }],
  async: true,
  external_ref: 'attempt-4821',
  idempotency_key: 'attempt-4821',
});
const done = await client.waitForSubmission(queued.submission); // looks it up every 2 seconds
if (done.result) console.log(done.result.verdict, done.result.score); // null when it failed: not judged
else console.log('Not judged:', done.error); // send it again
await client.deleteSubmission(done.submission); // optional: drop the stored code and output
```

`async: true` answers at once with the submission id, and the submission waits in your account's queue
instead of getting 429 in a burst. Add `callback_url` to have the result POSTed to your server as a
signed webhook (see below); it needs `async: true`, and the client refuses it without. `external_ref` is
your own id, signed into the receipt; `metadata` is any JSON object, returned in lookups and webhooks.
`idempotency_key` (1 to 100 printable ASCII characters, checked before sending) is sent as the
`Idempotency-Key` header, so a retry after a timeout answers with the original result instead of running
again. `client.submission(id)` looks a submission up once.

## List submissions

```js
for await (const entry of client.iterSubmissions({ external_ref: 'candidate-8841' })) {
  console.log(entry.submission, entry.status, entry.verdict, entry.score);
}

const filters = { problem: 'sum-two', verdict: 'accepted', since: '2026-11-01', limit: 50 };
const page = await client.submissions(filters);
if (page.next_cursor) await client.submissions({ ...filters, cursor: page.next_cursor });
```

`client.submissions()` resolves to one page of your submissions, newest first, filtered by `ids`,
`external_ref`, `problem` (id or slug), `status`, `verdict`, `since` (included) and `until` (not included).
`since` and `until` take a `Date` or ISO 8601 text (UTC when it has no offset). Each entry has the verdict,
score and tests passed, but not the tests or receipt: `client.submission(id)` has those.
`client.iterSubmissions()` fetches page after page for you. With `ids` alone, every id comes back on one
page. Draft tests, reference checks and Submits under a test session made in the dashboard are not listed.

## Judge against a stored problem

A stored problem keeps its tests, checker and limits on the server, so you send only the candidate's
code and the hidden tests never leave it.

```js
await client.createProblem({
  title: 'Sum of two numbers',
  slug: 'sum',
  languages: ['python-3.14'],
  tests: [
    { name: 'sample', input: '1 2\n', expected_output: '3\n', hidden: false },
    { input: '5 7\n', expected_output: '12\n' }, // tests are hidden unless you say otherwise
  ],
});
await client.publishProblem('sum'); // no reference solution, so it is published at once

const result = await client.judge('sum', {
  compiler: 'python-3.14',
  code: 'a, b = map(int, input().split())\nprint(a + b)',
});
console.log(result.verdict, result.score, result.problem, result.version);
```

Send `tests: [1, 3]` (1-based positions) to judge only those tests; the submission's mode becomes
`'tests'`. Stored-problem lookups and lists show `mode` and `rejudge_of`.

`judge` takes the problem's id (`prob_...`) or your slug for it. `mode: 'samples'` judges only the
visible tests, and `async`, `callback_url`, `external_ref`, `metadata` and `idempotency_key` work as
above. Problems are plain objects, as the
[stored problems docs](https://onlinecompiler.io/docs/problems?utm_source=npm) describe them:
`problems()`, `problem()`, `createProblem()`, `updateProblem()`, `replaceDraft()`, `publishProblem()`,
`archiveProblem()`, `restoreProblem()` and `publicProblem()`.

A problem's data files (a SQLite database, a CSV, any bytes the tests read) go in the draft's `files`
(`{ name, content, encoding }`) through `createProblem()` or `replaceDraft()`, or one at a time as raw
bytes, which suits large or binary files. Owner bodies list them as `files: [{ name, bytes, sha256 }]`.

```ts
await client.putDraftFile('sum', 'orders.db', readFileSync('orders.db')); // a string is sent as UTF-8
await client.deleteDraftFile('sum', 'orders.db'); // NotFoundError when absent
```

### Re-judge earlier submissions

After publishing a new version, run earlier submissions against it. Each is queued as a new async
submission with `rejudge_of` set to the original; at most 100 a call.

```js
const { version, queued, skipped, remaining } = await client.rejudge('sum', {
  version: 2, // default: the current version
  submissions: ['sub_...'], // default: every earlier submission that qualifies
  notify: true, // send the original's callback_url a webhook; default false
});
```

Call again while `remaining` is above 0. Every field is optional.

## Sessions for the widget

A session lets one candidate's [embedded editor](https://onlinecompiler.io/docs/widget?utm_source=npm)
Submit to a stored problem without your API key ever reaching the browser. Create it on your server and
put only its token in the page:

```js
const problemId = (await client.problem('sum')).problem; // the widget takes the id, never the slug
const session = await client.createSession(problemId, { external_ref: 'attempt-4821', max_submits: 2, expires_in: 3600 });

const html = `<div class="runcode" data-key="YOUR_WIDGET_KEY" data-problem="${problemId}"
  data-session="${session.token}"></div>
<script src="https://onlinecompiler.io/widget.js"></script>`;
```

The token is shown only this once and the client never logs it or puts it in an error, so keep it out
of your own logs too. `external_ref` should be an opaque id: the candidate's page sees it. Record the
score from the webhook or `client.submission(id)`, never from the browser.
`client.session(problemId, session.session)` shows the Submits used and the submission ids, and
`client.revokeSession(problemId, session.session)` ends it at once.

## Verify webhooks

An async submission with a `callback_url` (or a callback URL on the API key) gets one signed
`submission.finished` event. Check it before you trust it.

Verify the raw request body exactly as received: a body that was parsed and serialized again never
matches. With Express, use `express.raw({ type: 'application/json' })` on that route, as below. With
Next.js, read `await req.text()` in a route handler (or turn off the body parser for a pages API route).
In a fetch handler, Deno or a Worker, pass `await request.text()` and `request.headers`.

```js
import express from 'express';
import { verifyWebhook } from 'onlinecompiler';

const secret = process.env.ONLINECOMPILER_WEBHOOK_SECRET; // whsec_..., shown with the API key in your dashboard
if (!secret) throw new Error('Set ONLINECOMPILER_WEBHOOK_SECRET');

const app = express();
app.post('/hooks/oc', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!(await verifyWebhook(secret, req.body, req.headers))) return res.sendStatus(400);
  const event = JSON.parse(req.body.toString('utf8'));
  console.log(event.submission, event.status, event.result?.verdict);
  res.sendStatus(204); // answer quickly; deduplicate on event.delivery
});

app.listen(3000);
```

`verifyWebhook(secret, rawBody, headers, { toleranceSeconds = 300 } = {})` needs no client and no
network, and resolves to a boolean. `rawBody` is a string, Buffer, Uint8Array or ArrayBuffer; `headers`
is a plain object or a `Headers`. It compares in constant time, accepts either signature while a secret
is being rotated, takes an array of secrets while you rotate yours, and rejects a timestamp more than
`toleranceSeconds` from now. Anything missing or malformed resolves to `false`. See the
[webhooks docs](https://onlinecompiler.io/docs/webhooks?utm_source=npm).

## Verify receipts

Every judged submission comes with a receipt signed with Ed25519: proof of what ran, against which
tests, and what came out. Anyone can check it with the published keys.

```js
import { verifyReceipt } from 'onlinecompiler';

const { receipt } = await client.submission('sub_8f2Kq7LmT3xR9vWb1cYd4hNe');
console.log(await client.verifyReceipt(receipt)); // fetches the published keys once, no API key needed

const keys = await client.receiptKeys(); // or save them and verify offline later
console.log(await verifyReceipt(receipt, keys)); // false once any field has been changed
```

Both resolve to `false` for `null`, which a submission that was not judged has as its receipt.
Verification uses Web Crypto's Ed25519, with no dependency; on a runtime whose Web Crypto has no
Ed25519 it rejects with a `NotSupportedError` rather than calling a genuine receipt invalid. Store and
deduplicate receipts by their `submission` id (or the whole receipt), not by the signature string.
`canonicalJson(value)` returns the canonical form receipts are signed over, for reproducing their hashes
as the [receipts docs](https://onlinecompiler.io/docs/receipts?utm_source=npm) describe.

## Files in and out

```js
import { readFile, writeFile } from 'node:fs/promises';

const result = await client.run({
  compiler: 'python-3.14',
  code: [
    'import pandas as pd',
    'import matplotlib.pyplot as plt',
    'pd.read_csv("sales.csv").plot(x="month", y="units")',
    'plt.show()  # saved as figure-1.png in $OUTPUT_DIR',
  ].join('\n'),
  files: [{ name: 'sales.csv', content: await readFile('sales.csv', 'utf8') }],
});
for (const file of result.files) {
  await writeFile(file.name, Buffer.from(file.content_base64, 'base64'));
}
```

Input files sit in the program's working directory; send binary ones with `encoding: 'base64'`. Files
the program writes to `$OUTPUT_DIR` come back in `files`.

## Queue runs and get results by callback

```js
const queued = await client.submit({ compiler: 'g++-15', code: source, input: '3\n', extra_params: { submission_id: 981 } });
console.log(queued.id);
```

`submit` returns at once. When the run finishes, its result is POSTed to the callback URL set on your
API key in the dashboard, with your `extra_params` echoed back.

## Tools for the Vercel AI SDK

`onlinecompiler/ai-sdk` gives a model built with the [Vercel AI SDK](https://ai-sdk.dev) (`ai` 5 or later) two
tools: `runCode` runs a program and returns its output, and `runTests` judges code against test cases.

```js
import { generateText, stepCountIs } from 'ai';
import { onlinecompilerTools } from 'onlinecompiler/ai-sdk';

const { text } = await generateText({
  model: 'openai/gpt-5-mini',
  tools: onlinecompilerTools(), // reads ONLINECOMPILER_API_KEY; or onlinecompilerTools({ apiKey })
  stopWhen: stepCountIs(5),
  prompt: 'What is the 40th Fibonacci number? Compute it.',
});
```

`runCode()` and `runTests()` are also exported one by one. The model gets the result without file contents or the
receipt, to keep its context small. Each run, and each test, counts toward your allowance. Guide:
https://onlinecompiler.io/docs/ai-sdk?utm_source=npm

## Other calls

- `client.compilers()`: every compiler id and language name (no key needed).
- `client.usage()`: this month's runs and what's left, for the account and for the key.
- `client.limits()`: per-run limits and default account limits (no key needed).

## Errors

```js
import { OnlineCompilerError, RateLimitError } from 'onlinecompiler';

try {
  await client.run({ compiler: 'python-3.14', code: 'print(1)' });
} catch (err) {
  if (err instanceof RateLimitError) console.log(err.message); // HTTP 429: which limit, and how to raise it
  else if (err instanceof OnlineCompilerError) console.log(err.status, err.message); // 0 when unreachable
  else throw err;
}
```

`AuthenticationError` (a missing, unknown or unauthorized key) and `NotFoundError` (a submission,
problem or session that does not exist or is not yours) are also `OnlineCompilerError`s. A conflict,
such as an archived problem or an `Idempotency-Key` reused with another body, is an
`OnlineCompilerError` with status 409 and the API's message. The client never retries a request by
itself, because every run the API accepts counts toward your allowance.
`new OnlineCompiler({ apiKey, baseUrl, timeout, fetch })` takes the key, the API address, a timeout in
milliseconds (default 90,000) and an optional `fetch` implementation. Without `apiKey` it reads `ONLINECOMPILER_API_KEY` where it can
(not in a Worker, or on Deno without `--allow-env`). The key is kept in a private field, so logging the
client never shows it.

The package is an ES module; CommonJS code can `require('onlinecompiler')` too.

## Links

[Docs](https://onlinecompiler.io/docs?utm_source=npm) ·
[Languages](https://onlinecompiler.io/languages?utm_source=npm) ·
[Limits](https://onlinecompiler.io/docs/limits?utm_source=npm) ·
[Pricing](https://onlinecompiler.io/pricing?utm_source=npm) ·
[Security](https://onlinecompiler.io/security?utm_source=npm) ·
[Changelog](https://onlinecompiler.io/changelog?utm_source=npm)

MIT licensed. OnlineCompiler.io is a product of RunCode Inc.
