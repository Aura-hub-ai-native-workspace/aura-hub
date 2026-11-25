import fs from 'node:fs';

const MCP_TOOL_NAMES = ['load_context', 'search_context', 'save_context', 'handoff', 'save_summary', 'save_failure', 'record_success', 'claim_area', 'release_area', 'list_claims', 'broadcast', 'get_patterns', 'get_audit_trail', 'resume_session', 'session_status'];
const canonicalTool = (name) => {
  const clean = name.split('/').pop();
  return MCP_TOOL_NAMES.find((tool) => clean === tool || clean.endsWith(`_${tool}`)) ?? clean;
};

/** Independent evidence checks shared by the live acceptance and deterministic tests. */
export function structuredToolCalls(stdout) {
  const calls = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!['tool_use', 'tool-call', 'tool_call', 'mcp_tool_call'].includes(String(event?.type ?? '').toLowerCase())) continue;
    for (const candidate of [event.part, event.properties, event.data, event.toolCall, event]) {
      const name = ['tool', 'name', 'toolName', 'tool_name'].map((key) => candidate?.[key]).find((v) => typeof v === 'string');
      if (!name) continue;
      const state = candidate?.state ?? event.state ?? {};
      const status = String(state.status ?? candidate?.status ?? event.status ?? '').toLowerCase();
      const hasResult = Object.hasOwn(state, 'output') || Object.hasOwn(candidate ?? {}, 'result') || Object.hasOwn(event, 'result');
      // OpenCode/Kilo JSON emits a tool_use record with a state. Only completed
      // calls prove invocation; a pending/running call is not acceptance evidence.
      if (status && !['completed', 'complete', 'success', 'succeeded'].includes(status)) break;
      if (!status && !hasResult) break;
      const output = state.output ?? candidate?.result ?? event.result;
      if (state.isError || candidate?.isError || event.isError || (typeof output === 'string' && /^\s*ERROR\b/i.test(output))) break;
      calls.push(canonicalTool(name));
      break;
    }
  }
  return calls;
}

export function structuredEventSummary(stdout) {
  const summary = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      const record = { type: String(event?.type ?? 'unknown') };
      const part = event?.part ?? event?.data ?? {};
      const toolName = part?.tool ?? part?.name ?? part?.toolName ?? part?.tool_name;
      if (typeof toolName === 'string') record.tool = canonicalTool(toolName);
      const state = part?.state ?? event?.state;
      if (typeof state?.status === 'string') record.status = state.status;
      const message = event?.error?.message ?? event?.error?.data?.message ?? event?.message;
      if (typeof message === 'string') record.error = message.slice(0, 160);
      summary.push(record);
    } catch { /* discard non-JSON console output */ }
  }
  return summary.slice(-30);
}

export function classifyProcessFailure(result) {
  if (result.processError === 'ENOENT') return 'BLOCKED';
  if (result.timedOut || result.processError || result.exitCode !== 0) {
    if (providerFailureReason(result)) return 'BLOCKED';
    return 'FAIL';
  }
  return null;
}

export function providerFailureReason(result) {
  if (result.processError === 'ENOENT') return 'missing-executable';
  const diagnostic = `${String(result.stderr ?? '')}\n${structuredDiagnostics(result.stdout)}`.toLowerCase();
  if (/unauthorized|authentication failed|not authenticated|invalid api key|missing api key|sign in required/.test(diagnostic)) return 'provider-authentication';
  if (/insufficient balance|payment required|no credits|out of credits|free usage limit|usage limit reached|quota exceeded/.test(diagnostic)) return 'provider-balance-or-quota';
  return null;
}

function structuredDiagnostics(stdout) {
  const messages = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (['error', 'session.error', 'step_error', 'provider.error'].includes(String(event?.type ?? '').toLowerCase())) {
        messages.push(event.message, event.error?.message, event.error?.data?.message, event.part?.text);
      }
    } catch { /* only structured CLI errors are used for provider classification */ }
  }
  return messages.filter((x) => typeof x === 'string').join('\n');
}

export function assertToolEvidence(stdout, required) {
  const actual = structuredToolCalls(stdout);
  const missing = required.filter((name) => !actual.includes(name));
  return { ok: missing.length === 0, actual, missing };
}

export function verifyStoreDecision(store, key, value, writer) {
  const entry = store?.contexts?.[key];
  return Boolean(entry && entry.value === value && entry.agent === writer);
}

export function readStoreSnapshot(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function validateOpenCodeMcpEntry(entry, serverBin, storePath, identity) {
  return Boolean(entry && Array.isArray(entry.command) && entry.command.includes(serverBin)
    && entry.environment?.CONTEXT_MCP_FILE === storePath
    && entry.environment?.CONTEXT_MCP_AGENT_ID === identity);
}

export function verifyStoreHandoff(store, value, writer, recipient) {
  return Boolean((store?.sessions ?? []).some((s) => s.agent === writer && s.status === 'completed'
    && s.accomplished === value && s.title.startsWith(`Handoff to ${recipient}:`)));
}

export function verifyStoreReader(beforeStore, afterStore, identity) {
  const beforeIds = new Set((beforeStore?.sessions ?? []).map((session) => session.id));
  return (afterStore?.sessions ?? []).some((session) => !beforeIds.has(session.id)
    && session.agent === identity && !/^Handoff to /.test(session.title));
}

export function clientToolNames(serverName, toolNames, client) {
  if (client === 'opencode') return toolNames.map((name) => `${serverName.replaceAll('-', '_')}_${name}`);
  if (client === 'kilo') return toolNames.map((name) => `${serverName}_${name}`);
  throw new Error(`unsupported MCP client: ${client}`);
}

export function assertChallengeReturned(output, expected) {
  return typeof output === 'string' && output.includes(expected);
}


/**
 * Does `kilo mcp list` output report this server connected?
 *
 * Exact server name and an explicit success status, on one line, e.g.
 * `●  ✓ common-context connected`. A loose search across lines would also
 * accept `disconnected`, a failed server followed by any other connected
 * server, a failure message that contains "connected", or a server whose
 * name merely starts with this one's.
 */
export function kiloListReportsConnected(listOutput, server = 'common-context') {
  const name = server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(`^[^\\S\\n]*(?:[●│]\\s*)?✓[^\\S\\n]+${name}[^\\S\\n]+connected\\b`, 'm');
  return line.test(String(listOutput ?? '').replace(/\u001b\[[0-9;]*m/g, ''));
}
