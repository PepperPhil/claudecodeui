import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { PendingPermissionRequest, PermissionMode,
  ProjectSession,
  LLMProvider,
  Project,
  CustomProviderModelInput,
  ProviderModelActions,
  ProviderModelOption,
  ProviderModelsDefinition,
  SessionEstablishedContext } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { readSelectedProvider, writeSelectedProvider } from '@/shared/selectedProvider';

const FALLBACK_PROVIDER_EFFORT_VALUES: Partial<Record<LLMProvider, readonly string[]>> = {
  // Superset used only before the model catalog loads; `ultracode` belongs to the
  // xhigh-capable models alone, but listing it here keeps a stored ultracode
  // selection from being reset during catalog hydration.
  claude: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  // Superset used only before the model catalog loads. Per-model metadata
  // narrows this once available; including the GPT-5.6 tiers here prevents a
  // valid Max/Ultra selection from being reset during catalog hydration.
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  opencode: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
};

const toProviderEffortOptions = (
  values: readonly string[],
): NonNullable<ProviderModelOption['effort']>['values'] => values.map((value) => ({ value }));

const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: 'default',
  cursor: 'gpt-5.3-codex',
  // The server catalog's DEFAULT. A new browser keeps this model for as long
  // as the catalog lists it, so it must be one the bundled Codex CLI knows;
  // any other model runs on the CLI's fallback metadata.
  codex: 'gpt-5.6-sol',
  opencode: 'anthropic/claude-sonnet-4-5',
};

const PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode'];

/** localStorage key holding the user's default model for one provider. */
const providerModelStorageKey = (provider: LLMProvider): string => `${provider}-model`;

/**
 * Fallback permission-mode matrix used only until the backend capability
 * matrix (`GET /api/providers/capabilities`) has loaded. The backend is the
 * source of truth; this mirror exists so the composer renders sensibly on
 * first paint and when the capabilities request fails.
 */
const FALLBACK_PERMISSION_MODES: Record<LLMProvider, PermissionMode[]> = {
  claude: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
  cursor: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  codex: ['default', 'acceptEdits', 'bypassPermissions'],
  opencode: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
};

type ProviderCapabilities = {
  provider: LLMProvider;
  permissionModes: string[];
  defaultPermissionMode: string;
  supportsImages: boolean;
  supportsFiles: boolean;
  supportsAbort: boolean;
  supportsPermissionRequests: boolean;
  supportsTokenUsage: boolean;
  supportsEffort?: boolean;
  supportsMessageEditing?: boolean;
  supportsSessionForking?: boolean;
};

type ProviderCapabilitiesApiResponse = {
  success?: boolean;
  data?: {
    providers?: ProviderCapabilities[];
  };
};

type UseChatProviderStateArgs = {
  selectedSession: ProjectSession | null;
  selectedProject: Project | null;
  /** Bumped on every New Session click, which starts a new chat even in place. */
  newSessionTrigger?: number;
};

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: {
    models?: ProviderModelsDefinition;
  };
};

type ProviderModelMutationApiResponse = {
  success?: boolean;
  data?: {
    model?: ProviderModelOption;
    models?: ProviderModelsDefinition;
  };
  error?: {
    message?: string;
  };
};

type SessionSelectionApiResponse = {
  success?: boolean;
  data?: {
    provider?: LLMProvider;
    sessionId?: string | null;
    model?: string | null;
    effort?: string | null;
    /**
     * `session` and `provider` are real answers for this session; `default`
     * means the backend had nothing recorded and returned the catalog default,
     * which the composer replaces with the user's per-provider selection.
     */
    source?: 'session' | 'provider' | 'default';
    /** NULL until the session records a permission mode. */
    permissionMode?: string | null;
  };
};

type SessionProviderSelection = {
  provider: LLMProvider;
  sessionId: string;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
};

/** What a new chat in one project starts with; nulls fall back to per-provider defaults. */
type ProjectProviderSelection = {
  provider: LLMProvider;
  projectPath: string;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
};

type ProjectSelectionField = 'model' | 'effort' | 'permissionMode';

type ProjectSelectionApiResponse = {
  success?: boolean;
  data?: Partial<Pick<ProjectProviderSelection, ProjectSelectionField>>;
};

const getSessionSelectionKey = (provider: LLMProvider, sessionId: string): string => (
  `${provider}:${sessionId}`
);

