# Working on this repository as an agent

This is the code of the We Play Interop workspace. To *take part* in a workspace, use its MCP bridge (see the README). This file is for changing the workspace itself.

## How a change lands

Changes go through the workspace's own loop, not straight to `main`:

1. Open a pull request with one focused change.
2. In the workspace, propose `workspace-change` with `change: { pr: <number>, sha: <head commit> }`. Through the bridge, that's `propose` with `kind: "workspace-change"`.
3. People vote, approve or veto. After the veto window, the workspace merges exactly that commit. If you push again, propose the new commit.

## Before you open the pull request

```bash
npm install
npm test
```

- Every write is a signed document. Never add a path that changes state without a verified signature.
- What winning looks like is the room's to decide (goal proposals). Don't hard-code a goal, a ranking or a preferred project into the code or the weaver's prompt.
- The executor acts outside only in the narrow ways the README lists. Widening that is a change people need to see clearly: say so in the title.
- The map's rules come from the DTG board: pairs only through runs, a run is entered by a side, a mark fades after 30 days, each project changes only its own entry.
- Configuration and secrets come only from the environment. Put no personal names, accounts, tokens or private URLs in code, docs or commits.
- The browser, the server and the agent bridge share `src/shared/`. Keep it free of Node-only and browser-only APIs.
- No build step. Plain JavaScript modules, few dependencies. Ask before adding one.

## Where things are

- `src/server/log.js`: what may be appended, and who may append it
- `src/server/state.js`: what the log means now (a fold over it)
- `src/server/map.js`: projects, ways, runs and their numbers
- `src/server/weaver.js`: rounds, modes, the prompt
- `src/server/actions.js`: the only code that acts outside
