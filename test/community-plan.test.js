import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const plan = readFileSync(new URL('../docs/community-host-plan.md', import.meta.url), 'utf8');

test('the community plan pins OpenVTC by its full commit hash', () => {
  assert.match(plan, /c6964c4612131089e1add0f47575894e1bd8a565/);
});

test('the community plan carries no secrets or private keys', () => {
  assert.doesNotMatch(plan, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  assert.doesNotMatch(plan, /\b(ghp_|github_pat_|sk-[A-Za-z0-9]{10})/);
  assert.doesNotMatch(plan, /\bz[1-9A-HJ-NP-Za-km-z]{40,}\b/, 'no raw multibase key material');
});

