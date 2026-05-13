import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppSelect, type AppSelectOption } from '../components/AppSelect';
import { IconChevronDown, IconSort } from '../components/AppIcons';
import { PageHeader } from '../components/common';
import { Pagination } from '../components/common/Pagination';

import type { Conversation, ScheduledTaskSummary } from '../app-types';
import { getConversationTitle } from '../app-helpers';

const TASKS_PAGE_SIZE = 15;

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
  refreshing: boolean;
  onRefresh: () => void;
  onCreateTask: (
    input: TaskDraft & { chatJid: string },
  ) => Promise<boolean | void>;
  onParseTaskDraft: (request: string) => Promise<TaskDraft | null>;
  onPauseTask: (taskId: string) => Promise<void>;
  onResumeTask: (taskId: string) => Promise<void>;
  onDeleteTask: (taskId: string) => Promise<void>;
  onUpdateTask: (taskId: string, input: TaskDraft) => Promise<boolean | void>;
  onRunTask: (taskId: string) => Promise<boolean | void>;
}

type TaskFilter = 'all' | 'active' | 'paused' | 'completed';
type TaskSort = 'next-run' | 'created-desc' | 'status';
type TaskNoticeTone = 'info' | 'success' | 'error';

interface TaskNoticeState {
  text: string;
  tone: TaskNoticeTone;
  autoDismissMs?: number;
}

