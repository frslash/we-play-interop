// All configuration comes from the environment (see .env.example).
const env = process.env
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10))

export const config = {
  port: int(env.PORT, 3000),
  production: env.NODE_ENV === 'production',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  workspaceName: env.WORKSPACE_NAME || 'We Play Interop',
  workspaceKey: env.WORKSPACE_KEY || '',
  databaseUrl: env.DATABASE_URL || '',
  dataDir: env.DATA_DIR || './data',
  sandbox: env.SANDBOX === '1', // a sandbox room: no real people's data, and agents approve and merge its code by themselves
  workspaceBranch: env.WORKSPACE_BRANCH || 'main', // the branch the room merges approved changes into
  agentApprovals: env.AGENT_APPROVALS !== '0', // agents may approve changes to the room's own code (an experiment)
  agentApprovers: Math.max(1, int(env.AGENT_APPROVERS, 3)), // how many different people's agents must approve a code change
  protectedPaths: (env.PROTECTED_PATHS || 'src/server/actions.js,src/server/log.js,src/server/hosted.js,src/server/never.js,src/server/drafts.js,src/shared/guard.js,src/shared/types.js,src/shared/chain.js,src/shared/did.js,src/shared/crypto.js,sandbox/,.github/,package.json,package-lock.json').split(',').map((x) => x.trim()).filter(Boolean), // changes here need a person's approval too

  boardRepo: env.BOARD_REPO || 'Project-Weave-Tech/dtg-interop',
  boardDataUrl: env.BOARD_DATA_URL || 'https://project-weave-tech.github.io/dtg-interop/data.json',
  boardRefreshMinutes: int(env.BOARD_REFRESH_MINUTES, 15),
  freshDays: 30, // the board fades a mark after 30 days; this is the board's rule, not a setting

  llm: {
    // which model runs the weaver: 'anthropic' (Claude, official SDK) or 'openai' (any OpenAI-compatible endpoint);
    // left empty, Claude is used when ANTHROPIC_API_KEY is set, else the OpenAI-compatible endpoint
    provider: env.LLM_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai'),
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    effort: env.LLM_EFFORT || 'medium',
    baseUrl: (env.LLM_BASE_URL || 'https://gateway.inference.coop/v1').replace(/\/$/, ''),
    apiKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || '', // empty: pick from the gateway's list, enclave models first
    preferPrefix: env.LLM_PREFER_PREFIX ?? 'tinfoil/', // the Inference Cooperative's enclave (TEE) models
    timeoutMs: int(env.LLM_TIMEOUT_SECONDS, 120) * 1000,
  },
  // the weaver speaks after a pause in the conversation, never more often than this
  weaverIntervalMinutes: int(env.WEAVER_INTERVAL_MINUTES, 10),
  checkEveryMinutes: int(env.ROOM_CHECK_MINUTES, 180), // the room check walks the newcomer's path this often, and after every start
  weaverQuietMinutes: int(env.WEAVER_QUIET_MINUTES, 2),
  vetoWindowMinutes: int(env.VETO_WINDOW_MINUTES, 10),
  operator: env.ROOM_OPERATOR || '', // who runs this room, named on its safety card
  voteMinutes: int(env.VOTE_MINUTES, 10), // a vote that isn't a goal or an outside change closes this long after it was proposed, and the room prompts whoever has to act
  approvalsRequired: Math.max(1, int(env.APPROVALS_REQUIRED, 1)),

  githubToken: env.GITHUB_TOKEN || '',
  workspaceRepo: env.WORKSPACE_REPO || 'Project-Weave-Tech/we-play-interop',

  maxSkewMinutes: int(env.MAX_SKEW_MINUTES, 10),
  // entries a person (with their agents) may add per minute: enough for a lively chat, not a flood
  ratePerMinute: int(env.RATE_PER_MINUTE, 30),
  // answers agents may give while their people are away, across the whole room, per hour: the host's spending guard
  awayAnswersPerHour: int(env.AWAY_ANSWERS_PER_HOUR, 120),
  // which model the weaver uses: smart (picks per round) or a model id
  weaverModel: env.WEAVER_MODEL || env.ANTHROPIC_MODEL || 'smart',
}
