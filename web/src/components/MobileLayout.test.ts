// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { MobileLayout, type MobileLayoutProps } from './MobileLayout';
import i18n, { initI18n } from '../i18n';

function click(node: Element | null) {
  if (!node) throw new Error('Expected element to exist');
  act(() => {
    if (node instanceof HTMLElement) node.focus();
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function renderMobileLayout(overrides: Partial<MobileLayoutProps> = {}) {
  const props: MobileLayoutProps = {
    page: 'chat',
    setPage: vi.fn(),
    children: React.createElement('div', null, 'content'),
    conversationDrawerOpen: false,
    onToggleConversationDrawer: vi.fn(),
    conversationSidebar: null,
    canAccessPage: () => true,
    online: true,
    loginEnabled: true,
    loginDisplayName: 'alice',
    theme: 'dark',
    toggleTheme: vi.fn(),
    onLogout: vi.fn(),
    stockAnalysisEnabled: true,
    terminalEnabled: true,
    ...overrides,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(MobileLayout, props));
  });
  return {
    container,
    props,
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('MobileLayout', () => {
  let rendered: ReturnType<typeof renderMobileLayout> | undefined;

  beforeAll(async () => {
    await initI18n();
    await i18n.changeLanguage('zh');
  });

  afterEach(async () => {
    rendered?.unmount();
    rendered = undefined;
    vi.restoreAllMocks();
    await i18n.changeLanguage('zh');
  });

  it('shows theme and logout actions from the mobile account menu', () => {
    rendered = renderMobileLayout();

    click(rendered.container.querySelector('[aria-label="打开账户与显示设置"]'));

    expect(rendered.container.textContent).toContain('alice');
    expect(rendered.container.textContent).toContain('切换到浅色模式');
    expect(rendered.container.textContent).toContain('退出登录');
  });

  it('invokes the supplied mobile account actions', () => {
    const toggleTheme = vi.fn();
    const onLogout = vi.fn();
    rendered = renderMobileLayout({ toggleTheme, onLogout });

    click(rendered.container.querySelector('[aria-label="打开账户与显示设置"]'));
    click(
      Array.from(rendered.container.querySelectorAll('button')).find((node) =>
        node.textContent?.includes('切换到浅色模式'),
      ) ?? null,
    );
    expect(toggleTheme).toHaveBeenCalledTimes(1);

    click(rendered.container.querySelector('[aria-label="打开账户与显示设置"]'));
    click(
      Array.from(rendered.container.querySelectorAll('button')).find((node) =>
        node.textContent?.includes('退出登录'),
      ) ?? null,
    );
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('shows a language switch action in the mobile account menu', () => {
    const changeLanguage = vi.spyOn(i18n, 'changeLanguage').mockResolvedValue(
      i18n as never,
    );
    rendered = renderMobileLayout();
    const expectedLanguageText = i18n.language?.toLowerCase().startsWith('zh')
      ? '切换到英文'
      : 'Switch to Chinese';

    click(rendered.container.querySelector('[aria-label="打开账户与显示设置"]'));

    expect(rendered.container.textContent).toContain(expectedLanguageText);
    click(
      Array.from(rendered.container.querySelectorAll('button')).find((node) =>
        node.textContent?.includes(expectedLanguageText),
      ) ?? null,
    );
    expect(changeLanguage).toHaveBeenCalledWith(
      expectedLanguageText === '切换到英文' ? 'en' : 'zh',
    );
    changeLanguage.mockRestore();
  });

  it('uses dialog semantics and restores focus when the account popup closes', () => {
    rendered = renderMobileLayout();

    const trigger = rendered.container.querySelector(
      '[aria-label="打开账户与显示设置"]',
    ) as HTMLButtonElement | null;
    if (!trigger) throw new Error('Expected account trigger to exist');

    act(() => {
      trigger.focus();
    });
    click(trigger);

    const dialog = rendered.container.querySelector(
      '[role="dialog"][aria-label="账户与显示设置"]',
    );
    expect(dialog).not.toBeNull();
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');

    const themeButton = Array.from(
      rendered.container.querySelectorAll('button'),
    ).find((node) => node.textContent?.includes('切换到浅色模式')) as
      | HTMLButtonElement
      | undefined;
    expect(themeButton).toBeDefined();
    expect(document.activeElement).toBe(themeButton);

    click(rendered.container.querySelector('[aria-label="关闭账户菜单"]'));
    expect(document.activeElement).toBe(trigger);
  });
});
