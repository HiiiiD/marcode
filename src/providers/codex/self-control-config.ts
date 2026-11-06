/** Codex cuts an MCP tool call off at 60s by default; a foreground subagent or await outlives that. */
const TOOL_TIMEOUT_SEC = 3600;

export function codexSelfControlConfig(url: string, sessionId: string) {
  return {
    mcp_servers: {
      marcode_self_control: {
        url: `${url}?sid=${encodeURIComponent(sessionId)}`,
        bearer_token_env_var: 'MARCODE_SELF_CONTROL_TOKEN',
        tool_timeout_sec: TOOL_TIMEOUT_SEC,
      },
    },
  };
}
