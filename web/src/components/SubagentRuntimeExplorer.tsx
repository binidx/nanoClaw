import { useMemo, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { SubagentRuntimeEntry } from '../app-types';
import i18n from '../i18n/index.ts';

interface RuntimeTreeNode {
  item: SubagentRuntimeEntry;
  children: RuntimeTreeNode[];
}

interface SubagentRuntimeExplorerProps {
  items: SubagentRuntimeEntry[];
  pendingActionKey?: string;
  onStop: (runtimeId: string) => Promise<boolean>;
  onMessage: (runtimeId: string, prompt: string) => Promise<boolean>;
  onSteer: (runtimeId: string, prompt: string) => Promise<boolean>;
}

type ComposerMode = 'message' | 'steer';

function isActiveRuntimeStatus(status: SubagentRuntimeEntry['status']): boolean {
  return (
    status === 'spawning' ||
    status === 'idle' ||
    status === 'running' ||
    status === 'stopping'
  );
}

function formatIsoTimestamp(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function getRuntimeStatusLabel(status: SubagentRuntimeEntry['status']): string {
  switch (status) {
    case 'spawning':
      return i18n.t('status.creating', { ns: 'subagent' });
    case 'idle':
      return i18n.t('status.idle', { ns: 'subagent' });
    case 'running':
      return i18n.t('status.running', { ns: 'subagent' });
    case 'stopping':
      return i18n.t('status.stopping', { ns: 'subagent' });
    case 'completed':
      return i18n.t('status.completed', { ns: 'subagent' });
    case 'failed':
      return i18n.t('status.failed', { ns: 'subagent' });
    case 'stopped':
      return i18n.t('status.stopped', { ns: 'subagent' });
    default:
      return status;
  }
}

function getRuntimeModeLabel(mode: SubagentRuntimeEntry['mode']): string {
  return mode === 'agent' ? i18n.t('info.mode.agent', { ns: 'subagent' }) : i18n.t('info.mode.team', { ns: 'subagent' });
}

function formatSubagentProviderLabel(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'codex') return 'Codex';
  if (normalized === 'claude') return 'Claude';
  if (!normalized) return 'Unknown';
  return provider;
}

function describeControlReason(reason?: string): string {
  switch (reason) {
    case 'active_runtime':
      return i18n.t('explorer.runtimeActive', { ns: 'subagent' });
    case 'inactive_runtime':
      return i18n.t('explorer.runtimeEnded', { ns: 'subagent' });
    case 'history_only':
      return i18n.t('explorer.historyOnly', { ns: 'subagent' });
    case 'legacy_active_runtime':
      return i18n.t('explorer.legacyActive', { ns: 'subagent' });
    case 'provider_read_only_runtime':
      return i18n.t('explorer.readonlySnapshot', { ns: 'subagent' });
    default:
      return i18n.t('explorer.unknown', { ns: 'subagent' });
  }
}

function compareRuntimeEntries(left: SubagentRuntimeEntry, right: SubagentRuntimeEntry): number {
  const updatedAtOrder = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedAtOrder !== 0) return updatedAtOrder;
  return right.id.localeCompare(left.id);
}

