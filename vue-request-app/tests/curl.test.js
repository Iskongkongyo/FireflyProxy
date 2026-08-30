const test = require('node:test');
const assert = require('node:assert/strict');

test('imports required cURL flags without executing input', async () => {
	const { parseCurl } = await import('../src/utils/curl.mjs');
	const parsed = parseCurl("curl -X POST 'https://api.example.test/items?x=1' -H 'Content-Type: application/json' --header='X-Trace: one' --data-raw '{\"name\":\"O'\"'\"'Reilly\"}' -u 'alice:p@ss'");
	assert.equal(parsed.method, 'POST');
	assert.equal(parsed.body.type, 'json');
	assert.equal(parsed.body.text, '{"name":"O\'Reilly"}');
	assert.deepEqual(parsed.auth, { type: 'basic', username: 'alice', password: 'p@ss' });
	assert.deepEqual(parsed.headers.map(({ key, value }) => [key, value]), [
		['Content-Type', 'application/json'],
		['X-Trace', 'one']
	]);
});

test('imports long data flags and infers urlencoded body', async () => {
	const { parseCurl } = await import('../src/utils/curl.mjs');
	const parsed = parseCurl("curl --header 'Content-Type: application/x-www-form-urlencoded' --data 'a=1' --data-binary 'a=two%20words' https://example.test/form");
	assert.equal(parsed.method, 'POST');
	assert.equal(parsed.body.type, 'urlencoded');
	assert.deepEqual(parsed.body.rows.map(({ key, value }) => [key, value]), [['a', '1'], ['a', 'two words']]);
});

test('imports compact -d and long --user aliases as static values', async () => {
	const { parseCurl } = await import('../src/utils/curl.mjs');
	const parsed = parseCurl("curl -d'@payload.json' --user='bob:secret' https://example.test/items");
	assert.equal(parsed.body.type, 'raw');
	assert.equal(parsed.body.text, '@payload.json');
	assert.deepEqual(parsed.auth, { type: 'basic', username: 'bob', password: 'secret' });
	assert.match(parsed.warnings[0], /不会读取本地文件/);
});

test('imports and exports redirect controls without treating them as transport warnings', async () => {
	const { exportCurl, parseCurl } = await import('../src/utils/curl.mjs');
	const parsed = parseCurl("curl --location --max-redirs 3 'https://example.test/'");
	assert.deepEqual(parsed.redirect, { followRedirects: true, maxRedirects: 3 });
	assert.deepEqual(parsed.warnings, []);
	const command = exportCurl({
		method: 'GET', url: parsed.url, headers: [], body: { type: 'none' }, redirect: parsed.redirect
	});
	assert.match(command, /--location/);
	assert.match(command, /--max-redirs/);
	assert.deepEqual(parseCurl(command).redirect, parsed.redirect);
	assert.throws(() => parseCurl("curl --max-redirs 21 'https://example.test/'"), /0 到 20/);
});

test('rejects shell operators, command substitutions, and unsupported schemes', async () => {
	const { parseCurl } = await import('../src/utils/curl.mjs');
	assert.throws(() => parseCurl('curl https://example.test; whoami'), /Shell 控制符/);
	assert.throws(() => parseCurl('curl "https://example.test/$(whoami)"'), /命令替换/);
	assert.throws(() => parseCurl("curl 'file:///etc/passwd'"), /HTTP 和 HTTPS/);
	assert.throws(() => parseCurl("curl 'https://alice:secret@example.test/'"), /不得内嵌凭据/);
});

test('accepts escaped multiline commands but rejects unescaped command lines', async () => {
	const { parseCurl } = await import('../src/utils/curl.mjs');
	const parsed = parseCurl("curl \\\n  --request PATCH \\\n  'https://example.test/item'");
	assert.equal(parsed.method, 'PATCH');
	assert.throws(() => parseCurl('curl https://example.test\nwhoami'), /必须使用反斜杠续行/);
});

test('multipart import creates file placeholders instead of reading files', async () => {
	const { parseCurl } = await import('../src/utils/curl.mjs');
	const parsed = parseCurl("curl -F 'note=hello' --form 'upload=@C:\\\\tmp\\\\secret.txt' https://example.test/upload");
	assert.equal(parsed.body.type, 'multipart');
	assert.deepEqual(parsed.body.rows.map(({ kind, key, fileName }) => [kind, key, fileName]), [
		['text', 'note', ''],
		['file', 'upload', 'secret.txt']
	]);
	assert.match(parsed.warnings[0], /重新选择本地文件/);
});

test('POSIX export quotes every user-controlled token and round-trips', async () => {
	const { exportCurl, parseCurl } = await import('../src/utils/curl.mjs');
	const command = exportCurl({
		method: 'POST',
		url: 'https://example.test/items?q=one two',
		headers: [{ enabled: true, key: 'X-Name', value: "O'Reilly; $(nope)" }],
		auth: { type: 'basic', username: 'alice', password: "p'ass" },
		body: { type: 'json', text: '{"safe":true}' }
	});
	assert.match(command, /O'"'"'Reilly; \$\(nope\)'/);
	const parsed = parseCurl(command);
	assert.equal(parsed.url, 'https://example.test/items?q=one%20two');
	assert.equal(parsed.headers.find(({ key }) => key === 'X-Name').value, "O'Reilly; $(nope)");
	assert.equal(parsed.auth.password, "p'ass");
	assert.equal(parsed.body.type, 'json');
});

test('export skips disabled fields and represents multipart files explicitly', async () => {
	const { exportCurl } = await import('../src/utils/curl.mjs');
	const command = exportCurl({
		method: 'POST',
		url: 'https://example.test/upload',
		headers: [],
		body: {
			type: 'multipart',
			rows: [
				{ enabled: false, key: 'skip', kind: 'text', value: 'no' },
				{ enabled: true, key: 'caption', kind: 'text', value: 'summer' },
				{ enabled: true, key: 'photo', kind: 'file', fileName: 'cat photo.png' }
			]
		}
	});
	assert.doesNotMatch(command, /skip/);
	assert.match(command, /caption=summer/);
	assert.match(command, /photo=@cat photo\.png/);
});

test('secret detection covers auth and credential headers', async () => {
	const { requestContainsSecrets } = await import('../src/utils/curl.mjs');
	assert.equal(requestContainsSecrets({ auth: { type: 'bearer', token: 'secret' }, headers: [] }), true);
	assert.equal(requestContainsSecrets({ auth: { type: 'none' }, headers: [{ key: 'Cookie', value: 'sid=1' }] }), true);
	assert.equal(requestContainsSecrets({ auth: { type: 'none' }, headers: [{ key: 'X-Access-Token', value: 'secret' }] }), true);
	assert.equal(requestContainsSecrets({ auth: { type: 'none' }, headers: [{ key: 'Accept', value: 'json' }] }), false);
});