export function useChatProviderState({ selectedSession, selectedProject, newSessionTrigger }: UseChatProviderStateArgs) {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  // The provider the composer sends under. Held here rather than read from
  // storage per render because switching it has to reset the model menu, the
  // permission mode and the session in one commit.
  const [provider, setProvider] = useState<LLMProvider>(readSelectedProvider);
  // Every provider's chosen model, not just the active one: switching provider
  // must restore the model that provider was last used with, and the catalogue
  // that validates them arrives asynchronously per provider.
  const [providerModels, setProviderModels] = useState<Record<LLMProvider, string>>(() => {
    return PROVIDERS.reduce<Record<LLMProvider, string>>((acc, targetProvider) => {
      acc[targetProvider] = localStorage.getItem(providerModelStorageKey(targetProvider))
        || FALLBACK_DEFAULT_MODEL[targetProvider];
      return acc;
    }, {} as Record<LLMProvider, string>);
  });
  const [providerEfforts, setProviderEfforts] = useState<Partial<Record<LLMProvider, string>>>(() => {
    return PROVIDERS.reduce<Partial<Record<LLMProvider, string>>>((acc, targetProvider) => {
      acc[targetProvider] = localStorage.getItem(`${targetProvider}-effort`) || DEFAULT_EFFORT_VALUE;
      return acc;
    }, {});
  });

  /**
   * Backend-owned capability matrix keyed by provider. Drives the permission
   * mode picker (and is the extension point for future per-provider UI
   * differences) so the frontend stays free of hardcoded provider branching.
   * Null until `/api/providers/capabilities` resolves; the static fallback
   * map covers that window.
   */
  const [providerCapabilities, setProviderCapabilities] = useState<
    Partial<Record<LLMProvider, ProviderCapabilities>> | null
  >(null);

  const [providerModelCatalog, setProviderModelCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsDefinition>>
  >({});
  const [providerModelsLoading, setProviderModelsLoading] = useState(true);

  const providerModelsRequestIdRef = useRef(0);
  const sessionSelectionLoadRequestIdRef = useRef(0);
  const sessionModelMutationIdRef = useRef(0);
  const sessionEffortMutationIdRef = useRef(0);

  const [projectSelection, setProjectSelection] = useState<ProjectProviderSelection | null>(null);
  // `provider:field` pairs the user picked in this new chat, which a project
  // selection that arrives afterwards must leave alone.
  const pickedProjectFieldsRef = useRef(new Set<string>());

  /** Drops one project value once the user picks that field themselves. */
  const clearProjectSelectionField = useCallback((targetProvider: LLMProvider, field: ProjectSelectionField) => {
    pickedProjectFieldsRef.current.add(`${targetProvider}:${field}`);
    setProjectSelection((current) => (
      current?.provider === targetProvider && current[field] !== null ? { ...current, [field]: null } : current
    ));
  }, []);

  const setStoredProviderModel = useCallback((targetProvider: LLMProvider, model: string) => {
    setProviderModels((previous) => (
      previous[targetProvider] === model
        ? previous
        : { ...previous, [targetProvider]: model }
    ));
    localStorage.setItem(providerModelStorageKey(targetProvider), model);
  }, []);

  const setStoredProviderEffort = useCallback((targetProvider: LLMProvider, effort: string) => {
    setProviderEfforts((previous) => (
      previous[targetProvider] === effort
        ? previous
        : { ...previous, [targetProvider]: effort }
    ));
    localStorage.setItem(`${targetProvider}-effort`, effort);
  }, []);

  const loadProviderModels = useCallback(async () => {
    const requestId = providerModelsRequestIdRef.current + 1;
    providerModelsRequestIdRef.current = requestId;
    setProviderModelsLoading(true);

    try {
      // Each provider lands in the catalog as soon as it answers, so a slow
      // one (OpenCode shells out to its CLI) cannot hold back the others.
      await Promise.all(
        PROVIDERS.map(async (p) => {
          try {
            const response = await api.providers.models(p);
            const body = (await response.json()) as ProviderModelsApiResponse;
            const models = body.success ? body.data?.models : undefined;
            if (!models || providerModelsRequestIdRef.current !== requestId) {
              return;
            }

            setProviderModelCatalog((previous) => ({ ...previous, [p]: models }));
          } catch (error) {
            console.error(`Error loading ${p} models:`, error);
          }
        }),
      );
    } finally {
      if (providerModelsRequestIdRef.current === requestId) {
        setProviderModelsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadProviderModels();
  }, [loadProviderModels]);

  useEffect(() => {
    let cancelled = false;

    const loadCapabilities = async () => {
      try {
        const response = await api.providers.capabilities();
        const body = (await response.json()) as ProviderCapabilitiesApiResponse;
        if (cancelled || !body.success || !Array.isArray(body.data?.providers)) {
          return;
        }

        const byProvider: Partial<Record<LLMProvider, ProviderCapabilities>> = {};
        for (const capabilities of body.data.providers) {
          byProvider[capabilities.provider] = capabilities;
        }
        setProviderCapabilities(byProvider);
      } catch (error) {
        console.error('Error loading provider capabilities:', error);
      }
    };

    void loadCapabilities();
    return () => {
      cancelled = true;
    };
  }, []);

  const getPermissionModesForProvider = useCallback((targetProvider: LLMProvider): PermissionMode[] => {
    const capabilityModes = providerCapabilities?.[targetProvider]?.permissionModes;
    if (capabilityModes && capabilityModes.length > 0) {
      return capabilityModes as PermissionMode[];
    }
    return FALLBACK_PERMISSION_MODES[targetProvider] ?? ['default'];
  }, [providerCapabilities]);

  const getDefaultPermissionModeForProvider = useCallback((targetProvider: LLMProvider): PermissionMode => {
    const modes = getPermissionModesForProvider(targetProvider);
    const capabilityDefault = providerCapabilities?.[targetProvider]?.defaultPermissionMode as PermissionMode | undefined;
    if (capabilityDefault && modes.includes(capabilityDefault)) {
      return capabilityDefault;
    }
    return modes[0] ?? 'default';
  }, [getPermissionModesForProvider, providerCapabilities]);

  const getSupportsEffortForProvider = useCallback((targetProvider: LLMProvider): boolean => {
    const capabilitySupport = providerCapabilities?.[targetProvider]?.supportsEffort;
    if (typeof capabilitySupport === 'boolean') {
      return capabilitySupport;
    }
    return Boolean(FALLBACK_PROVIDER_EFFORT_VALUES[targetProvider]?.length);
  }, [providerCapabilities]);

  const pickStoredOrCurrent = (
    storageKey: string,
    current: string,
    def: ProviderModelsDefinition,
  ): string => {
    const stored = localStorage.getItem(storageKey);
    if (stored && def.OPTIONS.some((o) => o.value === stored)) {
      return stored;
    }
    if (current && def.OPTIONS.some((o) => o.value === current)) {
      return current;
    }
    return def.DEFAULT;
  };

  const getModelOption = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): ProviderModelOption | null => {
    const definition = providerModelCatalog[targetProvider];
    if (!definition) {
      return null;
    }

    return definition.OPTIONS.find((option) => option.value === model) ?? null;
  }, [providerModelCatalog]);

  const getEffortOptionsForModel = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): NonNullable<ProviderModelOption['effort']>['values'] => {
    if (!getSupportsEffortForProvider(targetProvider)) {
      return [];
    }

    const option = getModelOption(targetProvider, model);
    if (option) {
      return option.effort?.values ?? [];
    }

    return toProviderEffortOptions(FALLBACK_PROVIDER_EFFORT_VALUES[targetProvider] ?? []);
  }, [getModelOption, getSupportsEffortForProvider]);

  const getAllowedEffortValues = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): string[] => (
    getEffortOptionsForModel(targetProvider, model).map((value) => value.value)
  ), [getEffortOptionsForModel]);

  const reconcileStoredEffort = useCallback((
    targetProvider: LLMProvider,
    model: string,
    currentEffort: string,
  ): string => {
    const allowedValues = getAllowedEffortValues(targetProvider, model);
    if (allowedValues.length === 0) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (currentEffort === DEFAULT_EFFORT_VALUE || !currentEffort) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (allowedValues.includes(currentEffort)) {
      return currentEffort;
    }

    return DEFAULT_EFFORT_VALUE;
  }, [getAllowedEffortValues]);

  // One reconciliation pass over every provider, mirroring the effort effect
  // below. This was four copy-pasted eleven-line effects, one per provider.
  useEffect(() => {
    const reconciledModels: Partial<Record<LLMProvider, string>> = {};

    for (const targetProvider of PROVIDERS) {
      const catalog = providerModelCatalog[targetProvider];
      if (!catalog) {
        continue;
      }

      const storageKey = providerModelStorageKey(targetProvider);
      const currentModel = providerModels[targetProvider];
      const nextModel = pickStoredOrCurrent(storageKey, currentModel, catalog);

      if (nextModel !== currentModel) {
        reconciledModels[targetProvider] = nextModel;
      }
      if (localStorage.getItem(storageKey) !== nextModel) {
        localStorage.setItem(storageKey, nextModel);
      }
    }

    if (Object.keys(reconciledModels).length > 0) {
      setProviderModels((previous) => ({ ...previous, ...reconciledModels }));
    }
  }, [providerModelCatalog, providerModels]);

  useEffect(() => {
    const nextEfforts: Partial<Record<LLMProvider, string>> = {};
    let hasUpdates = false;

    for (const targetProvider of PROVIDERS) {
      const currentEffort = providerEfforts[targetProvider] ?? DEFAULT_EFFORT_VALUE;
      const nextEffort = reconcileStoredEffort(targetProvider, providerModels[targetProvider], currentEffort);
      if (nextEffort === currentEffort) {
        continue;
      }

      nextEfforts[targetProvider] = nextEffort;
      localStorage.setItem(`${targetProvider}-effort`, nextEffort);
      hasUpdates = true;
    }

    if (hasUpdates) {
      setProviderEfforts((previous) => ({ ...previous, ...nextEfforts }));
    }
  }, [providerEfforts, providerModels, reconcileStoredEffort]);

  useEffect(() => {
    if (!selectedSession?.__provider || selectedSession.__provider === provider) {
      return;
    }

    setProvider(selectedSession.__provider);
    writeSelectedProvider(selectedSession.__provider);
  }, [provider, selectedSession]);

  // Permission prompts belong to a session, not to the transient provider
  // selection that is synchronized after navigation.
  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

  const availablePermissionModes = useMemo(
    () => getPermissionModesForProvider(provider),
    [getPermissionModesForProvider, provider],
  );

  /**
   * Both default to false until the matrix loads, so an affordance is never
   * offered and then withdrawn — and never offered at all for a provider whose
   * runtime would reject it.
   */
  const supportsMessageEditing = Boolean(providerCapabilities?.[provider]?.supportsMessageEditing);
  const supportsSessionForking = Boolean(providerCapabilities?.[provider]?.supportsSessionForking);

  const resolvePermissionModeForProvider = useCallback((
    targetProvider: LLMProvider,
    requestedMode: PermissionMode | string,
  ): PermissionMode => {
    const validModes = getPermissionModesForProvider(targetProvider);
    return validModes.includes(requestedMode as PermissionMode)
      ? requestedMode as PermissionMode
      : getDefaultPermissionModeForProvider(targetProvider);
  }, [getDefaultPermissionModeForProvider, getPermissionModesForProvider]);

  /** Model and reasoning effort recorded for the open session by the backend. */
  const [sessionSelection, setSessionSelection] = useState<SessionProviderSelection | null>(null);
  const selectedSessionId = selectedSession?.id?.trim() || null;
  const selectedSessionProvider = selectedSession?.__provider ?? provider;
  const selectedSessionKey = selectedSessionId
    ? getSessionSelectionKey(selectedSessionProvider, selectedSessionId)
    : null;
  const selectedSessionKeyRef = useRef<string | null>(selectedSessionKey);
  selectedSessionKeyRef.current = selectedSessionKey;

  const activeSessionSelection = sessionSelection
    && selectedSessionId
    && sessionSelection.sessionId === selectedSessionId
    && sessionSelection.provider === selectedSessionProvider
    ? sessionSelection
    : null;
  const sessionModel = activeSessionSelection?.model ?? null;

  const selectedProjectPath = selectedProject?.fullPath?.trim() || null;
  // The mode picked for a session while its recorded selection was loading,
  // which that load must not revert.
  const sessionPermissionPickRef = useRef<{ key: string; mode: PermissionMode } | null>(null);
  // The session this new chat just created, until navigation selects it.
  const seededSessionRef = useRef<{ provider: LLMProvider; sessionId: string } | null>(null);

  // Only a new chat starts from the project. Its session is created with the
  // selection it starts from, so once it has an id its own row answers.
  const activeProjectSelection = projectSelection
    && !selectedSessionId
    && projectSelection.provider === provider
    && projectSelection.projectPath === selectedProjectPath
    ? projectSelection
    : null;
  // Only a model the catalog lists is offered, so a deleted custom model is
  // never recorded on a new session. The effort belongs to that model, so it
  // goes when the model does (not listed, or replaced by the user's pick).
  const projectModel = activeProjectSelection?.model
    && providerModelCatalog[provider]?.OPTIONS.some((option) => option.value === activeProjectSelection.model)
    ? activeProjectSelection.model
    : null;
  const projectEffort = projectModel ? activeProjectSelection?.effort ?? null : null;

  // Picks and the created session belong to one new chat; a provider switch
  // inside it keeps them.
  useEffect(() => {
    pickedProjectFieldsRef.current = new Set();
    seededSessionRef.current = null;
  }, [newSessionTrigger, selectedProjectPath, selectedSessionId]);

  // A new chat starts from what the project's latest session ran with.
  useEffect(() => {
    if (selectedSessionId || !selectedProjectPath) {
      return;
    }

    let cancelled = false;
    const loadProjectSelection = async () => {
      try {
        const response = await api.providers.projectSelection(provider, selectedProjectPath);
        const body = (await response.json()) as ProjectSelectionApiResponse;
        if (cancelled) {
          return;
        }
        if (!body.success || !body.data) {
          setProjectSelection(null);
          return;
        }
        const unlessPicked = (field: ProjectSelectionField) => (
          pickedProjectFieldsRef.current.has(`${provider}:${field}`) ? null : body.data?.[field] ?? null
        );
        setProjectSelection({
          provider,
          projectPath: selectedProjectPath,
          model: unlessPicked('model'),
          effort: unlessPicked('effort'),
          permissionMode: unlessPicked('permissionMode'),
        });
      } catch (error) {
        if (!cancelled) {
          console.error('Error loading the project model and permission mode:', error);
          setProjectSelection(null);
        }
      }
    };

    void loadProjectSelection();
    return () => {
      cancelled = true;
    };
  }, [newSessionTrigger, provider, selectedProjectPath, selectedSessionId]);

  useEffect(() => {
    const validModes = getPermissionModesForProvider(provider);
    // The per-session key answers until the backend row has loaded, and for
    // sessions from before the backend recorded modes.
    const sessionSavedMode = selectedSessionId
      ? (activeSessionSelection?.permissionMode ?? localStorage.getItem(`permissionMode-${selectedSessionId}`))
      : null;
    // Fall back to the last mode picked for this provider: a brand-new chat
    // only receives its session id after the first send, so without this the
    // mode chosen beforehand would snap back to the default as soon as the
    // session id appears.
    const providerSavedMode = localStorage.getItem(`permissionMode-last-${provider}`) as PermissionMode | null;
    const savedMode = [sessionSavedMode, activeProjectSelection?.permissionMode, providerSavedMode].find(
      (mode): mode is PermissionMode => Boolean(mode && validModes.includes(mode as PermissionMode)),
    );
    setPermissionMode(savedMode ?? getDefaultPermissionModeForProvider(provider));
  }, [
    selectedSessionId,
    provider,
    activeSessionSelection?.permissionMode,
    activeProjectSelection?.permissionMode,
    getDefaultPermissionModeForProvider,
    getPermissionModesForProvider,
  ]);

  const selectPermissionMode = useCallback((nextMode: PermissionMode) => {
    setPermissionMode(nextMode);

    // Persist per provider as well as per session: a brand-new chat has no
    // session id yet, and the per-provider key keeps the choice sticky when
    // the real id arrives (and for future sessions of this provider).
    localStorage.setItem(`permissionMode-last-${provider}`, nextMode);
    if (!selectedSessionId) {
      clearProjectSelectionField(provider, 'permissionMode');
    }

    // A new chat that already has its id but no selected session yet records
    // the pick on that session, so it is not reverted once it is selected.
    const target = selectedSessionId
      ? { provider, sessionId: selectedSessionId }
      : seededSessionRef.current;
    if (!target) {
      return;
    }

    localStorage.setItem(`permissionMode-${target.sessionId}`, nextMode);
    sessionPermissionPickRef.current = {
      key: getSessionSelectionKey(target.provider, target.sessionId),
      mode: nextMode,
    };
    setSessionSelection((current) => (
      current?.sessionId === target.sessionId ? { ...current, permissionMode: nextMode } : current
    ));
    api.providers.setSessionActivePermissionMode(target.provider, target.sessionId, nextMode)
      .then((response) => {
        if (!response.ok) {
          console.error(`Error saving the session permission mode: HTTP ${response.status}`);
        }
      })
      .catch((error) => console.error('Error saving the session permission mode:', error));
  }, [clearProjectSelectionField, provider, selectedSessionId]);

  const cyclePermissionMode = useCallback(() => {
    const modes = getPermissionModesForProvider(provider);

    const currentIndex = modes.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    selectPermissionMode(modes[nextIndex]);
  }, [permissionMode, provider, getPermissionModesForProvider, selectPermissionMode]);


  useEffect(() => {
    const requestId = sessionSelectionLoadRequestIdRef.current + 1;
    sessionSelectionLoadRequestIdRef.current = requestId;

    sessionPermissionPickRef.current = null;
    if (!selectedSessionId) {
      setSessionSelection(null);
      return;
    }

    let cancelled = false;
    const targetProvider = selectedSessionProvider;
    const targetSessionKey = getSessionSelectionKey(targetProvider, selectedSessionId);

    const loadSessionSelection = async () => {
      try {
        const response = await api.providers.sessionActiveModel(targetProvider, selectedSessionId);
        const body = (await response.json()) as SessionSelectionApiResponse;
        if (
          cancelled
          || sessionSelectionLoadRequestIdRef.current !== requestId
          || selectedSessionKeyRef.current !== targetSessionKey
        ) {
          return;
        }

        const resolvedModel = body.data?.model?.trim();
        const resolvedEffort = body.data?.effort?.trim() || null;
        setSessionSelection({
          provider: targetProvider,
          sessionId: selectedSessionId,
          model: body.success && resolvedModel && body.data?.source !== 'default' ? resolvedModel : null,
          effort: body.success ? resolvedEffort : null,
          permissionMode: (sessionPermissionPickRef.current?.key === targetSessionKey
            ? sessionPermissionPickRef.current.mode
            : null)
            ?? (body.success ? body.data?.permissionMode?.trim() || null : null),
        });
      } catch (error) {
        if (
          !cancelled
          && sessionSelectionLoadRequestIdRef.current === requestId
          && selectedSessionKeyRef.current === targetSessionKey
        ) {
          console.error('Error loading the session model and reasoning effort:', error);
          setSessionSelection({
            provider: targetProvider,
            sessionId: selectedSessionId,
            model: null,
            effort: null,
            permissionMode: null,
          });
        }
      }
    };

    void loadSessionSelection();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, selectedSessionProvider]);

  /**
   * Applies a model choice.
   *
   * The pick always becomes the per-provider default so the next new chat
   * inherits it, and — when a session is open — is also recorded against that
   * session so reopening it later restores this model.
   */
  const selectProviderModel = useCallback(async (
    targetProvider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => {
    setStoredProviderModel(targetProvider, model);
    // Also when a new chat already has its id but no selected session yet,
    // while the project selection still shows.
    clearProjectSelectionField(targetProvider, 'model');

    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return { scope: 'default' as const, model };
    }

    // A pending GET represents the state before this click and must not win
    // if it resolves after the mutation.
    sessionSelectionLoadRequestIdRef.current += 1;
    const mutationId = sessionModelMutationIdRef.current + 1;
    sessionModelMutationIdRef.current = mutationId;
    const targetSessionKey = getSessionSelectionKey(targetProvider, normalizedSessionId);

    const response = await api.providers.setSessionActiveModel(
      targetProvider,
      normalizedSessionId,
      model,
    );

    const body = (await response.json()) as SessionSelectionApiResponse;
    if (!response.ok || !body.success) {
      throw new Error('Unable to change the active model for this session.');
    }

    const storedModel = body.data?.model?.trim() || model;
    if (
      sessionModelMutationIdRef.current === mutationId
      && (selectedSessionKeyRef.current === targetSessionKey
        || seededSessionRef.current?.sessionId === normalizedSessionId)
    ) {
      setSessionSelection((current) => ({
        provider: targetProvider,
        sessionId: normalizedSessionId,
        model: storedModel,
        effort: current?.provider === targetProvider && current.sessionId === normalizedSessionId
          ? current.effort
          : body.data?.effort?.trim() || null,
        permissionMode: current?.provider === targetProvider && current.sessionId === normalizedSessionId
          ? current.permissionMode
          : null,
      }));
    }
    return { scope: 'session' as const, model: storedModel };
  }, [clearProjectSelectionField, setStoredProviderModel]);

  /**
   * Applies an effort choice optimistically and persists it for the open
   * session. Mutation counters keep slower earlier requests from overwriting
   * the latest click.
   */
  const selectProviderEffort = useCallback(async (
    targetProvider: LLMProvider,
    effort: string,
    sessionId?: string | null,
  ) => {
    setStoredProviderEffort(targetProvider, effort);
    clearProjectSelectionField(targetProvider, 'effort');

    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return { scope: 'default' as const, effort };
    }

    sessionSelectionLoadRequestIdRef.current += 1;
    const mutationId = sessionEffortMutationIdRef.current + 1;
    sessionEffortMutationIdRef.current = mutationId;
    const targetSessionKey = getSessionSelectionKey(targetProvider, normalizedSessionId);
    const previousSelection = sessionSelection?.provider === targetProvider
      && sessionSelection.sessionId === normalizedSessionId
      ? sessionSelection
      : null;

    setSessionSelection({
      provider: targetProvider,
      sessionId: normalizedSessionId,
      model: previousSelection?.model ?? null,
      effort,
      permissionMode: previousSelection?.permissionMode ?? null,
    });

    try {
      const response = await api.providers.setSessionActiveEffort(
        targetProvider,
        normalizedSessionId,
        effort,
      );
      const body = (await response.json()) as SessionSelectionApiResponse;
      if (!response.ok || !body.success) {
        throw new Error('Unable to change the reasoning effort for this session.');
      }

      const storedEffort = body.data?.effort?.trim() || effort;
      if (
        sessionEffortMutationIdRef.current === mutationId
        && selectedSessionKeyRef.current === targetSessionKey
      ) {
        setSessionSelection((current) => ({
          provider: targetProvider,
          sessionId: normalizedSessionId,
          model: current?.provider === targetProvider && current.sessionId === normalizedSessionId
            ? current.model
            : previousSelection?.model ?? null,
          effort: storedEffort,
          permissionMode: current?.provider === targetProvider && current.sessionId === normalizedSessionId
            ? current.permissionMode
            : previousSelection?.permissionMode ?? null,
        }));
      }

      return { scope: 'session' as const, effort: storedEffort };
    } catch (error) {
      if (
        sessionEffortMutationIdRef.current === mutationId
        && selectedSessionKeyRef.current === targetSessionKey
      ) {
        setSessionSelection((current) => (
          current?.provider === targetProvider
          && current.sessionId === normalizedSessionId
          && current.effort === effort
            ? previousSelection
            : current
        ));
      }
      throw error;
    }
  }, [clearProjectSelectionField, sessionSelection, setStoredProviderEffort]);

  // The open session's model wins over the per-provider default, so switching
  // sessions shows (and sends) what each session actually runs with. What it
  // has not recorded comes from the project's latest session.
  const currentProviderModel = sessionModel ?? projectModel ?? providerModels[provider];
  const displayedProviderModels = useMemo(() => (
    projectModel ? { ...providerModels, [provider]: projectModel } : providerModels
  ), [projectModel, provider, providerModels]);
  const currentProviderEffortOptions = useMemo(() => {
    return getEffortOptionsForModel(provider, currentProviderModel);
  }, [currentProviderModel, getEffortOptionsForModel, provider]);
  const currentProviderEffort = useMemo(() => {
    return reconcileStoredEffort(
      provider,
      currentProviderModel,
      activeSessionSelection?.effort
        ?? projectEffort
        ?? providerEfforts[provider]
        ?? DEFAULT_EFFORT_VALUE,
    );
  }, [
    projectEffort,
    activeSessionSelection?.effort,
    currentProviderModel,
    provider,
    providerEfforts,
    reconcileStoredEffort,
  ]);

  /**
   * Holds what a session was just created with as its recorded selection, so
   * the composer keeps showing it while the row loads, instead of falling
   * back to the per-provider defaults in between.
   */
  const seedSessionSelection = useCallback((
    targetProvider: LLMProvider,
    sessionId: string,
    selection: SessionEstablishedContext['selection'] = {},
  ) => {
    const read = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    seededSessionRef.current = { provider: targetProvider, sessionId };
    setSessionSelection({
      provider: targetProvider,
      sessionId,
      model: read(selection.model),
      effort: read(selection.effort),
      permissionMode: read(selection.permissionMode),
    });
  }, []);

  const currentProviderModelOptions = useMemo(
    () => providerModelCatalog[provider]?.OPTIONS ?? [],
    [provider, providerModelCatalog],
  );

  const applyProviderCatalog = useCallback((
    targetProvider: LLMProvider,
    models: ProviderModelsDefinition,
  ) => {
    setProviderModelCatalog((previous) => ({
      ...previous,
      [targetProvider]: models,
    }));
  }, []);

  const readModelMutationResponse = useCallback(async (
    response: Response,
  ): Promise<Required<Pick<NonNullable<ProviderModelMutationApiResponse['data']>, 'model' | 'models'>>> => {
    const body = (await response.json()) as ProviderModelMutationApiResponse;
    if (!response.ok || !body.success || !body.data?.model || !body.data.models) {
      throw new Error(body.error?.message || 'Unable to save this model.');
    }

    return {
      model: body.data.model,
      models: body.data.models,
    };
  }, []);

  const createCustomModel = useCallback(async (
    targetProvider: LLMProvider,
    input: CustomProviderModelInput,
  ) => {
    const response = await api.providers.createModel(targetProvider, input);
    const result = await readModelMutationResponse(response);
    applyProviderCatalog(targetProvider, result.models);
  }, [applyProviderCatalog, readModelMutationResponse]);

  const updateCustomModel = useCallback(async (
    targetProvider: LLMProvider,
    existing: ProviderModelOption,
    input: CustomProviderModelInput,
  ) => {
    if (!existing.recordId) {
      throw new Error('This model cannot be edited.');
    }

    const response = await api.providers.updateModel(targetProvider, existing.recordId, input);
    const result = await readModelMutationResponse(response);
    applyProviderCatalog(targetProvider, result.models);

    if (providerModels[targetProvider] === existing.value) {
      setStoredProviderModel(targetProvider, result.model.value);
    }
    setProjectSelection((current) => (
      current?.provider === targetProvider && current.model === existing.value
        ? { ...current, model: result.model.value }
        : current
    ));
    if (provider === targetProvider && sessionModel === existing.value) {
      setSessionSelection((current) => current ? {
        ...current,
        model: result.model.value,
      } : current);
    }
  }, [
    applyProviderCatalog,
    provider,
    providerModels,
    readModelMutationResponse,
    sessionModel,
    setStoredProviderModel,
  ]);

  const removeCustomModel = useCallback(async (
    targetProvider: LLMProvider,
    existing: ProviderModelOption,
  ) => {
    if (!existing.recordId) {
      throw new Error('This model cannot be deleted.');
    }

    const response = await api.providers.deleteModel(targetProvider, existing.recordId);
    const result = await readModelMutationResponse(response);
    applyProviderCatalog(targetProvider, result.models);

    if (providerModels[targetProvider] === existing.value) {
      setStoredProviderModel(targetProvider, result.models.DEFAULT);
    }
    if (provider === targetProvider && sessionModel === existing.value) {
      setSessionSelection((current) => current ? {
        ...current,
        model: result.models.DEFAULT,
      } : current);
    }
  }, [
    applyProviderCatalog,
    provider,
    providerModels,
    readModelMutationResponse,
    sessionModel,
    setStoredProviderModel,
  ]);

  /**
   * Applies the server's catalog for the new flag. A remembered per-provider
   * model that the catalog no longer lists is moved to its `DEFAULT` by the
   * reconciliation effect above; an open session keeps its recorded model.
   */
  const setCustomModelsOnly = useCallback(async (
    targetProvider: LLMProvider,
    enabled: boolean,
  ) => {
    const response = await api.providers.setCustomModelsOnly(targetProvider, enabled);
    const body = (await response.json()) as ProviderModelMutationApiResponse;
    if (!response.ok || !body.success || !body.data?.models) {
      throw new Error(body.error?.message || 'Unable to change this setting.');
    }

    applyProviderCatalog(targetProvider, body.data.models);
  }, [applyProviderCatalog]);

  const providerModelActions = useMemo<ProviderModelActions>(() => ({
    create: createCustomModel,
    update: updateCustomModel,
    remove: removeCustomModel,
    setCustomModelsOnly,
  }), [createCustomModel, removeCustomModel, setCustomModelsOnly, updateCustomModel]);

  return {
    provider,
    setProvider,
    // The empty state reads this record, so it must show the model that is sent.
    providerModels: displayedProviderModels,
    setStoredProviderModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    currentProviderModelOptions,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelsLoading,
    providerModelActions,
    selectProviderModel,
    selectProviderEffort,
    seedSessionSelection,
    resolvePermissionModeForProvider,
    supportsMessageEditing,
    supportsSessionForking,
  };
}
