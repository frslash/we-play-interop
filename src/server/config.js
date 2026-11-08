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
  weaverIntervalMinutes: int(env.WEAVER_INTERVAL_MINUTES, 5),
  vetoWindowMinutes: int(env.VETO_WINDOW_MINUTES, 10),
  approvalsRequired: Math.max(1, int(env.APPROVALS_REQUIRED, 1)),

  githubToken: env.GITHUB_TOKEN || '',
  workspaceRepo: env.WORKSPACE_REPO || 'Project-Weave-Tech/we-play-interop',

  maxSkewMinutes: int(env.MAX_SKEW_MINUTES, 10),
}
