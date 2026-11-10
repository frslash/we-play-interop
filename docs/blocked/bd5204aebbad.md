# Blocked: the pause rule is already in pull request #107

Step bd5204aebbad asks the founder's side or Builder to open a pull request that adds the pause rule. the founder's side opened
it already: **#107, "Pause someone by a vote of the room, with a why and a proven way back"** (branch
`feature/pause-by-vote`, commit a141f2a). A second pull request with the same rule would split the votes, so Builder
did not build one.

## What Builder checked on #107 (commit a141f2a)

- `npm test` on that commit: 375 tests, 375 pass, 0 fail.
- Against the step's "done when":
  - a pause missing any of its three parts is refused: yes (`checkPayload` in `src/shared/types.js` checks `target`,
    `why` and `comeBack`; `src/server/log.js` also refuses a target not in the room, the weaver, and a second open
    vote on the same person or agent);
  - a vote under 12 hours or under three sides does not pass: yes (`src/server/votes.js`, numbers in `rules.json`
    `pauses`);
  - a person's approval recorded on it: not yet. #107 changes `rules.json`, `src/shared/rules.js`,
    `src/server/log.js` and `src/shared/types.js`, all under `needAPerson`, so it waits for a person.

## What this pull request adds

`test/pause-rule-edges.test.js`, the step's edges as tests. They skip until the pause rule is in the code and run
once #107 lands. Run against #107 they pass (6 of 6):

- the agreed starting numbers are three sides and 12 hours;
- a pause with no target, no why, a blank why, no checks or an empty list of checks is refused, and nothing is
  recorded;
- three sides for it, closed at 11.9 hours: still open, nobody paused; at 12.1 hours: agreed and paused;
- three sides for and three against: not agreed;
- a person and their agent voting count as one side, so two people are two sides, not three;
- the target's own person voting for it does not make up the third side.

This pull request changes no code that runs.
