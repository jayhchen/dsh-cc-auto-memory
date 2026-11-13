import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply } from '../index.js';

test('auto-memory-recall uses only bytes read from MEMORY.md', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'auto-memory-recall-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = path.join(root, 'project');
	await mkdir(path.join(cwd, '.git'), { recursive: true });
	const slug = cwd.split(path.sep).join('-');
	const file = path.join(root, 'projects', slug, 'memory', 'MEMORY.md');
	const listeners = new Map();
	let recall;
	const agent = {
		id: 'main-session',
		session: { header: {} },
		ctx: {
			effect: (effect) => effect(),
			systemPrompt: {
				section: () => () => {},
				context: (section) => {
					assert.equal(section.name, 'auto-memory-recall');
					recall = section.text;
					return () => {};
				},
			},
		},
	};
	apply({
		on: (name, listener) => listeners.set(name, listener),
		effect: (effect) => effect(),
		workingDirectory: { ensure: async () => cwd },
		webServer: { register: () => () => {} },
		logger: {
			info() {},
			warn(message, error) { throw error ?? new Error(message); },
		},
	}, { mode: 'claude', claudeConfigDir: root });
	await listeners.get('agent/created')({ agent });
	assert.equal(typeof recall, 'function');
	assert.equal(recall(), '');

	const fixtures = [
		['empty', '', ''],
		['whitespace', ' \n\t\n', ''],
		['short ASCII', '- [Example](example.md) - synthetic memory\n', '- [Example](example.md) - synthetic memory\n'],
		['short Unicode', '- [示例](example.md) — 合成记忆\n', '- [示例](example.md) — 合成记忆\n'],
		['byte limit', 'x'.repeat(26000), 'x'.repeat(25600)],
		['line limit', 'entry\n'.repeat(201), Array(200).fill('entry').join('\n')],
	];
	for (const [name, input, expected] of fixtures) {
		await t.test(name, async () => {
			await writeFile(file, input);
			const result = recall();
			assert.equal(result.includes('\0'), false);
			if (expected === '') {
				assert.equal(result, '');
			} else {
				assert.equal(result, `<system-reminder>\nContents of ${file} (user's auto-memory, persists across conversations):\n\n${expected}\n</system-reminder>`);
			}
			assert.equal(recall(), result);
		});
	}
});
