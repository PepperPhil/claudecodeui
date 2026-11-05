import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * A new chat starts from the selection of its project's latest session, an
 * open session restores what the backend recorded for it, and anything the
 * user picks wins over both, also against a load that overlaps the save.
 *
 * The api mock is a tiny backend: one session row that saves write and loads
 * read, with hooks to hold a save or a read until the test lets it finish.
 */

const { backend } = vi.hoisted(() => {
  const okJson = (data: unknown) => ({ ok: true, json: async () => data });
  type Row = { model: string | null; effort: string | null; permissionMode: string | null };
  const backend = {
    okJson,
    row: { model: 'sonnet', effort: null, permissionMode: 'plan' } as Row,
    project: { model: 'opus', effort: null, permissionMode: 'acceptEdits' } as Row | null,
    /** Awaited before a save writes the row, or before a read answers. */
    beforeSave: null as Promise<void> | null,
    beforeRead: null as Promise<void> | null,
    failEffort: false,
    reads: 0,
    savedModes: [] as Array<[string, string, string]>,
    async save(field: keyof Row, value: string) {
      if (backend.beforeSave) {
        await backend.beforeSave;
      }
      backend.row[field] = value;
      return okJson({ success: true, data: null });
    },
  };
  return { backend };
});

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: async () => backend.okJson({ success: true, preferences: {} }),
      savePreferences: async () => backend.okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: async (provider: string) => backend.okJson({
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
      capabilities: async () => backend.okJson({ success: true, data: null }),
      sessionActiveModel: async () => {
        // Snapshot first: the row as it was when the read reached the server.
        const snapshot = { ...backend.row };
        backend.reads += 1;
        if (backend.beforeRead) {
          await backend.beforeRead;
        }
        return backend.okJson({ success: true, data: { ...snapshot, source: 'session' } });
      },
      setSessionActiveModel: (_provider: string, _sessionId: string, model: string) => backend.save('model', model),
      setSessionActiveEffort: async (_provider: string, _sessionId: string, effort: string) => (
        backend.failEffort ? { ok: false, json: async () => ({ success: false }) } : backend.save('effort', effort)
      ),
      setSessionActivePermissionMode: (provider: string, sessionId: string, mode: string) => {
        backend.savedModes.push([provider, sessionId, mode]);
        return backend.save('permissionMode', mode);
      },
      projectSelection: async () => backend.okJson({ success: true, data: backend.project }),
    },
  },
}));

const project = { projectId: 'project-1', displayName: 'repo', fullPath: '/repo' } as Project;

/** A gate the test opens itself, after doing something in between. */
const gate = () => {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

const renderProviderState = async (initialSession: ProjectSession | null) => {
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  return renderHook(
    ({ selectedSession, newSessionTrigger }: { selectedSession: ProjectSession | null; newSessionTrigger?: number }) => (
      useChatProviderState({ selectedSession, selectedProject: project, newSessionTrigger })
    ),
    { initialProps: { selectedSession: initialSession, newSessionTrigger: 0 } as { selectedSession: ProjectSession | null; newSessionTrigger?: number } },
  );
};

const session = (id: string) => ({ id, __provider: 'claude' }) as ProjectSession;

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  backend.row = { model: 'sonnet', effort: null, permissionMode: 'plan' };
  backend.project = { model: 'opus', effort: null, permissionMode: 'acceptEdits' };
  backend.beforeSave = null;
  backend.beforeRead = null;
  backend.failEffort = false;
  backend.reads = 0;
  backend.savedModes = [];
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
  assert.equal(backend.savedModes.length, 0);
});

test('a pick made before the project selection arrives keeps that field only', async () => {
  localStorage.setItem('claude-model', 'sonnet');
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: project }));

  // Synchronously after mount, before the project request has answered.
  act(() => {
    result.current.selectPermissionMode('plan');
  });

  await waitFor(() => {
    assert.equal(result.current.currentProviderModel, 'opus');
  });
  assert.equal(result.current.permissionMode, 'plan');
});

test('the empty state shows the project model and its own pick replaces it', async () => {
  localStorage.setItem('claude-model', 'sonnet');
  const { result } = await renderProviderState(null);

  await waitFor(() => {
    assert.equal(result.current.providerModels.claude, 'opus');
  });

  // Custom-model housekeeping writes the stored default; that is not a pick.
  act(() => {
    result.current.setStoredProviderModel('claude', 'sonnet');
  });
  assert.equal(result.current.currentProviderModel, 'opus');

  // The empty-state picker goes through the same pick as the composer.
  await act(async () => {
    await result.current.selectProviderModel('claude', 'sonnet', null);
  });

  assert.equal(result.current.currentProviderModel, 'sonnet');
  assert.equal(result.current.providerModels.claude, 'sonnet');
});