function buildRuntimeTree(items: SubagentRuntimeEntry[]): RuntimeTreeNode[] {
  const nodes = new Map<string, RuntimeTreeNode>();
  for (const item of items) {
    nodes.set(item.id, {
      item,
      children: [],
    });
  }

  const roots: RuntimeTreeNode[] = [];
  for (const item of items) {
    const node = nodes.get(item.id);
    if (!node) continue;
    const parentId = item.parentRuntimeId?.trim();
    if (parentId && parentId !== item.id) {
      const parentNode = nodes.get(parentId);
      if (parentNode) {
        parentNode.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  const sortTree = (tree: RuntimeTreeNode[]) => {
    tree.sort((left, right) => compareRuntimeEntries(left.item, right.item));
    for (const node of tree) {
      sortTree(node.children);
    }
  };

  sortTree(roots);
  return roots;
}

function supportsAction(
  item: SubagentRuntimeEntry,
  action: 'stop' | 'message' | 'steer',
): boolean {
  if (item.controlActions?.includes(action)) {
    return true;
  }

  if (action === 'stop') {
    if (item.capabilities?.canStop === true) return true;
    return (
      isActiveRuntimeStatus(item.status) &&
      item.controllable !== false &&
      item.controlState !== 'read_only'
    );
  }

  if (action === 'message') {
    return item.capabilities?.canMessage === true;
  }

  return item.capabilities?.canSteer === true;
}

function getIdentityLines(item: SubagentRuntimeEntry): string[] {
  return [
    item.runtimeKind ? i18n.t('info.type', { kind: item.runtimeKind, ns: 'subagent' }) : '',
    item.providerSessionId ? i18n.t('explorer.session', { id: item.providerSessionId, ns: 'subagent' }) : '',
    item.controllerSessionKey ? i18n.t('explorer.controller', { key: item.controllerSessionKey, ns: 'subagent' }) : '',
    item.requesterSessionKey ? i18n.t('explorer.requester', { key: item.requesterSessionKey, ns: 'subagent' }) : '',
    item.workProfile ? i18n.t('info.workProfile', { name: item.workProfile, ns: 'subagent' }) : '',
    item.topologyRole || item.role
      ? i18n.t('info.topologyRole', { role: item.topologyRole || item.role, ns: 'subagent' })
      : '',
    item.controlScope ? i18n.t('explorer.scopeRange', { scope: item.controlScope, ns: 'subagent' }) : '',
    item.originTurnId ? i18n.t('explorer.originTurn', { id: item.originTurnId, ns: 'subagent' }) : '',
    item.originToolCallId ? i18n.t('explorer.originTool', { id: item.originToolCallId, ns: 'subagent' }) : '',
  ].filter(Boolean);
}

function RuntimeComposer(props: {
  item: SubagentRuntimeEntry;
  mode: ComposerMode;
  pendingActionKey?: string;
  onSubmit: (runtimeId: string, prompt: string, mode: ComposerMode) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation('subagent');
  const [draft, setDraft] = useState('');
  const actionKey = `${props.mode}:${props.item.id}`;
  const submitting = props.pendingActionKey === actionKey;

  return (
    <div className="subagent-runtime-composer">
      <textarea
        value={draft}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
          setDraft(event.target.value)
        }
        placeholder={
          props.mode === 'message'
            ? t('composer.placeholderMessage')
            : t('composer.placeholderSteer')
        }
        rows={3}
      />
      <div className="modal-actions">
        <button
          className="btn-primary btn-sm"
          disabled={submitting || !draft.trim()}
          onClick={async () => {
            const ok = await props.onSubmit(props.item.id, draft.trim(), props.mode);
            if (ok) {
              setDraft('');
              props.onCancel();
            }
          }}
        >
          {submitting
            ? props.mode === 'message'
              ? t('composer.sending')
              : t('composer.submitting')
            : props.mode === 'message'
              ? t('action.sendMessage')
              : t('action.sendSteer')}
        </button>
        <button
          className="btn-outline btn-sm"
          disabled={submitting}
          onClick={props.onCancel}
        >
          {t('composer.cancel')}
        </button>
      </div>
    </div>
  );
}

function RuntimeNode(props: {
  node: RuntimeTreeNode;
  pendingActionKey?: string;
  onStop: (runtimeId: string) => Promise<boolean>;
  onMessage: (runtimeId: string, prompt: string) => Promise<boolean>;
  onSteer: (runtimeId: string, prompt: string) => Promise<boolean>;
}) {
  const { t } = useTranslation('subagent');
  const { item } = props.node;
  const [composerMode, setComposerMode] = useState<ComposerMode | null>(null);
  const identityLines = getIdentityLines(item);
  const childCount =
    typeof item.childCount === 'number'
      ? item.childCount
      : props.node.children.length;
  const showHierarchyMeta =
    !!item.parentRuntimeId ||
    props.node.children.length > 0 ||
    typeof item.descendantCount === 'number' ||
    typeof item.activeDescendantCount === 'number' ||
    typeof item.pendingDescendantCount === 'number';
  const canStop = supportsAction(item, 'stop');
  const canMessage = supportsAction(item, 'message');
  const canSteer = supportsAction(item, 'steer');
  const stopActionKey = `stop:${item.id}`;
  const stopPending = props.pendingActionKey === stopActionKey;

  return (
    <div className="subagent-runtime-node">
      <div className="subagent-runtime-node-card">
        <div className="subagent-runtime-node-head">
          <div>
            <div className="subagent-runtime-node-title">
              {item.name || item.id}
            </div>
            <div className="subagent-runtime-node-meta">
              <span>{formatSubagentProviderLabel(item.provider)}</span>
              <span>{getRuntimeModeLabel(item.mode)}</span>
              <span>{getRuntimeStatusLabel(item.status)}</span>
              <span>{t('info.depth', { depth: item.depth })}</span>
            </div>
          </div>
          <div className="subagent-runtime-node-badges">
            <span className={`subagent-runtime-badge status-${item.status}`}>
              {getRuntimeStatusLabel(item.status)}
            </span>
            {item.controlState ? (
              <span className="subagent-runtime-badge subtle">
                {item.controlState === 'controllable' ? t('info.controllable') : t('info.readonly')}
              </span>
            ) : null}
          </div>
        </div>

        <div className="subagent-runtime-node-task">{item.task}</div>

        <div className="subagent-runtime-node-meta">
          <span>ID {item.id}</span>
          <span>{t('info.group', { value: item.groupFolder })}</span>
          <span>{t('info.sessionLabel', { value: item.chatJid })}</span>
          <span>{t('info.updated', { value: formatIsoTimestamp(item.updatedAt) })}</span>
          <span>{t('info.requestCount', { count: item.requestCount ?? 0 })}</span>
          {item.runtimeKind ? <span>{t('info.type', { kind: item.runtimeKind })}</span> : null}
          {item.providerSessionId ? <span>{t('info.providerSession', { value: item.providerSessionId })}</span> : null}
          {showHierarchyMeta ? (
            <span>
              {t('info.subtree', { descendant: item.descendantCount ?? props.node.children.length, active: item.activeDescendantCount ?? 0, children: childCount })}
            </span>
          ) : null}
        </div>

        {showHierarchyMeta ? (
          <div className="subagent-runtime-node-tree-meta">
            {item.parentRuntimeId ? (
              <span>{t('info.parentNode', { id: item.parentRuntimeId })}</span>
            ) : (
              <span>{t('info.rootNode')}</span>
            )}
            {props.node.children.length > 0 ? (
              <span>{t('info.directChildren', { count: props.node.children.length })}</span>
            ) : null}
          </div>
        ) : null}

        {identityLines.length > 0 ? (
          <details className="subagent-runtime-details">
            <summary>{t('details.identity')}</summary>
            <div className="subagent-runtime-detail-list">
              {identityLines.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          </details>
        ) : null}

        {item.stopRequestedAt || item.exitCode !== undefined || item.lastError || item.lastResultPreview ? (
          <details className="subagent-runtime-details">
            <summary>{t('details.runtimeDetails')}</summary>
            <div className="subagent-runtime-detail-list">
              {item.stopRequestedAt ? (
                <div>{t('details.stopRequested', { value: formatIsoTimestamp(item.stopRequestedAt) })}</div>
              ) : null}
              {item.exitCode !== undefined ? <div>{t('details.exitCode', { value: item.exitCode })}</div> : null}
              {item.lastError ? <div>{t('details.lastError', { value: item.lastError })}</div> : null}
              {item.lastResultPreview ? <div>{t('details.lastResult', { value: item.lastResultPreview })}</div> : null}
            </div>
          </details>
        ) : null}

        {(canStop || canMessage || canSteer) ? (
          <div className="subagent-runtime-actions">
            {canStop ? (
              <button
                className="btn-danger btn-sm"
                disabled={stopPending || item.status === 'stopping'}
                onClick={() => void props.onStop(item.id)}
              >
                {stopPending || item.status === 'stopping' ? t('action.stopping') : t('action.stop')}
              </button>
            ) : null}
            {canMessage ? (
              <button
                className="btn-outline btn-sm"
                disabled={props.pendingActionKey === `message:${item.id}`}
                onClick={() =>
                  setComposerMode((current) =>
                    current === 'message' ? null : 'message',
                  )
                }
              >
                {t('action.sendMessage')}
              </button>
            ) : null}
            {canSteer ? (
              <button
                className="btn-outline btn-sm"
                disabled={props.pendingActionKey === `steer:${item.id}`}
                onClick={() =>
                  setComposerMode((current) =>
                    current === 'steer' ? null : 'steer',
                  )
                }
              >
                Steer
              </button>
            ) : null}
          </div>
        ) : null}

        {composerMode ? (
          <RuntimeComposer
            item={item}
            mode={composerMode}
            pendingActionKey={props.pendingActionKey}
            onCancel={() => setComposerMode(null)}
            onSubmit={async (runtimeId, prompt, mode) =>
              mode === 'message'
                ? props.onMessage(runtimeId, prompt)
                : props.onSteer(runtimeId, prompt)
            }
          />
        ) : null}

        {(item.controllable === false || item.controlState === 'read_only') &&
        !(canMessage || canSteer || canStop) ? (
          <div className="settings-hint">
            {t('info.controlRestriction')}: <strong>{describeControlReason(item.controlReason)}</strong>
          </div>
        ) : null}
      </div>

      {props.node.children.length > 0 ? (
        <div className="subagent-runtime-children">
          {props.node.children.map((child) => (
            <RuntimeNode
              key={child.item.id}
              node={child}
              pendingActionKey={props.pendingActionKey}
              onStop={props.onStop}
              onMessage={props.onMessage}
              onSteer={props.onSteer}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SubagentRuntimeExplorer(props: SubagentRuntimeExplorerProps) {
  const { t } = useTranslation('subagent');
  const tree = useMemo(() => buildRuntimeTree(props.items), [props.items]);
  const hasHierarchy = useMemo(
    () =>
          props.items.some(
        (item) =>
          Boolean(item.parentRuntimeId) ||
          (Array.isArray(item.childRuntimeIds) && item.childRuntimeIds.length > 0) ||
          typeof item.childCount === 'number' ||
          typeof item.descendantCount === 'number' ||
          typeof item.activeDescendantCount === 'number' ||
          typeof item.pendingDescendantCount === 'number',
      ),
    [props.items],
  );

  if (props.items.length === 0) {
    return (
      <div className="config-info">
        <p>
          {t('explorer.emptyState')}
        </p>
      </div>
    );
  }

  return (
    <div className="subagent-runtime-explorer">
      <div className="settings-hint">
        {hasHierarchy
          ? t('explorer.hierarchyHint')
          : t('explorer.flatHint')}
      </div>
      <div className="subagent-runtime-root-list">
        {tree.map((node) => (
          <RuntimeNode
            key={node.item.id}
            node={node}
            pendingActionKey={props.pendingActionKey}
            onStop={props.onStop}
            onMessage={props.onMessage}
            onSteer={props.onSteer}
          />
        ))}
      </div>
    </div>
  );
}
