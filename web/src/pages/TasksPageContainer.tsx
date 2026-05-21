import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Conversation, ScheduledTaskSummary } from '../app-types';
import { TasksPage } from './TasksPage';
import '../styles/tasks.css';

interface TaskDraftInput {
  title: string;
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  contextMode: 'group' | 'isolated';
  retryLimit: number;
  retryBackoffMs: number;
  failureMode: 'continue' | 'pause';
}

interface TasksPageContainerProps {
  apiBase: string;
  conversations: Conversation[];
  activeJid: string | null;
  authenticated: boolean;
}

function resolvePreferredChatJid(
  conversations: Conversation[],
  activeJid: string | null,
  fallbackJid?: string | null,
): string {
  if (fallbackJid && conversations.some((item) => item.jid === fallbackJid)) {
    return fallbackJid;
  }
  if (activeJid && conversations.some((item) => item.jid === activeJid)) {
    return activeJid;
  }
  return '';
}

export function TasksPageContainer({
  apiBase,
  conversations,
  activeJid,
  authenticated,
}: TasksPageContainerProps) {
  const [tasks, setTasks] = useState<ScheduledTaskSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedChatJid, setSelectedChatJid] = useState<string>(() =>
    resolvePreferredChatJid(conversations, activeJid),
  );

  const loadTasks = useCallback(
    async (_chatJid?: string | null, options?: { background?: boolean }) => {
      if (!options?.background) {
        setLoading(true);
      }

      try {
        const res = await fetch(`${apiBase}/api/tasks`);
        if (!res.ok) return;
        const data = await res.json();
        setTasks(data.tasks || []);
      } catch {
        /* offline */
      } finally {
        if (!options?.background) {
          setLoading(false);
        }
      }
    },
    [apiBase],
  );

  const createScheduledTask = useCallback(
    async (input: TaskDraftInput & { chatJid: string }) => {
      try {
        const res = await fetch(`${apiBase}/api/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) return false;
        await loadTasks(input.chatJid);
        return true;
      } catch {
        return false;
      }
    },
    [apiBase, loadTasks],
  );

  const parseTaskDraft = useCallback(
    async (request: string) => {
      try {
        const res = await fetch(`${apiBase}/api/tasks/ai-draft`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request }),
        });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
    [apiBase],
  );

  const pauseTask = useCallback(
    async (taskId: string) => {
      try {
        const res = await fetch(
          `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/pause`,
          { method: 'POST' },
        );
        if (!res.ok) return false;
        await loadTasks();
        return true;
      } catch {
        return false;
      }
    },
    [apiBase, loadTasks],
  );

  const resumeTask = useCallback(
    async (taskId: string) => {
      try {
        const res = await fetch(
          `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/resume`,
          { method: 'POST' },
        );
        if (!res.ok) return false;
        await loadTasks();
        return true;
      } catch {
        return false;
      }
    },
    [apiBase, loadTasks],
  );

  const deleteScheduledTask = useCallback(
    async (taskId: string) => {
      try {
        const res = await fetch(`${apiBase}/api/tasks/${encodeURIComponent(taskId)}`, {
          method: 'DELETE',
        });
        if (!res.ok) return false;
        await loadTasks();
        return true;
      } catch {
        return false;
      }
    },
    [apiBase, loadTasks],
  );

  const updateScheduledTask = useCallback(
    async (taskId: string, input: TaskDraftInput) => {
      try {
        const res = await fetch(
          `${apiBase}/api/tasks/${encodeURIComponent(taskId)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          },
        );
        if (!res.ok) return false;
        await loadTasks();
        return true;
      } catch {
        return false;
      }
    },
    [apiBase, loadTasks],
  );

  const runScheduledTask = useCallback(
    async (taskId: string) => {
      try {
        const res = await fetch(
          `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/run`,
          { method: 'POST' },
        );
        if (!res.ok) return false;
        await loadTasks(undefined, { background: true });
        return true;
      } catch {
        return false;
      }
    },
    [apiBase, loadTasks],
  );

  const hasRuntimeTasks = useMemo(
    () =>
      tasks.some(
        (task) =>
          task.runtime_status === 'queued' || task.runtime_status === 'running',
      ),
    [tasks],
  );

  useEffect(() => {
    const preferredJid = resolvePreferredChatJid(
      conversations,
      activeJid,
      selectedChatJid,
    );
    if (preferredJid === selectedChatJid) {
      return;
    }
    setSelectedChatJid(preferredJid);
  }, [activeJid, conversations, selectedChatJid]);

  useEffect(() => {
    if (!authenticated) return;
    void loadTasks();
  }, [authenticated, loadTasks]);

  useEffect(() => {
    if (!hasRuntimeTasks) return;

    const timer = window.setInterval(() => {
      void loadTasks(undefined, { background: true });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [hasRuntimeTasks, loadTasks]);

  return (
    <TasksPage
      conversations={conversations}
      selectedChatJid={selectedChatJid}
      setSelectedChatJid={setSelectedChatJid}
      tasks={tasks}
      loading={loading}
      onCreateTask={createScheduledTask}
      onParseTaskDraft={parseTaskDraft}
      onPauseTask={pauseTask}
      onResumeTask={resumeTask}
      onDeleteTask={deleteScheduledTask}
      onUpdateTask={updateScheduledTask}
      onRunTask={runScheduledTask}
    />
  );
}
