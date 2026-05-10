import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  const [refreshing, setRefreshing] = useState(false);
  const [selectedChatJid, setSelectedChatJid] = useState<string>(() =>
    resolvePreferredChatJid(conversations, activeJid),
  );
  const selectedChatJidRef = useRef<string>(selectedChatJid);

  useEffect(() => {
    selectedChatJidRef.current = selectedChatJid;
  }, [selectedChatJid]);

  const loadTasks = useCallback(
    async (chatJid?: string | null, options?: { background?: boolean }) => {
      const targetJid = chatJid || selectedChatJidRef.current;
      if (!targetJid) return;

      if (!options?.background) {
        setLoading(true);
        setRefreshing(true);
      }

      try {
        const res = await fetch(
          `${apiBase}/api/tasks?chat_jid=${encodeURIComponent(targetJid)}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        setTasks(data.tasks || []);
      } catch {
        /* offline */
      } finally {
        if (!options?.background) {
          setLoading(false);
          setRefreshing(false);
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
        await fetch(
          `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/pause`,
          { method: 'POST' },
        );
        await loadTasks();
      } catch {
        /* offline */
      }
    },
    [apiBase, loadTasks],
  );

  const resumeTask = useCallback(
    async (taskId: string) => {
      try {
        await fetch(
          `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/resume`,
          { method: 'POST' },
        );
        await loadTasks();
      } catch {
        /* offline */
      }
    },
    [apiBase, loadTasks],
  );

  const deleteScheduledTask = useCallback(
    async (taskId: string) => {
      try {
        await fetch(`${apiBase}/api/tasks/${encodeURIComponent(taskId)}`, {
          method: 'DELETE',
        });
        await loadTasks();
      } catch {
        /* offline */
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
    if (!selectedChatJid) {
      setTasks([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    if (!authenticated || !selectedChatJid) return;
    void loadTasks(selectedChatJid);
  }, [authenticated, loadTasks, selectedChatJid]);

  useEffect(() => {
    if (!selectedChatJid || !hasRuntimeTasks) return;

    const timer = window.setInterval(() => {
      void loadTasks(selectedChatJid, { background: true });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [hasRuntimeTasks, loadTasks, selectedChatJid]);

  const refreshSelectedTasks = useCallback(() => {
    void loadTasks(selectedChatJid);
  }, [loadTasks, selectedChatJid]);

  return (
    <TasksPage
      conversations={conversations}
      selectedChatJid={selectedChatJid}
      setSelectedChatJid={setSelectedChatJid}
      tasks={tasks}
      loading={loading}
      refreshing={refreshing}
      onRefresh={refreshSelectedTasks}
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
