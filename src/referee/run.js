#!/usr/bin/env node
// One round of the room's referee (see referee.js), as the workflow runs it. Environment:
//   GITHUB_REPOSITORY   the repository (GitHub sets it)
//   ROOM_URL            a copy of the room's record (default https://inwove.org)
//   REFEREE_APP_ID      the referee app's ID (an environment variable of "referee")
//   REFEREE_APP_KEY     its private key (a secret of "referee", which only runs from main)
import { appendFileSync } from 'node:fs'
import { createResolver } from '../server/resolver.js'
import { github } from '../server/actions.js'
import { installationToken } from './app-token.js'
import { readRecord, round, summary, verifyRecord } from './referee.js'

const need = (k, what) => { const v = process.env[k]; if (!v) { console.error(`::error::${k} is not set: ${what}`); process.exit(2) } return v }
const repo = need('GITHUB_REPOSITORY', 'run this from GitHub Actions')
const roomUrl = (process.env.ROOM_URL || 'https://inwove.org').replace(/\/+$/, '')
const { token, app } = await installationToken({ appId: need('REFEREE_APP_ID', 'the referee app is not set up yet (README: "Merges with no host")'), privateKey: need('REFEREE_APP_KEY', 'the referee app has no key in the "referee" environment yet'), repo })
const entries = await readRecord(roomUrl)
const resolver = createResolver()
const out = await round({ entries, gh: github(token), repo, branch: process.env.REFEREE_BRANCH || 'main', publicUrl: roomUrl, verify: (es) => verifyRecord(es, { keyFor: (did, vm, purpose) => resolver.keyFor(did, vm, purpose) }) })
const text = summary(out, roomUrl)
console.log(text); console.log(JSON.stringify({ app, ...out }))
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
process.exit(out.ok ? 0 : 1)
