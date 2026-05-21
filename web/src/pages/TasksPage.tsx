import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppSelect, type AppSelectOption } from '../components/AppSelect';
import {
  IconCalendar,
  IconCandlestick,
  IconChannel,
  IconChat,
  IconClock,
  IconMail,
  IconSearch,
} from '../components/AppIcons';
import { CatalogPageShell, Drawer, SearchPill } from '../components/common';

import type { Conversation, ScheduledTaskSummary } from '../app-types';
import { getConversationTitle } from '../app-helpers';

interface TaskDraft {
  title: string;
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  contextMode: 'group' | 'isolated';
  retryLimit: number;
  retryBackoffMs: number;
  failureMode: 'continue' | 'pause';
  summary?: string;
}

interface TasksPageProps {
  conversations: Conversation[];
  selectedChatJid: string | null;
  setSelectedChatJid: (jid: string) => void;
  tasks: ScheduledTaskSummary[];
  loading: boolean;
  onCreateTask: (
    input: TaskDraft & { chatJid: string },
  ) => Promise<boolean | void>;
  onParseTaskDraft: (request: string) => Promise<TaskDraft | null>;
  onPauseTask: (taskId: string) => Promise<boolean | void>;
  onResumeTask: (taskId: string) => Promise<boolean | void>;
  onDeleteTask: (taskId: string) => Promise<boolean | void>;
  onUpdateTask: (taskId: string, input: TaskDraft) => Promise<boolean | void>;
  onRunTask: (taskId: string) => Promise<boolean | void>;
}

type TaskNoticeTone = 'info' | 'success' | 'error';

interface TaskNoticeState {
  text: string;
  tone: TaskNoticeTone;
  autoDismissMs?: number;
}

function getTaskScheduleTypeOptions(t: (key: string) => string): AppSelectOption[] {
  return [
    { value: 'cron', label: 'Cron' },
    { value: 'interval', label: t('tasks.间隔') },
    { value: 'once', label: t('tasks.单次') },
  ];
}

function getTaskContextModeOptions(t: (key: string) => string): AppSelectOption[] {
  return [
    { value: 'group', label: t('tasks.group带会话上下文') },
    { value: 'isolated', label: t('tasks.isolated独立任务') },
  ];
}

function getTaskFailureModeOptions(t: (key: string) => string): AppSelectOption[] {
  return [
    { value: 'continue', label: t('tasks.失败后继续按原计划') },
    { value: 'pause', label: t('tasks.失败后暂停任务') },
  ];
}

const DEFAULT_SCHEDULE_VALUE: Record<TaskDraft['scheduleType'], string> = {
  cron: '0 9 * * *',
  interval: '300000',
  once: '',
};

function createEmptyDraft(): TaskDraft {
  return {
    title: '',
    prompt: '',
    scheduleType: 'cron',
    scheduleValue: DEFAULT_SCHEDULE_VALUE.cron,
    contextMode: 'group',
    retryLimit: 0,
    retryBackoffMs: 300000,
    failureMode: 'continue',
  };
}

function formatSchedule(task: ScheduledTaskSummary, t: (key: string, opts?: Record<string, unknown>) => string) {
  if (task.schedule_type === 'cron') return `Cron · ${task.schedule_value}`;
  if (task.schedule_type === 'interval') {
    const milliseconds = Number(task.schedule_value);
    if (!Number.isNaN(milliseconds) && milliseconds >= 1000) {
      const minutes = Math.round(milliseconds / 60000);
      if (minutes >= 60 && minutes % 60 === 0)
        return t('tasks.间隔每N小时', { count: minutes / 60 });
      if (minutes >= 1) return t('tasks.间隔每N分钟', { count: minutes });
    }
    return t('tasks.间隔Nms', { value: task.schedule_value });
  }
  return t('tasks.单次N', { value: task.schedule_value });
}

function formatDraftSchedule(draft: TaskDraft, t: (key: string) => string) {
  if (!draft.scheduleValue.trim()) return t('tasks.未设置');
  if (draft.scheduleType === 'cron') return t('tasks.固定时间执行');
  if (draft.scheduleType === 'interval') return t('tasks.按固定间隔执行');
  return t('tasks.只执行一次');
}

