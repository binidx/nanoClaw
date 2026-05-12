import { describe, expect, it, vi } from 'vitest';

const soulDbMocks = vi.hoisted(() => ({
  getUserSoul: vi.fn(),
  getUserCoreMemories: vi.fn(),
  getActivePersonaInsights: vi.fn(),
  touchUserMemoryAccess: vi.fn(async () => undefined),
}));

vi.mock('../db.js', async () => {
  const actual = await vi.importActual<typeof import('../db.js')>('../db.js');
  return {
    ...actual,
    getUserSoul: soulDbMocks.getUserSoul,
    getUserCoreMemories: soulDbMocks.getUserCoreMemories,
    getActivePersonaInsights: soulDbMocks.getActivePersonaInsights,
    touchUserMemoryAccess: soulDbMocks.touchUserMemoryAccess,
  };
});

import { buildSoulPrompt } from './soul-service.js';

describe('soul prompt assembly', () => {
  it('omits verbose identity field labels and low-confidence persona insights', async () => {
    soulDbMocks.getUserSoul.mockResolvedValue({
      id: 'soul-1',
      user_id: 'u1',
      name: 'moon',
      emoji: '🌙',
      emoji_enabled: 1,
      creature: '小猫娘',
      vibe: '温柔',
      persona_prompt: '你是一个温柔善良的AI助手，名叫moon。',
      tone: 'gentle',
      language_preference: '中文',
      extra_instructions: '回复保持自然。',
      user_nickname: '阿迪',
      behavior_rules: null,
      auto_evolve: 1,
      consolidation_config: null,
      enabled: 1,
      created_at: '',
      updated_at: '',
    });
    soulDbMocks.getUserCoreMemories.mockResolvedValue([
      {
        id: 'm1',
        user_id: 'u1',
        scope: 'global',
        conversation_id: null,
        category: 'preference',
        content: '用户偏好直接切重点',
        importance: 9,
        confidence: 0.9,
        source: 'manual',
        tier: 'core',
        promoted_from: null,
        last_verified_at: null,
        source_event_id: null,
        valid_from: null,
        valid_to: null,
        access_count: 0,
        last_accessed_at: null,
        expires_at: null,
        created_at: '',
        updated_at: '',
      },
    ]);
    soulDbMocks.getActivePersonaInsights.mockResolvedValue([
      {
        id: 'i-low',
        user_id: 'u1',
        insight_type: 'communication_style',
        content: '用户偏好突出重点',
        confidence: 0.3,
        source_observation_ids_json: '[]',
        status: 'active',
        created_at: '',
        updated_at: '',
      },
      {
        id: 'i-high',
        user_id: 'u1',
        insight_type: 'response_preference',
        content: '用户喜欢直达重点',
        confidence: 0.9,
        source_observation_ids_json: '[]',
        status: 'active',
        created_at: '',
        updated_at: '',
      },
    ]);

    const prompt = await buildSoulPrompt('u1', 'web:demo', '你好');

    expect(prompt).not.toContain('灵魂配置已启用');
    expect(prompt).not.toContain('yourName');
    expect(prompt).not.toContain('userNickname');
    expect(prompt).not.toContain('personaImage');
    expect(prompt).not.toContain('overallVibe');
    expect(prompt).not.toContain('置信度');
    expect(prompt).toContain('用户喜欢直达重点');
    expect(prompt).not.toContain('用户偏好突出重点');
    expect(prompt).toContain('Use memory tools');
  });
});
