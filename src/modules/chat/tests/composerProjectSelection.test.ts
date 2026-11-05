import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * A new chat starts from the selection of its project's latest session, an
 * open session restores the permission mode the backend recorded for it, and
 * anything the user picks wins over both.
 */

const { okJson, setSessionActivePermissionMode } = vi.hoisted(() => {
  const okJson = (data: unknown) => Promise.resolve({
    ok: true,
    json: async () => data,
  });
  return { okJson, setSessionActivePermissionMode: vi.fn(() => okJson({ success: true, data: null })) };
});

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: (provider: string) => okJson({
        success: true,
        data: provider === 'claude'
          ? {
            models: {
              OPTIONS: [{ value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }],
              DEFAULT: 'sonnet',
            },
          }
          : null,
      }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => okJson({
        success: true,
        data: { model: 'sonnet', effort: null, source: 'session', permissionMode: 'plan' },
      }),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
      setSessionActivePermissionMode,
      projectSelection: () => okJson({
        success: true,
        data: { provider: 'claude', model: 'opus', effort: null, permissionMode: 'acceptEdits' },
      }),
    },
  },
}));

const project = { projectId: 'project-1', displayName: 'repo', fullPath: '/repo' } as Project;

const renderProviderState = async (selectedSession: ProjectSession | null) => {
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  return renderHook(() => useChatProviderState({ selectedSession, selectedProject: project }));
};

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  setSessionActivePermissionMode.mockClear();
});

afterEach(() => {
  vi.resetModules();
});

test('a new chat starts from the project selection until the user picks', async () => {
  localStorage.setItem('claude-model', 'sonnet');
  localStorage.setItem('permissionMode-last-claude', 'default');
  const { result } = await renderProviderState(null);

  await waitFor(() => {
    assert.equal(result.current.currentProviderModel, 'opus');
    assert.equal(result.current.permissionMode, 'acceptEdits');
  });
  // Applied as the per-provider default, so it still holds once the first
  // send gives the chat a session id.
  assert.equal(localStorage.getItem('claude-model'), 'opus');
  assert.equal(localStorage.getItem('permissionMode-last-claude'), 'acceptEdits');

  act(() => {
    result.current.selectPermissionMode('plan');
  });
  await act(async () => {
    await result.current.selectProviderModel('claude', 'sonnet', null);
  });

  assert.equal(result.current.permissionMode, 'plan');
  assert.equal(result.current.currentProviderModel, 'sonnet');
  assert.equal(setSessionActivePermissionMode.mock.calls.length, 0);
});

test('an open session restores and saves its backend permission mode', async () => {
  localStorage.setItem('permissionMode-last-claude', 'default');
  const session = { id: 'session-1', __provider: 'claude' } as ProjectSession;
  const { result } = await renderProviderState(session);

  await waitFor(() => {
    assert.equal(result.current.permissionMode, 'plan');
  });

  act(() => {
    result.current.selectPermissionMode('acceptEdits');
  });

  assert.equal(result.current.permissionMode, 'acceptEdits');
  assert.deepEqual(setSessionActivePermissionMode.mock.calls[0], ['claude', 'session-1', 'acceptEdits']);
  // Kept as a synchronous cache for the next open, before the backend answers.
  assert.equal(localStorage.getItem('permissionMode-session-1'), 'acceptEdits');
});
