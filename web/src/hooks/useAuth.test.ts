// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthStatus } from '../app-types';
import { useAuth } from './useAuth';

function renderUseAuth(status: AuthStatus | null) {
  const snapshot: { current?: ReturnType<typeof useAuth> } = {};
  function Host(props: { status: AuthStatus | null }) {
    snapshot.current = useAuth(props.status);
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(Host, { status }));
  });
  return {
    get auth() {
      return snapshot.current!;
    },
    unmount() {
      act(() => {
        root.unmount();
      });
    },
  };
}

describe('useAuth', () => {
  let last: ReturnType<typeof renderUseAuth> | undefined;

  afterEach(() => {
    last?.unmount();
    last = undefined;
  });

  it('grants permissions from a valid multi-user auth payload', () => {
    last = renderUseAuth({
      authenticated: true,
      username: 'alice',
      multiUserMode: true,
      permissions: ['system.users'],
      roles: ['admin'],
    });
    const auth = last.auth;

    expect(auth.hasPermission('system.users')).toBe(true);
    expect(auth.hasPermission('system.roles')).toBe(false);
    expect(auth.roles).toEqual(['admin']);
  });

  it('does not throw when permissions or roles are malformed', () => {
    last = renderUseAuth({
      authenticated: true,
      username: 'alice',
      multiUserMode: true,
      permissions: { all: true } as unknown as string[],
      roles: 'admin' as unknown as string[],
    });
    const auth = last.auth;

    expect(auth.hasPermission('system.users')).toBe(false);
    expect(auth.permissions).toEqual([]);
    expect(auth.roles).toEqual([]);
  });

  it('canAccessPage respects permission mapping in multi-user mode', () => {
    last = renderUseAuth({
      authenticated: true,
      username: 'dev01',
      multiUserMode: true,
      permissions: ['review.view', 'conversation.view'],
      roles: ['developer'],
    });
    const auth = last.auth;

    expect(auth.canAccessPage('chat')).toBe(true);
    expect(auth.canAccessPage('repos')).toBe(true);
    expect(auth.canAccessPage('reviews')).toBe(true);
    expect(auth.canAccessPage('settings')).toBe(false);
    expect(auth.canAccessPage('users')).toBe(false);
    expect(auth.canAccessPage('assistants')).toBe(false);
    expect(auth.canAccessPage('tasks')).toBe(false);
  });

  it('canAccessPage allows repos with repository.view permission', () => {
    last = renderUseAuth({
      authenticated: true,
      username: 'dev02',
      multiUserMode: true,
      permissions: ['repository.view', 'conversation.view'],
      roles: ['developer'],
    });
    const auth = last.auth;

    expect(auth.canAccessPage('repos')).toBe(true);
    expect(auth.canAccessPage('reviews')).toBe(false);
  });

  it('canAccessPage grants all pages in single-user mode', () => {
    last = renderUseAuth({
      authenticated: true,
      username: 'admin',
      multiUserMode: false,
    });
    const auth = last.auth;

    expect(auth.canAccessPage('chat')).toBe(true);
    expect(auth.canAccessPage('settings')).toBe(true);
    expect(auth.canAccessPage('users')).toBe(true);
    expect(auth.canAccessPage('assistants')).toBe(true);
  });
});
