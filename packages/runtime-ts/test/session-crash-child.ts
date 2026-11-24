import { openSessionStore, addSessionMessage } from '@nanobot/runtime';
const opened = await openSessionStore({ workspace: process.argv[2], sessionsRoot: process.argv[3] });
const session = await opened.state.get('websocket:crashed');
addSessionMessage(session, 'user', 'finish the accepted input'); session.metadata.pending_user_turn = true;
await opened.state.prepareInput(session);
addSessionMessage(session, 'assistant', 'uncommitted scratch answer'); session.metadata.uncommitted = true;
session.providerState = { kind: 'openai_responses', provider: 'openai', model: 'model', version: 1, payload: { cursor: 'synthetic' }, pending_messages: [] };
await opened.state.checkpointView(session, { phase: 'final_response', provider_state_checkpoint_version: 'v1', preceding_messages: [], assistant_message: { role: 'assistant', content: 'durable final answer', timestamp: '2026-01-01T00:00:03' }, completed_tool_results: [], pending_tool_calls: [] });
process.stdout.write(JSON.stringify({ generation: session.generation }) + '\n', () => process.kill(process.pid, 'SIGKILL'));
