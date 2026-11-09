import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicFetch } from '../src/server/resolver.js'

test('publicFetch refuses anything but public https on port 443', async () => {
  await assert.rejects(publicFetch('http://example.com/'), /https only/)
  await assert.rejects(publicFetch('https://example.com:8443/'), /port 443 only/)
  await assert.rejects(publicFetch('https://127.0.0.1/'), /not public/)
  await assert.rejects(publicFetch('https://169.254.169.254/latest/meta-data/'), /not public/)
  await assert.rejects(publicFetch('https://user:pw@example.com/'), /no credentials/)
})
