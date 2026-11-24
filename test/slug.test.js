import assert from 'node:assert/strict';
import test from 'node:test';
import { slugify } from '../index.js';

test('project slug matches Claude Code encoding', () => {
	// A Windows drive colon must never survive into a directory name.
	assert.equal(slugify('C:\\Users\\tom\\proj'), 'C--Users-tom-proj');
	assert.equal(slugify('D:\\work\\a:b'), 'D--work-a-b');
	// Every non-alphanumeric character becomes one dash; runs are not collapsed.
	assert.equal(slugify('F:\\Desktop\\AI\\claude\\vector_fading'), 'F--Desktop-AI-claude-vector-fading');
	assert.equal(slugify('/home/tom/my repo.v2'), '-home-tom-my-repo-v2');
	// A surrogate pair is two code units, so an emoji is two dashes.
	assert.equal(slugify('/a/\u{1F600}/b'), '-a----b');
	// Letters, digits and dashes keep their shape.
	assert.equal(slugify('/data/devs/dsh-cc-auto-memory'), '-data-devs-dsh-cc-auto-memory');
	assert.equal(slugify('/'), '-');
});

test('project slug never contains characters Windows forbids in a file name', () => {
	for (const absolutePath of ['C:\\Users\\tom\\proj', 'C:\\Users\\张三\\项目', '\\\\server\\share\\proj']) {
		assert.equal(/[<>:"|?*\\/]/.test(slugify(absolutePath)), false, absolutePath);
	}
});

test('over-long project slugs are truncated with a hash suffix', () => {
	assert.equal(slugify(`/${'a'.repeat(199)}`).length, 200, '200 characters is the cutoff');
	const slug = slugify(`/${'a'.repeat(260)}`);
	assert.equal(slug, `-${'a'.repeat(199)}-ldr47l`);
});
