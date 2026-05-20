
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChannelTypeDefinition } from '../../app-types';
import { IconChevronDown } from '../../components/AppIcons';
import { renderBooleanField } from './settings-field-renderers';

export type SettingsChannelsTabProps = {
  channelTypes: ChannelTypeDefinition[];
  channelInstances: import('../../app-types').ChannelInstanceConfig[];
  addChannelInstance: (type: string) => void;
  saveChannelSettings: () => void;
  savingChannelConfig: boolean;
  channelConfigMessage: string;
  removeChannelInstance: (id: string) => void;
  updateChannelInstance: (
    id: string,
    updater: (instance: import('../../app-types').ChannelInstanceConfig) => import('../../app-types').ChannelInstanceConfig,
  ) => void;
  renderChannelField: (
    instance: import('../../app-types').ChannelInstanceConfig,
    field: import('../../app-types').ChannelFieldDefinition,
  ) => ReactNode;
  canAddChannelInstance: (type: ChannelTypeDefinition) => boolean;
  getOrderedChannelFields: (type: ChannelTypeDefinition) => import('../../app-types').ChannelFieldDefinition[];
  isChannelMessageError: boolean;
};

export function SettingsChannelsTab(props: SettingsChannelsTabProps) {
  const { t } = useTranslation('settings');
  const {
    channelTypes,
    channelInstances,
    addChannelInstance,
    saveChannelSettings,
    savingChannelConfig,
    channelConfigMessage,
    removeChannelInstance,
    updateChannelInstance,
    renderChannelField,
    canAddChannelInstance,
    getOrderedChannelFields,
    isChannelMessageError,
  } = props;

  return (
  <div className="settings-tab-stack">
  <section className="settings-subsection">
    <div className="section-header">
      <div>
        <h3>{t('settings.channels.pageTitle')}</h3>
        <p className="settings-hint">
          {t('settings.channels.pageHint')}
        </p>
      </div>
    </div>

    {channelTypes.length === 0 && (
      <div className="provider-empty">
        {t('settings.channels.emptyType')}
      </div>
    )}

    <div className="channel-type-groups">
      {channelTypes.map((definition) => {
        const instances = channelInstances.filter(
          (instance) => instance.type === definition.type,
        );
        const orderedFields = getOrderedChannelFields(definition);
        const pinnedFields =
          definition.type === 'feishu'
            ? orderedFields.filter(
                (field) => field.key === 'replyInThread',
              )
            : [];
        const gridFields = orderedFields.filter(
          (field) => field.key !== 'replyInThread',
        );

        return (
          <section
            key={definition.type}
            className="channel-type-group settings-advanced-block"
          >
            <div className="channel-type-group-header">
              <div>
                <div className="channel-type-group-title">
                  {definition.label}
                </div>
                <div className="settings-hint">
                  {definition.description}
                </div>
              </div>
              <button
                className="btn-primary btn-sm"
                onClick={() => addChannelInstance(definition.type)}
                disabled={!canAddChannelInstance(definition)}
              >
                {t('settings.channels.addInstanceLabel', { label: definition.label })}
              </button>
            </div>

            {instances.length === 0 ? (
              <div className="provider-empty channel-type-group-empty">
                {t('settings.channels.noInstances')}
              </div>
            ) : (
              <div className="channel-instance-list">
                {instances.map((instance) => (
                  <details
                    key={instance.id}
                    className="channel-instance-card channel-instance-details"
                  >
                    <summary className="channel-instance-summary">
                      <div className="channel-instance-summary-main">
                        <div className="channel-instance-title">
                          {instance.name.trim() ||
                            t('settings.channels.instanceFallback', { label: definition.label })}
                        </div>
                        <div className="settings-hint">
                          {t('settings.channels.instanceSubtitle', { label: definition.label, id: instance.id })}
                        </div>
                      </div>
                      <div className="channel-instance-summary-side">
                        <span
                          className={`channel-instance-status ${instance.enabled ? 'enabled' : 'disabled'}`}
                        >
                          {instance.enabled ? t('settings.channels.enabled') : t('settings.channels.disabled')}
                        </span>
                        <span
                          className={`channel-instance-status ${instance.visibility === 'private' ? 'disabled' : 'enabled'}`}
                        >
                          {instance.visibility === 'private'
                            ? t('settings.channels.visibilityPrivate')
                            : t('settings.channels.visibilityPublic')}
                        </span>
                        <span
                          className="channel-instance-summary-icon"
                          aria-hidden="true"
                        >
                          <IconChevronDown />
                        </span>
                      </div>
                    </summary>

                    <div className="channel-instance-content">
                      <div className="channel-instance-header">
                        <div className="channel-instance-title">
                          {instance.name.trim() ||
                            t('settings.channels.instanceFallback', { label: definition.label })}
                        </div>
                        <button
                          className="btn-danger btn-sm"
                          onClick={() =>
                            removeChannelInstance(instance.id)
                          }
                        >
                          {t('settings.channels.remove')}
                        </button>
                      </div>

                      <div className="form-group">
                        <label>{t('settings.channels.instanceName')}</label>
                        <input
                          value={instance.name}
                          onChange={(event) =>
                            updateChannelInstance(
                              instance.id,
                              (current) => ({
                                ...current,
                                name: event.target.value,
                              }),
                            )
                          }
                          placeholder={t('settings.channels.instanceNamePlaceholder', { label: definition.label })}
                        />
                      </div>

                      {renderBooleanField(
                        `channel:${instance.id}:enabled`,
                        t('settings.channels.enableInstance'),
                        t('settings.channels.enableInstanceHint'),
                        instance.enabled,
                        (nextValue) =>
                          updateChannelInstance(
                            instance.id,
                            (current) => ({
                              ...current,
                              enabled: nextValue,
                            }),
                          ),
                      )}

                      {renderBooleanField(
                        `channel:${instance.id}:visibility`,
                        t('settings.channels.visibilityLabel'),
                        t('settings.channels.visibilityHint'),
                        instance.visibility !== 'private',
                        (nextValue) =>
                          updateChannelInstance(
                            instance.id,
                            (current) => ({
                              ...current,
                              visibility: nextValue
                                ? 'public'
                                : 'private',
                            }),
                          ),
                      )}

                      {pinnedFields.map((field) =>
                        renderChannelField(instance, field),
                      )}

                      <div className="channel-instance-grid">
                        {gridFields.map((field) =>
                          renderChannelField(instance, field),
                        )}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>

    <div className="modal-actions">
      <button
        className="btn-primary"
        onClick={saveChannelSettings}
        disabled={savingChannelConfig}
      >
        {savingChannelConfig ? t('settings.channels.saving') : t('settings.channels.save')}
      </button>
    </div>

    {channelConfigMessage && (
      <div
        className={`test-result ${isChannelMessageError ? 'error' : 'success'}`}
      >
        {channelConfigMessage}
      </div>
    )}
  </section>
  </div>

  );
}
