import type { AgentUploadedFile } from './agent.js';

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  client_id?: string;
  run_id?: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  agent_context?: string;
  uploaded_files?: AgentUploadedFile[];
}