test('an open session restores and saves its backend permission mode', async () => {
  localStorage.setItem('permissionMode-last-claude', 'default');
  const { result } = await renderProviderState(session('session-1'));

  await waitFor(() => {
    assert.equal(result.current.permissionMode, 'plan');
  });

  act(() => {
    result.current.selectPermissionMode('acceptEdits');
  });

  assert.equal(result.current.permissionMode, 'acceptEdits');
  assert.deepEqual(backend.savedModes[0], ['claude', 'session-1', 'acceptEdits']);
  // Kept as a synchronous cache for the next open, before the backend answers.
  assert.equal(localStorage.getItem('permissionMode-session-1'), 'acceptEdits');
});

test('a mode picked while the session loads survives that load', async () => {
  const read = gate();
  backend.beforeRead = read.promise;
  const { result } = await renderProviderState(session('session-1'));
  await waitFor(() => {
    assert.equal(backend.reads, 1);
  });

  // The read already took its snapshot of the row ('plan').
  act(() => {
    result.current.selectPermissionMode('acceptEdits');
  });
  backend.beforeRead = null;
  await act(async () => {
    read.open();
  });

  await waitFor(() => {
    assert.equal(backend.reads, 2);
  });
  assert.equal(result.current.permissionMode, 'acceptEdits');
});

test('a new chat keeps its selection while its new session loads', async () => {
  localStorage.setItem('claude-model', 'sonnet');
  localStorage.setItem('permissionMode-last-claude', 'default');
  backend.beforeRead = gate().promise;
  const { result, rerender } = await renderProviderState(null);

  await waitFor(() => {
    assert.equal(result.current.currentProviderModel, 'opus');
    assert.equal(result.current.permissionMode, 'acceptEdits');
  });

  // The chat gets its id before navigation selects its session.
  act(() => {
    result.current.seedSessionSelection('claude', 'session-new', {
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
    });
  });
  rerender({ selectedSession: session('session-new') });

  // The row has not answered yet; nothing may fall back to sonnet/default.
  assert.equal(result.current.currentProviderModel, 'opus');
  assert.equal(result.current.permissionMode, 'acceptEdits');
});

test('picks made before the new session is selected are read back by its first load', async () => {
  backend.row = { model: 'opus', effort: null, permissionMode: 'acceptEdits' };
  const save = gate();
  backend.beforeSave = save.promise;
  const { result, rerender } = await renderProviderState(null);

  act(() => {
    result.current.seedSessionSelection('claude', 'session-new', { model: 'opus', permissionMode: 'acceptEdits' });
  });
  let modelPick: Promise<unknown> = Promise.resolve();
  act(() => {
    // The composer passes the new id it already has.
    modelPick = result.current.selectProviderModel('claude', 'sonnet', 'session-new');
    result.current.selectPermissionMode('plan');
  });
  assert.deepEqual(backend.savedModes[0], ['claude', 'session-new', 'plan']);

  rerender({ selectedSession: session('session-new') });
  // The load must not read the row while the saves are still on their way.
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(backend.reads, 0);

  await act(async () => {
    save.open();
    await modelPick;
  });

  await waitFor(() => {
    assert.equal(backend.reads, 1);
  });
  assert.equal(result.current.currentProviderModel, 'sonnet');
  assert.equal(result.current.permissionMode, 'plan');
});

test('a New Session click forgets the session the previous new chat created', async () => {
  const { result, rerender } = await renderProviderState(null);

  act(() => {
    result.current.seedSessionSelection('claude', 'session-new', { model: 'opus' });
  });
  rerender({ selectedSession: null, newSessionTrigger: 1 });
  act(() => {
    result.current.selectPermissionMode('plan');
  });

  assert.equal(backend.savedModes.length, 0);
});

test('a refused mode save takes the mode back', async () => {
  // An older session: no recorded mode, so the per-provider key answers.
  backend.row.permissionMode = null;
  localStorage.setItem('permissionMode-last-claude', 'plan');
  const { result } = await renderProviderState(session('session-1'));
  await waitFor(() => {
    assert.equal(backend.reads, 1);
    assert.equal(result.current.permissionMode, 'plan');
  });

  const { api } = await import('@/shared/api');
  const refuse = vi.spyOn(api.providers, 'setSessionActivePermissionMode')
    .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ success: false }) } as Response);
  await act(async () => {
    result.current.selectPermissionMode('acceptEdits');
    await refuse.mock.results[0]?.value;
  });

  await waitFor(() => {
    assert.equal(result.current.permissionMode, 'plan');
  });
  assert.equal(localStorage.getItem('permissionMode-session-1'), null);
  assert.equal(localStorage.getItem('permissionMode-last-claude'), 'plan');
});

test('a failed effort save rolls back only the effort', async () => {
  backend.failEffort = true;
  const { result } = await renderProviderState(session('session-1'));
  await waitFor(() => {
    assert.equal(result.current.permissionMode, 'plan');
  });
  const effortBefore = result.current.currentProviderEffort;

  await act(async () => {
    const pending = result.current.selectProviderEffort('claude', 'high', 'session-1');
    // Picked while the effort save is in flight.
    result.current.selectPermissionMode('acceptEdits');
    await pending.catch(() => {});
  });

  assert.equal(result.current.permissionMode, 'acceptEdits');
  assert.equal(result.current.currentProviderEffort, effortBefore);
});