function formatWhen(value: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatLocalDateTime(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:00`;
}

function getStatusLabel(status: ScheduledTaskSummary['status'], t: (key: string) => string) {
  if (status === 'active') return t('tasks.运行中');
  if (status === 'paused') return t('tasks.已暂停');
  return t('tasks.已完成');
}

function getContextLabel(contextMode: TaskDraft['contextMode'], t: (key: string) => string) {
  return contextMode === 'group' ? t('tasks.带上下文') : t('tasks.独立任务');
}

function getScheduleLabel(scheduleType: TaskDraft['scheduleType'], t: (key: string) => string) {
  if (scheduleType === 'cron') return t('tasks.Cron表达式');
  if (scheduleType === 'interval') return t('tasks.间隔毫秒');
  return t('tasks.本地时间');
}

function getSchedulePlaceholder(scheduleType: TaskDraft['scheduleType']) {
  if (scheduleType === 'cron') return '0 9 * * *';
  if (scheduleType === 'interval') return '300000';
  return '2026-03-09T09:00:00';
}

function changeDraftScheduleType<
  T extends { scheduleType: TaskDraft['scheduleType']; scheduleValue: string },
>(current: T, scheduleType: TaskDraft['scheduleType']): T {
  if (current.scheduleType === scheduleType) {
    return current;
  }

  return {
    ...current,
    scheduleType,
    scheduleValue: DEFAULT_SCHEDULE_VALUE[scheduleType],
  };
}

function getScheduleHint(scheduleType: TaskDraft['scheduleType'], t: (key: string) => string) {
  if (scheduleType === 'cron')
    return t('tasks.AI解析后的底层表达式通常不需要手工修改');
  if (scheduleType === 'interval')
    return t('tasks.AI解析后的间隔值单位是毫秒');
  return t('tasks.AI解析后的具体执行时间');
}

function formatRetryBackoff(milliseconds: number, t: (key: string, opts?: Record<string, unknown>) => string) {
  if (milliseconds >= 3600000 && milliseconds % 3600000 === 0)
    return t('tasks.N小时', { count: milliseconds / 3600000 });
  if (milliseconds >= 60000 && milliseconds % 60000 === 0)
    return t('tasks.N分钟', { count: milliseconds / 60000 });
  if (milliseconds >= 1000 && milliseconds % 1000 === 0)
    return t('tasks.N秒', { count: milliseconds / 1000 });
  return `${milliseconds} ms`;
}

function getFailureModeLabel(mode: TaskDraft['failureMode'], t: (key: string) => string) {
  return mode === 'pause' ? t('tasks.失败后暂停') : t('tasks.失败后继续');
}

function getSchedulePresets(scheduleType: TaskDraft['scheduleType'], t: (key: string) => string) {
  const now = new Date();
  if (scheduleType === 'cron') {
    return [
      { label: t('tasks.工作日0900'), value: '0 9 * * 1-5' },
      { label: t('tasks.每天0900'), value: '0 9 * * *' },
      { label: t('tasks.每周一1000'), value: '0 10 * * 1' },
    ];
  }
  if (scheduleType === 'interval') {
    return [
      { label: t('tasks.5分钟'), value: '300000' },
      { label: t('tasks.30分钟'), value: '1800000' },
      { label: t('tasks.1小时'), value: '3600000' },
      { label: t('tasks.6小时'), value: '21600000' },
    ];
  }
  return [
    {
      label: t('tasks.15分钟后'),
      value: formatLocalDateTime(new Date(now.getTime() + 15 * 60 * 1000)),
    },
    {
      label: t('tasks.1小时后'),
      value: formatLocalDateTime(new Date(now.getTime() + 60 * 60 * 1000)),
    },
    {
      label: t('tasks.今晚2000'),
      value: formatLocalDateTime(
        new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0, 0),
      ),
    },
    {
      label: t('tasks.明早0900'),
      value: formatLocalDateTime(
        new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0),
      ),
    },
  ];
}

function compareByNextRun(
  left: ScheduledTaskSummary,
  right: ScheduledTaskSummary,
) {
  const leftTime = left.next_run
    ? new Date(left.next_run).getTime()
    : Number.POSITIVE_INFINITY;
  const rightTime = right.next_run
    ? new Date(right.next_run).getTime()
    : Number.POSITIVE_INFINITY;
  return leftTime - rightTime;
}

function truncateText(value: string | null | undefined, max = 56) {
  const text = value?.trim() || '';
  if (!text) return '-';
  return text.length > max ? `${text.slice(0, max).trim()}…` : text;
}

function getLatestTaskResult(task: ScheduledTaskSummary) {
  const latestResult = task.latest_run?.result?.trim();
  if (latestResult) return latestResult;
  if (!task.last_error && task.last_result?.trim())
    return task.last_result.trim();
  return '-';
}

function getLatestTaskError(task: ScheduledTaskSummary) {
  const latestError = task.latest_run?.error?.trim();
  if (latestError) return latestError;
  if (task.last_error?.trim()) return task.last_error.trim();
  if (task.last_result?.startsWith('Error: ')) return task.last_result;
  return '-';
}

function getConversationLabel(conversation: Conversation | null | undefined, t: (key: string) => string) {
  return getConversationTitle(conversation) || t('tasks.未命名对话');
}

function formatTaskShortDateTime(value: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatTaskClockTime(hours: number, minutes: number) {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function formatTaskScheduleSummary(
  task: ScheduledTaskSummary,
  t: (key: string, opts?: Record<string, unknown>) => string,
) {
  if (task.schedule_type === 'cron') {
    const parts = task.schedule_value.trim().split(/\s+/);
    if (parts.length === 5) {
      const [minuteRaw, hourRaw, dayOfMonth, month, dayOfWeek] = parts;
      const minute = Number(minuteRaw);
      const hour = Number(hourRaw);
      if (
        Number.isInteger(minute) &&
        Number.isInteger(hour) &&
        minute >= 0 &&
        minute <= 59 &&
        hour >= 0 &&
        hour <= 23 &&
        dayOfMonth === '*' &&
        month === '*'
      ) {
        const time = formatTaskClockTime(hour, minute);
        if (dayOfWeek === '*') return t('tasks.每天时间', { time });
        if (dayOfWeek === '1-5') return t('tasks.工作日时间', { time });
        if (/^\d$/.test(dayOfWeek)) {
          const weekday = Number(dayOfWeek);
          const weekdaySeed = new Date(Date.UTC(2026, 0, weekday === 0 ? 4 : weekday + 4));
          const day = new Intl.DateTimeFormat(undefined, {
            weekday: 'short',
          }).format(weekdaySeed);
          return t('tasks.每周时间', { day, time });
        }
      }
    }
    return `Cron · ${task.schedule_value}`;
  }

  if (task.schedule_type === 'interval') {
    const milliseconds = Number(task.schedule_value);
    if (!Number.isNaN(milliseconds) && milliseconds >= 60000) {
      const minutes = Math.round(milliseconds / 60000);
      if (minutes >= 60 && minutes % 60 === 0) {
        return t('tasks.每隔N小时', { count: minutes / 60 });
      }
      return t('tasks.每隔N分钟', { count: minutes });
    }
    return formatSchedule(task, t);
  }

  return task.next_run
    ? formatTaskShortDateTime(task.next_run)
    : t('tasks.执行一次');
}

function formatTaskScheduleDetail(
  task: ScheduledTaskSummary,
  t: (key: string, opts?: Record<string, unknown>) => string,
) {
  if (task.next_run) {
    return t('tasks.下次时间N', {
      time: formatTaskShortDateTime(task.next_run),
    });
  }
  if (task.last_run) {
    return t('tasks.上次时间N', {
      time: formatTaskShortDateTime(task.last_run),
    });
  }
  return formatSchedule(task, t);
}

function getTaskRuntimeLabel(
  task: ScheduledTaskSummary,
  t: (key: string) => string,
) {
  if (task.runtime_status === 'queued') return t('tasks.排队中');
  if (task.runtime_status === 'running') return t('tasks.执行中');
  return getStatusLabel(task.status, t);
}

function getTaskStatusTone(task: ScheduledTaskSummary) {
  if (task.runtime_status === 'queued' || task.runtime_status === 'running') {
    return 'active';
  }
  if (task.status === 'paused') return 'paused';
  if (task.status === 'completed') return 'completed';
  return 'active';
}

function getTaskCardVisual(task: ScheduledTaskSummary) {
  const source = `${task.title}\n${task.prompt}`.toLowerCase();
  if (/(邮件|邮箱|gmail|mail|email)/i.test(source)) {
    return { icon: <IconMail />, tone: 'mail' as const };
  }
  if (/(数据|报表|看板|统计|分析|dashboard|report)/i.test(source)) {
    return { icon: <IconCandlestick />, tone: 'analytics' as const };
  }
  if (/(监控|巡检|预警|扫描|检查|动态|monitor|watch|alert)/i.test(source)) {
    return { icon: <IconChannel />, tone: 'monitor' as const };
  }
  return { icon: <IconCalendar />, tone: 'calendar' as const };
}

export function TasksPage({
  conversations,
  selectedChatJid,
  setSelectedChatJid,
  tasks,
  loading,
  onCreateTask,
  onParseTaskDraft,
  onPauseTask,
  onResumeTask,
  onDeleteTask,
  onUpdateTask,
  onRunTask,
}: TasksPageProps) {
  const { t } = useTranslation('tasks');
  const [aiRequest, setAiRequest] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [showCreator, setShowCreator] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [taskSearch, setTaskSearch] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskNotice, setTaskNotice] = useState<TaskNoticeState | null>(null);
  const [taskEditor, setTaskEditor] = useState<
    (TaskDraft & { id: string; status: ScheduledTaskSummary['status'] }) | null
  >(null);
  const [taskEditorBusy, setTaskEditorBusy] = useState(false);
  const [taskActionBusyById, setTaskActionBusyById] = useState<
    Record<string, boolean>
  >({});
  const [runMonitor, setRunMonitor] = useState<{
    taskId: string;
    title: string;
    previousRunAt: string | null;
  } | null>(null);
  const [draft, setDraft] = useState<TaskDraft>(createEmptyDraft());

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) || null,
    [selectedTaskId, tasks],
  );

  const conversationNameByJid = useMemo(
    () =>
      new Map(
        conversations.map((conversation) => [
          conversation.jid,
          getConversationLabel(conversation, t),
        ]),
      ),
    [conversations, t],
  );
  const conversationOptions = useMemo(
    () =>
      conversations.map((conversation) => ({
        value: conversation.jid,
        label: getConversationLabel(conversation, t),
      })),
    [conversations, t],
  );
  const scheduleTypeOptions = useMemo(() => getTaskScheduleTypeOptions(t), [t]);
  const contextModeOptions = useMemo(() => getTaskContextModeOptions(t), [t]);
  const failureModeOptions = useMemo(() => getTaskFailureModeOptions(t), [t]);

  const schedulePresets = useMemo(
    () => getSchedulePresets(draft.scheduleType, t),
    [draft.scheduleType, t],
  );

  const searchedTasks = useMemo(() => {
    const query = taskSearch.trim().toLowerCase();
    return tasks.filter((task) => {
      if (!query) return true;
      const conversationLabel =
        conversationNameByJid.get(task.chat_jid) ||
        task.conversation_name ||
        task.chat_jid;
      return [task.title, task.prompt, task.id, task.schedule_value, conversationLabel]
        .join('\n')
        .toLowerCase()
        .includes(query);
    });
  }, [conversationNameByJid, taskSearch, tasks]);

  const sortedTasks = useMemo(() => {
    return [...searchedTasks].sort(compareByNextRun);
  }, [searchedTasks]);

  const hasDraft = Boolean(
    draft.title.trim() || draft.prompt.trim() || draft.summary?.trim(),
  );

  const showTaskNotice = (
    text: string,
    tone: TaskNoticeTone = 'info',
    autoDismissMs?: number,
  ) => {
    setTaskNotice({ text, tone, autoDismissMs });
  };

  useEffect(() => {
    if (!taskNotice?.autoDismissMs) return;
    const timeoutId = window.setTimeout(() => {
      setTaskNotice((current) => (current === taskNotice ? null : current));
    }, taskNotice.autoDismissMs);
    return () => window.clearTimeout(timeoutId);
  }, [taskNotice]);

  useEffect(() => {
    if (!runMonitor) return;
    const task = tasks.find((item) => item.id === runMonitor.taskId);
    if (!task) {
      setRunMonitor(null);
      return;
    }
    if (task.runtime_status === 'queued') {
      showTaskNotice(
        t('tasks.任务已加入队列等待执行', { title: truncateText(runMonitor.title, 16) }),
      );
      return;
    }
    if (task.runtime_status === 'running') {
      showTaskNotice(t('tasks.任务执行中', { title: truncateText(runMonitor.title, 16) }));
      return;
    }
    const latestRunAt = task.latest_run?.run_at || task.last_run || null;
    if (!latestRunAt || latestRunAt === runMonitor.previousRunAt) {
      return;
    }
    if (task.latest_run?.status === 'error') {
      showTaskNotice(
        t('tasks.任务执行失败', {
          title: truncateText(runMonitor.title, 16),
          error: truncateText(task.latest_run.error || task.last_result, 40),
        }),
        'error',
      );
    } else {
      showTaskNotice(
        t('tasks.任务执行完成', { title: truncateText(runMonitor.title, 16) }),
        'success',
        4000,
      );
    }
    setRunMonitor(null);
  }, [runMonitor, tasks, t]);

  useEffect(() => {
    if (!selectedTaskId) return;
    if (tasks.some((task) => task.id === selectedTaskId)) return;
    setSelectedTaskId(null);
  }, [selectedTaskId, tasks]);

  const closeCreator = () => {
    setShowAdvanced(false);
    setShowCreator(false);
  };

  const resetCreatorDraft = () => {
    setAiRequest('');
    setDraft(createEmptyDraft());
    setShowAdvanced(false);
  };

  const handleAiParse = async () => {
    if (!aiRequest.trim()) return;
    setTaskNotice(null);
    setAiBusy(true);
    try {
      const next = await onParseTaskDraft(aiRequest.trim());
      if (!next) {
        showTaskNotice(
          t('tasks.AI暂时没能解析这个任务描述'),
          'error',
        );
        return;
      }
      setDraft((prev) => ({ ...createEmptyDraft(), ...prev, ...next }));
      setShowAdvanced(true);
      showTaskNotice(t('tasks.AI已生成草稿'), 'success');
    } finally {
      setAiBusy(false);
    }
  };

  const handleAiCreate = async () => {
    if (!selectedChatJid || !aiRequest.trim()) return;
    setTaskNotice(null);
    setAiBusy(true);
    try {
      const next = await onParseTaskDraft(aiRequest.trim());
      if (!next) {
        showTaskNotice(
          t('tasks.AI暂时没能解析这个任务描述'),
          'error',
        );
        return;
      }
      const normalizedNext = { ...createEmptyDraft(), ...next };
      setDraft(normalizedNext);
      const ok = await onCreateTask({
        ...normalizedNext,
        chatJid: selectedChatJid,
      });
      if (ok === false) {
        setShowAdvanced(true);
        showTaskNotice(
          t('tasks.AI已生成草稿但创建失败'),
          'error',
        );
        return;
      }
      showTaskNotice(
        t('tasks.AI已创建任务', { title: normalizedNext.title || t('tasks.未命名任务') }),
        'success',
      );
      resetCreatorDraft();
      closeCreator();
    } finally {
      setAiBusy(false);
    }
  };

  const handleCreate = async () => {
    if (!selectedChatJid || !draft.prompt.trim() || !draft.scheduleValue.trim())
      return;
    setTaskNotice(null);
    setCreateBusy(true);
    try {
      const ok = await onCreateTask({ ...draft, chatJid: selectedChatJid });
      if (ok === false) {
        showTaskNotice(t('tasks.创建失败'), 'error');
        return;
      }
      showTaskNotice(
        t('tasks.已创建任务', { title: draft.title || t('tasks.未命名任务') }),
        'success',
      );
      resetCreatorDraft();
      closeCreator();
    } finally {
      setCreateBusy(false);
    }
  };

  const beginEditTask = (task: ScheduledTaskSummary) => {
    setSelectedTaskId(task.id);
    setTaskEditor({
      id: task.id,
      status: task.status,
      title: task.title || '',
      prompt: task.prompt,
      scheduleType: task.schedule_type,
      scheduleValue: task.schedule_value,
      contextMode: task.context_mode,
      retryLimit: Math.max(0, Number(task.retry_limit || 0)),
      retryBackoffMs: Math.max(1000, Number(task.retry_backoff_ms || 300000)),
      failureMode: task.failure_mode === 'pause' ? 'pause' : 'continue',
    });
  };

  const submitTaskEdit = async () => {
    if (
      !taskEditor ||
      !taskEditor.prompt.trim() ||
      !taskEditor.scheduleValue.trim()
    )
      return;
    setTaskEditorBusy(true);
    try {
      const ok = await onUpdateTask(taskEditor.id, {
        title: taskEditor.title,
        prompt: taskEditor.prompt,
        scheduleType: taskEditor.scheduleType,
        scheduleValue: taskEditor.scheduleValue,
        contextMode: taskEditor.contextMode,
        retryLimit: taskEditor.retryLimit,
        retryBackoffMs: taskEditor.retryBackoffMs,
        failureMode: taskEditor.failureMode,
      });
      if (ok === false) {
        showTaskNotice(t('tasks.任务更新失败'), 'error');
        return;
      }
      showTaskNotice(
        t('tasks.已更新任务', { title: taskEditor.title || t('tasks.未命名任务') }),
        'success',
      );
      setTaskEditor(null);
    } finally {
      setTaskEditorBusy(false);
    }
  };

  const beginTaskAction = (taskId: string) => {
    let shouldRun = false;
    setTaskActionBusyById((prev) => {
      if (prev[taskId]) return prev;
      shouldRun = true;
      return { ...prev, [taskId]: true };
    });
    return shouldRun;
  };

  const finishTaskAction = (taskId: string) => {
    setTaskActionBusyById((prev) => {
      if (!prev[taskId]) return prev;
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  };

  const handleRunTask = async (task: ScheduledTaskSummary) => {
    if (!beginTaskAction(task.id)) return;
    setRunMonitor({
      taskId: task.id,
      title: task.title || t('tasks.未命名任务'),
      previousRunAt: task.latest_run?.run_at || task.last_run || null,
    });
    showTaskNotice(
      t('tasks.任务已开始处理', { title: truncateText(task.title || t('tasks.未命名任务'), 16) }),
    );
    try {
      const ok = await onRunTask(task.id);
      if (ok === false) {
        setRunMonitor(null);
        showTaskNotice(
          t('tasks.任务提交执行失败', { title: truncateText(task.title || t('tasks.未命名任务'), 16) }),
          'error',
        );
      }
    } finally {
      finishTaskAction(task.id);
    }
  };

  const handlePauseTask = async (task: ScheduledTaskSummary) => {
    if (!beginTaskAction(task.id)) return;
    try {
      const ok = await onPauseTask(task.id);
      if (ok === false) {
        showTaskNotice(t('tasks.任务更新失败'), 'error');
      }
    } catch {
      showTaskNotice(t('tasks.任务更新失败'), 'error');
    } finally {
      finishTaskAction(task.id);
    }
  };

  const handleResumeTask = async (task: ScheduledTaskSummary) => {
    if (!beginTaskAction(task.id)) return;
    try {
      const ok = await onResumeTask(task.id);
      if (ok === false) {
        showTaskNotice(t('tasks.任务更新失败'), 'error');
      }
    } catch {
      showTaskNotice(t('tasks.任务更新失败'), 'error');
    } finally {
      finishTaskAction(task.id);
    }
  };

  const handleDeleteTask = async (task: ScheduledTaskSummary) => {
    if (!beginTaskAction(task.id)) return;
    try {
      const ok = await onDeleteTask(task.id);
      if (ok === false) {
        showTaskNotice(t('tasks.任务更新失败'), 'error');
        return;
      }
      setSelectedTaskId(null);
    } catch {
      showTaskNotice(t('tasks.任务更新失败'), 'error');
    } finally {
      finishTaskAction(task.id);
    }
  };

  const getRuntimeLabel = (task: ScheduledTaskSummary) => {
    if (task.runtime_status === 'queued') return t('tasks.排队中');
    if (task.runtime_status === 'running') return t('tasks.执行中');
    if (task.latest_run?.status === 'error') return t('tasks.执行失败');
    if (task.latest_run?.status === 'success') return t('tasks.执行成功');
    return '-';
  };

  const openTaskDetail = (task: ScheduledTaskSummary) => {
    setSelectedTaskId(task.id);
  };

  const selectedTaskConversationLabel = selectedTask
    ? conversationNameByJid.get(selectedTask.chat_jid) ||
      selectedTask.conversation_name ||
      selectedTask.chat_jid
    : '';

  return (
    <CatalogPageShell
        title={t('tasks.定时任务')}
        subtitle={t('tasks.页面副标题')}
        controls={
          <>
            <SearchPill
              value={taskSearch}
              onChange={setTaskSearch}
              placeholder={t('tasks.搜索任务placeholder')}
              aria-label={t('tasks.搜索任务placeholder')}
              leadingIcon={<IconSearch />}
              clearLabel={t('清空搜索')}
              className="tasks-page-search"
            />
            <button
              className="btn-primary workflow-create-action tasks-hero-create-btn"
              type="button"
              onClick={() => setShowCreator(true)}
            >
              {t('tasks.新建任务')}
            </button>
          </>
        }
        bodyClassName="tasks-page-body"
      >
        {!showCreator && taskNotice ? (
          <div className={`tasks-notice ${taskNotice.tone}`}>
            {taskNotice.text}
          </div>
        ) : null}

        {loading ? (
          <div className="provider-empty">{t('tasks.加载中')}</div>
        ) : searchedTasks.length === 0 ? (
          <div className="tasks-empty-state">
            <div className="tasks-empty-title">{t('tasks.暂无任务')}</div>
            <div className="tasks-empty-copy">
              {t('tasks.点击智能创建生成第一个任务')}
            </div>
          </div>
        ) : (
          <section className="tasks-grid-shell">
            <div className="tasks-grid">
              {sortedTasks.map((task) => {
                const taskBusy = !!taskActionBusyById[task.id];
                const conversationLabel =
                  conversationNameByJid.get(task.chat_jid) ||
                  task.conversation_name ||
                  task.chat_jid;
                const taskVisual = getTaskCardVisual(task);
                const taskStatusTone = getTaskStatusTone(task);

                return (
                  <article
                    key={task.id}
                    className={`tasks-card ${selectedTaskId === task.id ? 'active' : ''}`}
                  >
                    <button
                      type="button"
                      className="tasks-card-button"
                      onClick={() => openTaskDetail(task)}
                    >
                      <div className="tasks-card-summary-main">
                        <div className="tasks-card-top">
                          <div
                            className={`tasks-card-icon-badge tone-${taskVisual.tone} state-${taskStatusTone}`}
                          >
                            {taskVisual.icon}
                          </div>
                          <div className="tasks-card-title-wrap">
                            <div className="tasks-card-title-row">
                              <div className="provider-alias">
                                {task.title || t('tasks.未命名任务')}
                              </div>
                            </div>
                            <div className="tasks-card-preview">
                              {truncateText(task.prompt, 54)}
                            </div>
                          </div>
                        </div>
                        <div className="tasks-card-meta-list">
                          <div className="tasks-card-meta-item">
                            <span className="tasks-card-meta-icon">
                              <IconClock />
                            </span>
                            <div className="tasks-card-meta-copy">
                              <span className="tasks-card-meta-value">
                                {formatTaskScheduleSummary(task, t)}
                              </span>
                              <span className="tasks-card-meta-detail">
                                {formatTaskScheduleDetail(task, t)}
                              </span>
                            </div>
                          </div>
                          <div className="tasks-card-meta-item">
                            <span className="tasks-card-meta-icon">
                              <IconChat />
                            </span>
                            <div className="tasks-card-meta-copy">
                              <span className="tasks-card-meta-value">
                                {conversationLabel}
                              </span>
                              <span className="tasks-card-meta-detail">
                                {t('tasks.绑定会话')} ·{' '}
                                {getContextLabel(task.context_mode, t)}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="tasks-card-footer">
                          <div
                            className={`tasks-card-runtime ${taskStatusTone}`}
                          >
                            <span className="tasks-card-runtime-dot" />
                            <span>{getTaskRuntimeLabel(task, t)}</span>
                          </div>
                          <div className="tasks-card-badges">
                            {task.group_folder_active === false ? (
                              <span
                                className="tasks-warning-badge"
                                title={t('tasks.任务对应的工作目录当前不可用')}
                              >
                                {t('tasks.目录异常')}
                              </span>
                            ) : null}
                            {Math.max(
                              0,
                              Number(task.consecutive_failures || 0),
                            ) > 0 ? (
                              <span
                                className="tasks-warning-badge"
                                title={getLatestTaskError(task)}
                              >
                                {t('tasks.连续失败')}{' '}
                                {Math.max(
                                  0,
                                  Number(task.consecutive_failures || 0),
                                )}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </button>

                    <div className="tasks-card-actions tasks-card-actions-compact">
                      <button
                        className="tasks-inline-action"
                        onClick={() =>
                          void (task.status === 'paused'
                            ? handleResumeTask(task)
                            : handleRunTask(task))
                        }
                        disabled={
                          taskBusy ||
                          task.runtime_status === 'queued' ||
                          task.runtime_status === 'running'
                        }
                      >
                        {taskBusy
                          ? t('tasks.处理中')
                          : task.runtime_status === 'queued'
                            ? t('tasks.排队中')
                            : task.runtime_status === 'running'
                              ? t('tasks.执行中')
                              : task.status === 'paused'
                                ? t('tasks.恢复运行')
                                : t('tasks.立即执行')}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {showCreator ? (
          <div className="modal-overlay" onClick={closeCreator}>
            <div
              className="modal tasks-advanced-modal tasks-create-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="tasks-advanced-header">
                <div>
                  <h4>{t('tasks.智能创建')}</h4>
                  <p className="tasks-panel-copy">
                    {t('tasks.智能创建描述')}
                  </p>
                </div>
              </div>

              {taskNotice ? (
                <div
                  className={`tasks-notice tasks-notice-inline ${taskNotice.tone}`}
                >
                  {taskNotice.text}
                </div>
              ) : null}

              <div className="form-group">
                <label>{t('tasks.任务需求')}</label>
                <textarea
                  rows={4}
                  value={aiRequest}
                  onChange={(event) => setAiRequest(event.target.value)}
                  placeholder={t('tasks.任务需求placeholder')}
                />
              </div>

              <div className="tasks-helper-grid tasks-helper-grid-modal">
                <div className="tasks-helper-card">
                  <span className="tasks-helper-title">{t('tasks.你只需要说人话')}</span>
                  <span className="tasks-helper-copy">
                    {t('tasks.不用手写Cron')}
                  </span>
                </div>
                <div className="tasks-helper-card">
                  <span className="tasks-helper-title">{t('tasks.任务名称自动生成')}</span>
                  <span className="tasks-helper-copy">
                    {t('tasks.AI会先生成简洁任务名')}
                  </span>
                </div>
              </div>

              {hasDraft ? (
                <div className="tasks-draft-preview tasks-draft-preview-compact">
                  <div className="tasks-draft-preview-title">{t('tasks.AI草稿')}</div>
                  <div className="tasks-draft-list">
                    <div className="tasks-draft-item">
                      <span className="tasks-draft-key">{t('tasks.名称')}</span>
                      <span className="tasks-draft-value">
                        {draft.title || t('tasks.未命名任务')}
                      </span>
                    </div>
                    <div className="tasks-draft-item">
                      <span className="tasks-draft-key">{t('tasks.内容')}</span>
                      <span className="tasks-draft-value">
                        {draft.prompt || t('tasks.等待AI生成草稿')}
                      </span>
                    </div>
                    <div className="tasks-draft-item">
                      <span className="tasks-draft-key">{t('tasks.方式')}</span>
                      <span className="tasks-draft-value">
                        {formatDraftSchedule(draft, t)}
                      </span>
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="modal-actions tasks-creator-actions tasks-creator-actions-modal">
                <button
                  className="btn-primary"
                  onClick={handleAiCreate}
                  disabled={aiBusy || !selectedChatJid || !aiRequest.trim()}
                >
                  {aiBusy ? t('tasks.智能创建中') : t('tasks.智能创建')}
                </button>
                <button
                  className="btn-outline"
                  onClick={handleAiParse}
                  disabled={aiBusy || !aiRequest.trim()}
                >
                  {aiBusy ? t('tasks.解析中') : t('tasks.先看草稿')}
                </button>
                <button
                  type="button"
                  className={`tasks-advanced-toggle ${showAdvanced ? 'active' : ''}`}
                  onClick={() => setShowAdvanced((prev) => !prev)}
                >
                  {t('tasks.高级配置')}
                </button>
              </div>

              {showAdvanced ? (
                <div className="tasks-advanced-box">
                  <div className="form-group">
                    <label>{t('tasks.目标对话')}</label>
                    <AppSelect
                      value={selectedChatJid || ''}
                      onChange={setSelectedChatJid}
                      disabled={conversations.length === 0}
                      ariaLabel={t('tasks.目标对话')}
                      options={conversationOptions}
                    />
                  </div>

                  <div className="form-group">
                    <label>{t('tasks.任务名称')}</label>
                    <input
                      value={draft.title}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          title: event.target.value,
                        }))
                      }
                      placeholder={t('tasks.任务名称placeholder')}
                    />
                  </div>

                  <div className="form-group">
                    <label>{t('tasks.执行内容')}</label>
                    <textarea
                      rows={4}
                      value={draft.prompt}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          prompt: event.target.value,
                        }))
                      }
                      placeholder={t('tasks.执行内容placeholder')}
                    />
                  </div>

                  {draft.summary ? (
                    <div className="settings-hint tasks-ai-summary">
                      {t('tasks.AI说明')}{draft.summary}
                    </div>
                  ) : null}

                  <div className="tasks-form-grid">
                    <div className="form-group">
                      <label>{t('tasks.调度类型')}</label>
                      <AppSelect
                        value={draft.scheduleType}
                        onChange={(nextValue) =>
                          setDraft((prev) =>
                            changeDraftScheduleType(
                              prev,
                              nextValue as TaskDraft['scheduleType'],
                            ),
                          )
                        }
                        ariaLabel={t('tasks.调度类型')}
                        options={scheduleTypeOptions}
                      />
                    </div>
                    <div className="form-group">
                      <label>{getScheduleLabel(draft.scheduleType, t)}</label>
                      <div className="tasks-input-stack">
                        <input
                          value={draft.scheduleValue}
                          onChange={(event) =>
                            setDraft((prev) => ({
                              ...prev,
                              scheduleValue: event.target.value,
                            }))
                          }
                          placeholder={getSchedulePlaceholder(
                            draft.scheduleType,
                          )}
                        />
                        <div
                          className="tasks-presets"
                          role="group"
                          aria-label="schedule presets"
                        >
                          {schedulePresets.map((preset) => (
                            <button
                              key={`${draft.scheduleType}-${preset.label}`}
                              type="button"
                              className={`tasks-preset-chip ${draft.scheduleValue === preset.value ? 'active' : ''}`}
                              onClick={() =>
                                setDraft((prev) => ({
                                  ...prev,
                                  scheduleValue: preset.value,
                                }))
                              }
                              title={preset.value}
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="tasks-inline-note">
                    {getScheduleHint(draft.scheduleType, t)}
                  </div>

                  <div className="form-group">
                    <label>{t('tasks.上下文模式')}</label>
                    <AppSelect
                      value={draft.contextMode}
                      onChange={(nextValue) =>
                        setDraft((prev) => ({
                          ...prev,
                          contextMode: nextValue as TaskDraft['contextMode'],
                        }))
                      }
                      ariaLabel={t('tasks.上下文模式')}
                      options={contextModeOptions}
                    />
                  </div>

                  <div className="tasks-context-preview">
                    {t('tasks.当前模式')}
                    <strong>{getContextLabel(draft.contextMode, t)}</strong>
                  </div>

                  <div className="tasks-form-grid">
                    <div className="form-group">
                      <label>{t('tasks.失败后的处理')}</label>
                      <AppSelect
                        value={draft.failureMode}
                        onChange={(nextValue) =>
                          setDraft((prev) => ({
                            ...prev,
                            failureMode: nextValue as TaskDraft['failureMode'],
                          }))
                        }
                        ariaLabel={t('tasks.失败后的处理')}
                        options={failureModeOptions}
                      />
                    </div>
                    <div className="form-group">
                      <label>{t('tasks.自动重试次数')}</label>
                      <input
                        className="nc-input"
                        type="number"
                        min={0}
                        max={10}
                        value={draft.retryLimit}
                        onChange={(event) =>
                          setDraft((prev) => ({
                            ...prev,
                            retryLimit: Math.max(
                              0,
                              Number(event.target.value || 0),
                            ),
                          }))
                        }
                        placeholder="0"
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label>{t('tasks.重试基础退避毫秒')}</label>
                    <input
                      className="nc-input"
                      type="number"
                      min={1000}
                      step={1000}
                      value={draft.retryBackoffMs}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          retryBackoffMs: Math.max(
                            1000,
                            Number(event.target.value || 300000),
                          ),
                        }))
                      }
                      placeholder="300000"
                    />
                  </div>
                  <div className="tasks-inline-note">
                    {t('tasks.当前策略', {
                      count: draft.retryLimit,
                      backoff: formatRetryBackoff(draft.retryBackoffMs, t),
                      failureMode: getFailureModeLabel(draft.failureMode, t),
                    })}
                  </div>

                  <div className="modal-actions tasks-creator-actions tasks-creator-actions-modal-secondary">
                    <button className="btn-outline" onClick={closeCreator}>
                      {t('tasks.关闭')}
                    </button>
                    <button
                      className="btn-primary"
                      onClick={handleCreate}
                      disabled={
                        createBusy ||
                        !selectedChatJid ||
                        !draft.prompt.trim() ||
                        !draft.scheduleValue.trim()
                      }
                    >
                      {createBusy ? t('tasks.新建中') : t('tasks.新建')}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <Drawer
          open={!!selectedTask}
          onClose={() => setSelectedTaskId(null)}
          title={
            selectedTask ? (
              <div className="tasks-drawer-title">
                <div className="tasks-drawer-title-main">
                  <strong>{selectedTask.title || t('tasks.未命名任务')}</strong>
                  <span className="tasks-card-subline">
                    {t('tasks.目标对话')}{selectedTaskConversationLabel}
                  </span>
                </div>
                <span
                  className={`tasks-status-badge ${selectedTask.status}`}
                >
                  {getStatusLabel(selectedTask.status, t)}
                </span>
              </div>
            ) : undefined
          }
          width="min(100vw, 720px)"
          footer={
            selectedTask ? (
              <>
                <button
                  type="button"
                  className="tasks-inline-action"
                  onClick={() => setSelectedTaskId(null)}
                >
                  {t('tasks.关闭')}
                </button>
                <button
                  type="button"
                  className="tasks-inline-action"
                  onClick={() => beginEditTask(selectedTask)}
                >
                  {t('tasks.编辑')}
                </button>
                <button
                  type="button"
                  className="tasks-inline-action"
                  onClick={() => void handleRunTask(selectedTask)}
                  disabled={
                    !!taskActionBusyById[selectedTask.id] ||
                    selectedTask.runtime_status === 'queued' ||
                    selectedTask.runtime_status === 'running'
                  }
                >
                  {selectedTask.runtime_status === 'queued'
                    ? t('tasks.排队中')
                    : selectedTask.runtime_status === 'running'
                      ? t('tasks.执行中')
                      : t('tasks.执行')}
                </button>
                {selectedTask.status === 'active' ? (
                  <button
                    type="button"
                    className="tasks-inline-action"
                    onClick={() => void handlePauseTask(selectedTask)}
                    disabled={!!taskActionBusyById[selectedTask.id]}
                  >
                    {t('tasks.暂停')}
                  </button>
                ) : null}
                {selectedTask.status === 'paused' ? (
                  <button
                    type="button"
                    className="tasks-inline-action"
                    onClick={() => void handleResumeTask(selectedTask)}
                    disabled={!!taskActionBusyById[selectedTask.id]}
                  >
                    {t('tasks.恢复')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="tasks-inline-action tasks-inline-action-danger"
                  onClick={() => void handleDeleteTask(selectedTask)}
                  disabled={!!taskActionBusyById[selectedTask.id]}
                >
                  {t('tasks.删除')}
                </button>
              </>
            ) : undefined
          }
        >
          {selectedTask ? (
            <div className="tasks-drawer-shell">
              <div className="tasks-drawer-hero">
                <div className="tasks-card-prompt">{selectedTask.prompt}</div>
                <div className="tasks-drawer-summary-grid">
                  <div className="tasks-meta-item">
                    <span className="tasks-meta-label">{t('tasks.调度方式')}</span>
                    <span className="tasks-meta-value">
                      {formatSchedule(selectedTask, t)}
                    </span>
                  </div>
                  <div className="tasks-meta-item">
                    <span className="tasks-meta-label">{t('tasks.运行状态')}</span>
                    <span className="tasks-meta-value">
                      {getRuntimeLabel(selectedTask)}
                    </span>
                  </div>
                  <div className="tasks-meta-item">
                    <span className="tasks-meta-label">{t('tasks.下次运行')}</span>
                    <span className="tasks-meta-value">
                      {formatWhen(selectedTask.next_run)}
                    </span>
                  </div>
                  <div className="tasks-meta-item">
                    <span className="tasks-meta-label">{t('tasks.上次运行')}</span>
                    <span className="tasks-meta-value">
                      {formatWhen(selectedTask.last_run)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="tasks-meta-grid tasks-meta-grid-drawer">
                <div className="tasks-meta-item">
                  <span className="tasks-meta-label">{t('tasks.创建时间')}</span>
                  <span className="tasks-meta-value">
                    {formatWhen(selectedTask.created_at)}
                  </span>
                </div>
                <div className="tasks-meta-item">
                  <span className="tasks-meta-label">{t('tasks.失败策略')}</span>
                  <span className="tasks-meta-value">
                    {getFailureModeLabel(
                      selectedTask.failure_mode === 'pause'
                        ? 'pause'
                        : 'continue',
                      t,
                    )}
                  </span>
                </div>
                <div className="tasks-meta-item">
                  <span className="tasks-meta-label">{t('tasks.自动重试')}</span>
                  <span className="tasks-meta-value">
                    {Math.max(0, Number(selectedTask.retry_limit || 0))}{' '}
                    {t('tasks.次')} /{' '}
                    {formatRetryBackoff(
                      Math.max(
                        1000,
                        Number(selectedTask.retry_backoff_ms || 300000),
                      ),
                      t,
                    )}
                  </span>
                </div>
                <div className="tasks-meta-item">
                  <span className="tasks-meta-label">{t('tasks.耗时')}</span>
                  <span className="tasks-meta-value">
                    {selectedTask.latest_run
                      ? t('tasks.N秒', {
                          count: Math.max(
                            1,
                            Math.round(selectedTask.latest_run.duration_ms / 1000),
                          ),
                        })
                      : '-'}
                  </span>
                </div>
                <div className="tasks-meta-item">
                  <span className="tasks-meta-label">{t('tasks.连续失败')}</span>
                  <span className="tasks-meta-value">
                    {Math.max(
                      0,
                      Number(selectedTask.consecutive_failures || 0),
                    )}
                  </span>
                </div>
                <div className="tasks-meta-item">
                  <span className="tasks-meta-label">{t('tasks.上下文模式')}</span>
                  <span className="tasks-meta-value">
                    {getContextLabel(selectedTask.context_mode, t)}
                  </span>
                </div>
                <div className="tasks-meta-item tasks-meta-item-wide">
                  <span className="tasks-meta-label">{t('tasks.最近发送')}</span>
                  <span className="tasks-meta-value tasks-result-text">
                    {getLatestTaskResult(selectedTask)}
                  </span>
                </div>
                <div className="tasks-meta-item tasks-meta-item-wide">
                  <span className="tasks-meta-label">{t('tasks.最近错误')}</span>
                  <span className="tasks-meta-value tasks-result-text">
                    {getLatestTaskError(selectedTask)}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </Drawer>

        {taskEditor ? (
          <div className="modal-overlay" onClick={() => setTaskEditor(null)}>
            <div
              className="modal tasks-advanced-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="tasks-advanced-header">
                <div>
                  <h4>{t('tasks.编辑任务')}</h4>
                  <p className="tasks-panel-copy">
                    {t('tasks.编辑任务描述')}
                  </p>
                </div>
              </div>

              <div className="form-group">
                <label>{t('tasks.任务名称')}</label>
                <input
                  value={taskEditor.title}
                  onChange={(event) =>
                    setTaskEditor((prev) =>
                      prev ? { ...prev, title: event.target.value } : prev,
                    )
                  }
                  placeholder={t('tasks.编辑任务名称placeholder')}
                />
              </div>

              <div className="form-group">
                <label>{t('tasks.执行内容')}</label>
                <textarea
                  rows={4}
                  value={taskEditor.prompt}
                  onChange={(event) =>
                    setTaskEditor((prev) =>
                      prev ? { ...prev, prompt: event.target.value } : prev,
                    )
                  }
                  placeholder={t('tasks.编辑执行内容placeholder')}
                />
              </div>

              <div className="tasks-form-grid">
                <div className="form-group">
                  <label>{t('tasks.调度类型')}</label>
                  <AppSelect
                    value={taskEditor.scheduleType}
                    onChange={(nextValue) =>
                      setTaskEditor((prev) =>
                        prev
                          ? changeDraftScheduleType(
                              prev,
                              nextValue as TaskDraft['scheduleType'],
                            )
                          : prev,
                      )
                    }
                    ariaLabel={t('tasks.编辑调度类型')}
                    options={scheduleTypeOptions}
                  />
                </div>
                <div className="form-group">
                  <label>{getScheduleLabel(taskEditor.scheduleType, t)}</label>
                  <input
                    value={taskEditor.scheduleValue}
                    onChange={(event) =>
                      setTaskEditor((prev) =>
                        prev
                          ? { ...prev, scheduleValue: event.target.value }
                          : prev,
                      )
                    }
                    placeholder={getSchedulePlaceholder(
                      taskEditor.scheduleType,
                    )}
                  />
                </div>
              </div>

              <div className="tasks-inline-note">
                {getScheduleHint(taskEditor.scheduleType, t)}
              </div>

              <div className="form-group">
                <label>{t('tasks.上下文模式')}</label>
                <AppSelect
                  value={taskEditor.contextMode}
                  onChange={(nextValue) =>
                    setTaskEditor((prev) =>
                      prev
                        ? {
                            ...prev,
                            contextMode: nextValue as TaskDraft['contextMode'],
                          }
                        : prev,
                    )
                  }
                  ariaLabel={t('tasks.编辑上下文模式')}
                  options={contextModeOptions}
                />
              </div>

              <div className="tasks-form-grid">
                <div className="form-group">
                  <label>{t('tasks.失败后的处理')}</label>
                  <AppSelect
                    value={taskEditor.failureMode}
                    onChange={(nextValue) =>
                      setTaskEditor((prev) =>
                        prev
                          ? {
                              ...prev,
                              failureMode:
                                nextValue as TaskDraft['failureMode'],
                            }
                          : prev,
                      )
                    }
                    ariaLabel={t('tasks.编辑失败后的处理')}
                    options={failureModeOptions}
                  />
                </div>
                <div className="form-group">
                  <label>{t('tasks.自动重试次数')}</label>
                  <input
                    className="nc-input"
                    type="number"
                    min={0}
                    max={10}
                    value={taskEditor.retryLimit}
                    onChange={(event) =>
                      setTaskEditor((prev) =>
                        prev
                          ? {
                              ...prev,
                              retryLimit: Math.max(
                                0,
                                Number(event.target.value || 0),
                              ),
                            }
                          : prev,
                      )
                    }
                    placeholder="0"
                  />
                </div>
              </div>

              <div className="form-group">
                <label>{t('tasks.重试基础退避毫秒')}</label>
                <input
                  className="nc-input"
                  type="number"
                  min={1000}
                  step={1000}
                  value={taskEditor.retryBackoffMs}
                  onChange={(event) =>
                    setTaskEditor((prev) =>
                      prev
                        ? {
                            ...prev,
                            retryBackoffMs: Math.max(
                              1000,
                              Number(event.target.value || 300000),
                            ),
                          }
                        : prev,
                    )
                  }
                  placeholder="300000"
                />
              </div>
              <div className="tasks-inline-note">
                {t('tasks.当前策略', {
                  count: taskEditor.retryLimit,
                  backoff: formatRetryBackoff(taskEditor.retryBackoffMs, t),
                  failureMode: getFailureModeLabel(taskEditor.failureMode, t),
                })}
              </div>

              <div className="modal-actions tasks-creator-actions">
                <button
                  className="btn-outline"
                  onClick={() => setTaskEditor(null)}
                >
                  {t('tasks.关闭')}
                </button>
                <button
                  className="btn-primary"
                  onClick={() => void submitTaskEdit()}
                  disabled={
                    taskEditorBusy ||
                    !taskEditor.prompt.trim() ||
                    !taskEditor.scheduleValue.trim()
                  }
                >
                  {taskEditorBusy ? t('tasks.保存中') : t('tasks.保存修改')}
                </button>
              </div>
            </div>
          </div>
        ) : null}
    </CatalogPageShell>
  );
}
