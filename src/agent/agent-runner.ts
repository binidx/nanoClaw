/**
 * Agent runner bridge for NanoClaw.
 * Spawns per-group agent processes and handles IPC.
 */
export { getNodeExecutable } from '../node-executable.js';
export * from './agent-runner-types.js';
export {
  requestAgentClose,
  runAgentProcess,
  sendAgentPrompt,
} from './agent-runner-process.js';
export {
  writeTasksSnapshot,
  writeGroupsSnapshot,
  type AvailableGroup,
} from './agent-runner-snapshots.js';