function getTaskSortOptions(t: (key: string) => string): AppSelectOption[] {
  return [
    { value: 'next-run', label: t('tasks.按下次运行') },
    { value: 'created-desc', label: t('tasks.按创建时间') },
    { value: 'status', label: t('tasks.按状态') },
  ];
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

function getSortLabel(sort: TaskSort, t: (key: string) => string) {
  if (sort === 'next-run') return t('tasks.按下次运行');
  if (sort === 'created-desc') return t('tasks.按创建时间');
  return t('tasks.按状态');
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

function compareByCreatedDesc(
  left: ScheduledTaskSummary,
  right: ScheduledTaskSummary,
) {
  return (
    new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  );
}

function compareByStatus(
  left: ScheduledTaskSummary,
  right: ScheduledTaskSummary,
) {
  const order = { active: 0, paused: 1, completed: 2 };
  const diff = order[left.status] - order[right.status];
  if (diff !== 0) return diff;
  return compareByNextRun(left, right);
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

export function TasksPage({
  conversations,
  selectedChatJid,
  setSelectedChatJid,
  tasks,
  loading,
  refreshing,
  onRefresh,
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
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all');
  const [taskSort, setTaskSort] = useState<TaskSort>('next-run');
  const [tasksPage, setTasksPage] = useState(1);
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

  const selectedConversation = useMemo(
    () =>
      conversations.find(
        (conversation) => conversation.jid === selectedChatJid,
      ) || null,
    [conversations, selectedChatJid],
  );

  const taskMetrics = useMemo(() => {
    let active = 0;
    let paused = 0;
    let completed = 0;
    let inactiveGroupCount = 0;
    let latestExecutedTask: ScheduledTaskSummary | null = null;
    let latestRunTime = 0;

    for (const task of tasks) {
      if (task.status === 'active') active += 1;
      else if (task.status === 'paused') paused += 1;
      else completed += 1;

      if (task.group_folder_active === false) {
        inactiveGroupCount += 1;
      }

      const runAt = task.last_run ? new Date(task.last_run).getTime() : 0;
      if (runAt > latestRunTime) {
        latestRunTime = runAt;
        latestExecutedTask = task;
      }
    }

    return {
      counts: {
        all: tasks.length,
        active,
        paused,
        completed,
      },
      inactiveGroupCount,
      latestExecutedTask,
    };
  }, [tasks]);

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

  const taskSortOptions = useMemo(() => getTaskSortOptions(t), [t]);
  const scheduleTypeOptions = useMemo(() => getTaskScheduleTypeOptions(t), [t]);
  const contextModeOptions = useMemo(() => getTaskContextModeOptions(t), [t]);
  const failureModeOptions = useMemo(() => getTaskFailureModeOptions(t), [t]);

  const schedulePresets = useMemo(
    () => getSchedulePresets(draft.scheduleType, t),
    [draft.scheduleType, t],
  );

  const filteredTasks = useMemo(() => {
    const filtered =
      taskFilter === 'all'
        ? tasks
        : tasks.filter((task) => task.status === taskFilter);
    const sorted = [...filtered];
    if (taskSort === 'created-desc') sorted.sort(compareByCreatedDesc);
    else if (taskSort === 'status') sorted.sort(compareByStatus);
    else sorted.sort(compareByNextRun);
    return sorted;
  }, [taskFilter, taskSort, tasks]);

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

  const getRuntimeLabel = (task: ScheduledTaskSummary) => {
    if (task.runtime_status === 'queued') return t('tasks.排队中');
    if (task.runtime_status === 'running') return t('tasks.执行中');
    if (task.latest_run?.status === 'error') return t('tasks.执行失败');
    if (task.latest_run?.status === 'success') return t('tasks.执行成功');
    return '-';
  };

  const summaryConversation = selectedConversation
    ? getConversationLabel(selectedConversation, t)
    : t('tasks.未选择');
  const { counts, inactiveGroupCount, latestExecutedTask } = taskMetrics;

  const latestSummary = latestExecutedTask
    ? `${truncateText(latestExecutedTask.title, 18)} · ${formatWhen(latestExecutedTask.last_run)}`
    : inactiveGroupCount > 0
      ? t('tasks.N个任务目录异常', { count: inactiveGroupCount })
      : t('tasks.暂无执行记录');

  return (
    <div className="page-view">
      <PageHeader
        title={t('tasks.定时任务')}
        subtitle={
          selectedConversation
            ? summaryConversation
            : t('tasks.先选择一个对话后再创建任务')
        }
        meta={
          <div className="nc-page-metrics">
            <div className="nc-page-metric">
              <span className="nc-page-metric-label">{t('tasks.任务总数')}</span>
              <strong className="nc-page-metric-value">{counts.all}</strong>
              <span className="nc-page-metric-note">
                {t('tasks.当前对话下全部任务')}
              </span>
            </div>
            <div className="nc-page-metric">
              <span className="nc-page-metric-label">{t('tasks.状态')}</span>
              <strong className="nc-page-metric-value">
                {counts.active} / {counts.paused} / {counts.completed}
              </strong>
              <span className="nc-page-metric-note">
                {t('tasks.运行中暂停完成')}
              </span>
            </div>
            <div className="nc-page-metric">
              <span className="nc-page-metric-label">{t('tasks.最近执行')}</span>
              <strong className="nc-page-metric-value">
                {latestExecutedTask
                  ? truncateText(latestExecutedTask.title, 18)
                  : t('tasks.暂无')}
              </strong>
              <span className="nc-page-metric-note">{latestSummary}</span>
            </div>
          </div>
        }
        actions={
          <div className="nc-page-actions-group">
            <div className="tasks-header-target">
              <span className="tasks-header-label">{t('tasks.当前对话')}</span>
              <AppSelect
                value={selectedChatJid || ''}
                onChange={(val) => setSelectedChatJid(val)}
                options={conversationOptions}
                ariaLabel={t('tasks.选择目标对话')}
                compact
                className="tasks-header-conv-select"
              />
            </div>
            <button
              className="btn-outline btn-sm"
              onClick={onRefresh}
              disabled={refreshing}
            >
              {refreshing ? t('tasks.刷新中') : t('tasks.刷新')}
            </button>
          </div>
        }
      />

      <div className="page-body tasks-page-body">
        {!showCreator && taskNotice ? (
          <div className={`tasks-notice ${taskNotice.tone}`}>
            {taskNotice.text}
          </div>
        ) : null}

        <section className="tasks-list-panel tasks-list-panel-wide">
          <div className="tasks-list-controls-shell">
            <div className="tasks-list-header">
              <div>
                <h3>{t('tasks.任务列表')}</h3>
                <p className="tasks-panel-copy">
                  {t('tasks.列表优先管理任务')}
                </p>
              </div>
              <div className="tasks-list-header-actions">
                <span className="tasks-list-meta">
                  {loading
                    ? t('tasks.加载中')
                    : `${filteredTasks.length} ${t('tasks.项')} · ${getSortLabel(taskSort, t)}`}
                </span>
                <button
                  className="btn-primary"
                  type="button"
                  onClick={() => setShowCreator(true)}
                >
                  {t('tasks.智能创建')}
                </button>
              </div>
            </div>

            <div className="tasks-list-toolbar">
              <div className="tasks-filter-bar">
                <button
                  className={`tasks-filter-chip ${taskFilter === 'all' ? 'active' : ''}`}
                  onClick={() => { setTaskFilter('all'); setTasksPage(1); }}
                  type="button"
                >
                  {t('tasks.全部')}<span className="tasks-filter-count">{counts.all}</span>
                </button>
                <button
                  className={`tasks-filter-chip ${taskFilter === 'active' ? 'active' : ''}`}
                  onClick={() => { setTaskFilter('active'); setTasksPage(1); }}
                  type="button"
                >
                  {t('tasks.运行中')}
                  <span className="tasks-filter-count">{counts.active}</span>
                </button>
                <button
                  className={`tasks-filter-chip ${taskFilter === 'paused' ? 'active' : ''}`}
                  onClick={() => { setTaskFilter('paused'); setTasksPage(1); }}
                  type="button"
                >
                  {t('tasks.已暂停')}
                  <span className="tasks-filter-count">{counts.paused}</span>
                </button>
                <button
                  className={`tasks-filter-chip ${taskFilter === 'completed' ? 'active' : ''}`}
                  onClick={() => { setTaskFilter('completed'); setTasksPage(1); }}
                  type="button"
                >
                  {t('tasks.已完成')}
                  <span className="tasks-filter-count">{counts.completed}</span>
                </button>
              </div>

              <AppSelect
                value={taskSort}
                onChange={(nextValue) => setTaskSort(nextValue as TaskSort)}
                ariaLabel={t('tasks.任务排序', { current: getSortLabel(taskSort, t) })}
                iconOnly
                triggerIcon={<IconSort />}
                compact
                className="tasks-sort-select conversation-sort-icon-button"
                options={taskSortOptions}
              />
            </div>
          </div>

          {loading ? (
            <div className="provider-empty">{t('tasks.加载中')}</div>
          ) : filteredTasks.length === 0 ? (
            <div className="tasks-empty-state">
              <div className="tasks-empty-title">{t('tasks.暂无任务')}</div>
              <div className="tasks-empty-copy">
                {t('tasks.点击智能创建生成第一个任务')}
              </div>
            </div>
          ) : (
            <div className="tasks-list">
              <Pagination page={tasksPage} pageSize={TASKS_PAGE_SIZE} total={filteredTasks.length} onPageChange={setTasksPage} />
              {filteredTasks.slice((tasksPage - 1) * TASKS_PAGE_SIZE, tasksPage * TASKS_PAGE_SIZE).map((task) => {
                const taskBusy = !!taskActionBusyById[task.id];
                const conversationLabel =
                  conversationNameByJid.get(task.chat_jid) ||
                  task.conversation_name ||
                  task.chat_jid;

                return (
                  <details
                    key={task.id}
                    className={`tasks-card tasks-card-details ${task.status === 'active' ? 'active' : ''}`}
                  >
                    <summary className="tasks-card-summary">
                      <div className="tasks-card-summary-main">
                        <div className="tasks-card-top">
                          <div className="tasks-card-title-wrap">
                            <div className="tasks-card-title-line">
                              <div className="provider-alias">
                                {task.title || t('tasks.未命名任务')}
                              </div>
                              <span
                                className={`tasks-context-badge ${task.context_mode}`}
                                title={getContextLabel(task.context_mode, t)}
                              >
                                {getContextLabel(task.context_mode, t)}
                              </span>
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
                            <div className="tasks-card-subline">
                              {t('tasks.目标对话')}{conversationLabel}
                            </div>
                            <div className="tasks-card-preview">
                              {truncateText(task.prompt, 96)}
                            </div>
                            <div className="tasks-card-id">{task.id}</div>
                          </div>
                          <div className="tasks-card-summary-side">
                            <span
                              className={`tasks-status-badge ${task.status}`}
                            >
                              {getStatusLabel(task.status, t)}
                            </span>
                            <span className="tasks-card-summary-next">
                              {formatWhen(task.next_run)}
                            </span>
                            <span className="tasks-card-summary-toggle">
                              {t('tasks.点击展开')}
                            </span>
                            <span
                              className="tasks-card-summary-icon"
                              aria-hidden="true"
                            >
                              <IconChevronDown />
                            </span>
                          </div>
                        </div>
                      </div>
                    </summary>

                    <div className="tasks-card-content">
                      <div className="tasks-card-prompt">{task.prompt}</div>

                      <div className="tasks-meta-grid">
                        <div className="tasks-meta-item">
                          <span className="tasks-meta-label">{t('tasks.调度方式')}</span>
                          <span className="tasks-meta-value">
                            {formatSchedule(task, t)}
                          </span>
                        </div>
                        <div className="tasks-meta-item">
                          <span className="tasks-meta-label">{t('tasks.创建时间')}</span>
                          <span className="tasks-meta-value">
                            {formatWhen(task.created_at)}
                          </span>
                        </div>
                        <div className="tasks-meta-item">
                          <span className="tasks-meta-label">{t('tasks.下次运行')}</span>
                          <span className="tasks-meta-value">
                            {formatWhen(task.next_run)}
                          </span>
                        </div>
                        <div className="tasks-meta-item">
                          <span className="tasks-meta-label">{t('tasks.上次运行')}</span>
                          <span className="tasks-meta-value">
                            {formatWhen(task.last_run)}
                          </span>
                        </div>
                        <div className="tasks-meta-item">
                          <span className="tasks-meta-label">{t('tasks.运行状态')}</span>
                          <span className="tasks-meta-value">
                            {getRuntimeLabel(task)}
                          </span>
                        </div>
                        <div className="tasks-meta-item">
                          <span className="tasks-meta-label">{t('tasks.失败策略')}</span>
                          <span className="tasks-meta-value">
                            {getFailureModeLabel(
                              task.failure_mode === 'pause'
                                ? 'pause'
                                : 'continue',
                              t,
                            )}
                          </span>
                        </div>
                        <div className="tasks-meta-item">
                          <span className="tasks-meta-label">{t('tasks.自动重试')}</span>
                          <span className="tasks-meta-value">
                            {Math.max(0, Number(task.retry_limit || 0))} {t('tasks.次')} /{' '}
                            {formatRetryBackoff(
                              Math.max(
                                1000,
                                Number(task.retry_backoff_ms || 300000),
                              ),
                              t,
                            )}
                          </span>
                        </div>
                        <div className="tasks-meta-item">
                          <span className="tasks-meta-label">{t('tasks.耗时')}</span>
                          <span className="tasks-meta-value">
                            {task.latest_run
                              ? t('tasks.N秒', { count: Math.max(1, Math.round(task.latest_run.duration_ms / 1000)) })
                              : '-'}
                          </span>
                        </div>
                        <div className="tasks-meta-item">
                          <span className="tasks-meta-label">{t('tasks.连续失败')}</span>
                          <span className="tasks-meta-value">
                            {Math.max(
                              0,
                              Number(task.consecutive_failures || 0),
                            )}
                          </span>
                        </div>
                        <div className="tasks-meta-item tasks-meta-item-wide">
                          <span className="tasks-meta-label">{t('tasks.最近发送')}</span>
                          <span className="tasks-meta-value tasks-result-text">
                            {getLatestTaskResult(task)}
                          </span>
                        </div>
                        <div className="tasks-meta-item tasks-meta-item-wide">
                          <span className="tasks-meta-label">{t('tasks.最近错误')}</span>
                          <span className="tasks-meta-value tasks-result-text">
                            {getLatestTaskError(task)}
                          </span>
                        </div>
                      </div>

                      <div className="provider-card-actions tasks-card-actions">
                        <button
                          className="btn-outline btn-sm"
                          onClick={() => void handleRunTask(task)}
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
                                : t('tasks.执行')}
                        </button>
                        <button
                          className="btn-outline btn-sm"
                          onClick={() => beginEditTask(task)}
                          disabled={taskBusy}
                        >
                          {t('tasks.编辑')}
                        </button>
                        {task.status === 'active' ? (
                          <button
                            className="btn-outline btn-sm"
                            onClick={() => {
                              if (!beginTaskAction(task.id)) return;
                              void onPauseTask(task.id).finally(() =>
                                finishTaskAction(task.id),
                              );
                            }}
                            disabled={taskBusy}
                          >
                            {t('tasks.暂停')}
                          </button>
                        ) : null}
                        {task.status === 'paused' ? (
                          <button
                            className="btn-outline btn-sm"
                            onClick={() => {
                              if (!beginTaskAction(task.id)) return;
                              void onResumeTask(task.id).finally(() =>
                                finishTaskAction(task.id),
                              );
                            }}
                            disabled={taskBusy}
                          >
                            {t('tasks.恢复')}
                          </button>
                        ) : null}
                        <button
                          className="btn-danger btn-sm"
                          onClick={() => {
                            if (!beginTaskAction(task.id)) return;
                            void onDeleteTask(task.id).finally(() =>
                              finishTaskAction(task.id),
                            );
                          }}
                          disabled={taskBusy}
                        >
                          {t('tasks.删除')}
                        </button>
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </section>

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
      </div>
    </div>
  );
}
