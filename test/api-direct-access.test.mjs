import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// This URL is emitted by API errors; changing a title must not break existing links.
test('direct-access guide keeps the public error-link destination', () => {
  const source = readFileSync(new URL('../content/api-direct-access.njk', import.meta.url), 'utf8');
  const frontmatter = source.split('---')[1];
  assert.match(frontmatter, /^permalink: \/api\/direct-access\/$/m);
});
