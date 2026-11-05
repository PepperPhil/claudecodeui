import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * A new chat starts from the selection of its project's latest session, an
 * open session restores the permission mode the backend recorded for it, and
 * anything the user picks wins over both, even before those answers arrive.
 */

const { okJson, setSessionActivePermissionMode, responses } = vi.hoisted(() => {
  const okJson = (data: unknown) => Promise.resolve({
    ok: true,
    json: async () => data,
  });
  return {
    okJson,
    setSessionActivePermissionMode: vi.fn(() => okJson({ success: true, data: null })),
    // Tests that need to answer late swap these for a promise they resolve.
    responses: {
      projectSelection: () => okJson({
        success: true,
        data: { provider: 'claude', model: 'opus', effort: null, permissionMode: 'acceptEdits' },
      }),
      sessionActiveModel: () => okJson({
        success: true,
        data: { model: 'sonnet', effort: null, source: 'session', permissionMode: 'plan' },
      }),
    },
  };
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
      sessionActiveModel: () => responses.sessionActiveModel(),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
      setSessionActivePermissionMode,
      projectSelection: () => responses.projectSelection(),
    },
  },
}));

const defaultResponses = { ...responses };
const project = { projectId: 'project-1', displayName: 'repo', fullPath: '/repo' } as Project;

/** A response the test answers itself, after doing something in between. */
const deferred = () => {
  let resolve: (data: unknown) => void = () => {};
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return {
    respond: () => promise.then((data) => ({ ok: true, json: async () => data })),
    resolve,
  };
};

const renderProviderState = async (selectedSession: ProjectSession | null) => {
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  return renderHook(() => useChatProviderState({ selectedSession, selectedProject: project }));
};

beforeEach(() => {
  Object.assign(responses, defaultResponses);
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
  // An overlay, not a new per-provider default that other projects would inherit.
  assert.equal(localStorage.getItem('claude-model'), 'sonnet');
  assert.equal(localStorage.getItem('permissionMode-last-claude'), 'default');

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

test('a pick made before the project selection arrives keeps that field only', async () => {
  localStorage.setItem('claude-model', 'sonnet');
  const late = deferred();
  responses.projectSelection = late.respond;
  const { result } = await renderProviderState(null);

  act(() => {
    result.current.selectPermissionMode('plan');
  });
  await act(async () => {
    late.resolve({
      success: true,
      data: { provider: 'claude', model: 'opus', effort: null, permissionMode: 'acceptEdits' },
    });
  });

  await waitFor(() => {
    assert.equal(result.current.currentProviderModel, 'opus');
  });
  assert.equal(result.current.permissionMode, 'plan');
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

test('a mode picked while the session loads survives the late response', async () => {
  const late = deferred();
  responses.sessionActiveModel = late.respond;
  const session = { id: 'session-1', __provider: 'claude' } as ProjectSession;
  const { result } = await renderProviderState(session);

  act(() => {
    result.current.selectPermissionMode('acceptEdits');
  });
  await act(async () => {
    late.resolve({
      success: true,
      data: { model: 'opus', effort: null, source: 'session', permissionMode: 'plan' },
    });
  });

  await waitFor(() => {
    assert.equal(result.current.currentProviderModel, 'opus');
  });
  assert.equal(result.current.permissionMode, 'acceptEdits');
});

test('the empty state shows the project model and its own pick replaces it', async () => {
  localStorage.setItem('claude-model', 'sonnet');
  const { result } = await renderProviderState(null);

  await waitFor(() => {
    assert.equal(result.current.providerModels.claude, 'opus');
  });

  // The empty-state picker writes the per-provider default directly.
  act(() => {
    result.current.setStoredProviderModel('claude', 'sonnet');
  });

  assert.equal(result.current.currentProviderModel, 'sonnet');
  assert.equal(result.current.providerModels.claude, 'sonnet');
});
