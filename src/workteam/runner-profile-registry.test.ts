import { describe, it, expect, beforeEach } from 'vitest';
import {
  setProfileForChat,
  getProfileForChat,
  clearProfileForChat,
  resetRegistry,
} from './runner-profile-registry.js';
import { findProfileById } from './runner-profiles.js';

const chatA = 'web:workteam-t1-a1-task-A';
const chatB = 'web:workteam-t1-a1-task-B';

describe('runner-profile-registry', () => {
  beforeEach(() => {
    resetRegistry();
  });

  it('returns undefined when no profile is registered', () => {
    expect(getProfileForChat(chatA)).toBeUndefined();
  });

  it('set then get returns the same profile', () => {
    const java8 = findProfileById('java8')!;
    setProfileForChat(chatA, java8);
    expect(getProfileForChat(chatA)?.id).toBe('java8');
  });

  it('different chats have isolated profiles', () => {
    const java8 = findProfileById('java8')!;
    const go = findProfileById('go')!;
    setProfileForChat(chatA, java8);
    setProfileForChat(chatB, go);
    expect(getProfileForChat(chatA)?.id).toBe('java8');
    expect(getProfileForChat(chatB)?.id).toBe('go');
  });

  it('clearProfileForChat removes the entry for that chat only', () => {
    const java8 = findProfileById('java8')!;
    const go = findProfileById('go')!;
    setProfileForChat(chatA, java8);
    setProfileForChat(chatB, go);
    clearProfileForChat(chatA);
    expect(getProfileForChat(chatA)).toBeUndefined();
    expect(getProfileForChat(chatB)?.id).toBe('go');
  });

  it('resetRegistry clears all entries', () => {
    setProfileForChat(chatA, findProfileById('java8')!);
    setProfileForChat(chatB, findProfileById('go')!);
    resetRegistry();
    expect(getProfileForChat(chatA)).toBeUndefined();
    expect(getProfileForChat(chatB)).toBeUndefined();
  });

  it('setProfileForChat with same chat overwrites previous', () => {
    setProfileForChat(chatA, findProfileById('java8')!);
    setProfileForChat(chatA, findProfileById('go')!);
    expect(getProfileForChat(chatA)?.id).toBe('go');
  });

  it('clearProfileForChat on unknown chat is a no-op', () => {
    expect(() => clearProfileForChat('unknown')).not.toThrow();
  });

  it('empty chatJid is ignored on both set and get', () => {
    const java8 = findProfileById('java8')!;
    setProfileForChat('', java8);
    expect(getProfileForChat('')).toBeUndefined();
  });
});
