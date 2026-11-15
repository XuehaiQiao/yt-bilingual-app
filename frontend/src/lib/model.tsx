// Global model selection (specs/012 model routing + P0 IA §10.3).
//
// Before P0 the model choice lived inside `TodayWorkbench` → `InputScreen` →
// `EstimateDialog`, and only the home screen could change it. The IA moves
// the control into the app chrome, so one provider now owns the catalog and
// the selected id. Every consumer (top bar chip, profile settings,
// EstimateDialog, learning header) reads the same value, and the setting in
// localStorage stays the single source of truth across reloads.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { apiFetch } from './api';
import { loadModel, saveModel } from './settings';
import { describeApiError } from './toast';

/** One entry of GET /api/models — the single catalog the backend owns. */
export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  available: boolean;
  quotaInfo: string;
}

interface ModelsResponse {
  models: ModelOption[];
  default: string;
}

export interface ModelContextValue {
  /** The model every LLM call will use (backend default until the user picks). */
  modelId: string;
  models: ModelOption[];
  loading: boolean;
  error: string | null;
  selectModel: (id: string) => void;
  reload: () => void;
}

const ModelContext = createContext<ModelContextValue | null>(null);

export function ModelProvider({ children }: { children: ReactNode }) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState<string>(loadModel);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Guards late catalog responses (unmount / reload) with the same rule the
  // old ModelBar used: never paint a stale selection over a newer one.
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const reload = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/models');
      if (!res.ok) throw new Error(await describeApiError(res));
      const data = (await res.json()) as ModelsResponse;
      if (!mountedRef.current || requestRef.current !== requestId) return;
      const catalog = Array.isArray(data.models) ? data.models : [];
      setModels(catalog);
      // Respect a saved choice; otherwise fall back to the backend default
      // (then to any usable model when the default has no Key). The backend
      // default is not persisted: "the model the user picked" stays empty so
      // a never-chosen user keeps following the default if it changes.
      const saved = loadModel();
      const savedKnown = catalog.some(model => model.id === saved);
      const fallback =
        catalog.find(model => model.id === data.default && model.available) ||
        catalog.find(model => model.id === data.default) ||
        catalog.find(model => model.available) ||
        catalog[0];
      const effective = savedKnown ? saved : fallback?.id || saved;
      if (effective) setModelId(effective);
    } catch (err) {
      if (!mountedRef.current || requestRef.current !== requestId) return;
      setError(await describeApiError(err));
    } finally {
      if (mountedRef.current && requestRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selectModel = useCallback((id: string) => {
    const option = models.find(model => model.id === id);
    if (option && option.available === false) return;
    setModelId(id);
    saveModel(id);
  }, [models]);

  const value = useMemo<ModelContextValue>(() => ({
    modelId,
    models,
    loading,
    error,
    selectModel,
    reload: () => { void reload(); },
  }), [modelId, models, loading, error, selectModel, reload]);

  return <ModelContext.Provider value={value}>{children}</ModelContext.Provider>;
}

// The provider and its hook intentionally share this module: the context must
// be the same object for every consumer. Fast Refresh treats mixed exports as
// a full reload, which is exactly what a provider change needs.
// eslint-disable-next-line react-refresh/only-export-components
export function useModel(): ModelContextValue {
  const value = useContext(ModelContext);
  if (!value) {
    throw new Error('useModel must be used inside <ModelProvider>');
  }
  return value;
}
