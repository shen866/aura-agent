import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import { useToast } from "./toast";
import type {
  AppStatus,
  ApplyConfigResult,
  AppConfig,
  BootstrapData,
  ConfigResult,
  ConversationSummary,
  OutboundMessage,
  SecretStatus,
  TaskSummary,
  ViewName,
  WorkerEvent,
} from "./types";
import { errorMessage } from "./utils";

export type ConnectionState = "connecting" | "online" | "offline";

export type AuraEvent =
  | { type: "bootstrap"; data: BootstrapData }
  | { type: "status"; data: AppStatus }
  | { type: "task"; data: TaskSummary }
  | { type: "worker-event"; data: WorkerEvent }
  | { type: "message"; data: { conversationId?: string; message: OutboundMessage } }
  | { type: "conversations"; data: ConversationSummary[] }
  | { type: "config"; data: { config: AppConfig; secretStatus?: SecretStatus; status?: AppStatus } }
  | { type: "message-accepted"; data: unknown };

type Listener = (event: AuraEvent) => void;

interface AuraContextValue {
  app: AppStatus | null;
  config: AppConfig | null;
  secretStatus: SecretStatus;
  conversations: ConversationSummary[];
  tasks: TaskSummary[];
  ready: boolean;
  bootError: string | null;
  connection: ConnectionState;
  view: ViewName;
  setView: (view: ViewName) => void;
  refresh: (notify?: boolean) => Promise<void>;
  subscribe: (listener: Listener) => () => void;
  updateConversations: (conversations: ConversationSummary[]) => void;
  replaceTasks: (tasks: TaskSummary[], status?: AppStatus) => void;
  mergeTasks: (tasks: TaskSummary[]) => void;
  applyConfigResult: (result: ApplyConfigResult) => void;
  applyConfigSnapshot: (result: ConfigResult) => void;
}

const AuraContext = createContext<AuraContextValue | null>(null);

interface IncomingEvent {
  type?: string;
  data?: unknown;
}

export function AuraProvider({ children }: { children: ReactNode }) {
  const [app, setApp] = useState<AppStatus | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [secretStatus, setSecretStatus] = useState<SecretStatus>({});
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [taskMap, setTaskMap] = useState<Map<string, TaskSummary>>(new Map());
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [view, setView] = useState<ViewName>("chat");
  const listeners = useRef(new Set<Listener>());
  const hasBootstrapped = useRef(false);
  const toast = useToast();

  const emit = useCallback((event: AuraEvent) => {
    for (const listener of listeners.current) listener(event);
  }, []);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  const updateConversations = useCallback(
    (next: ConversationSummary[]) => {
      setConversations(next);
      emit({ type: "conversations", data: next });
    },
    [emit]
  );

  const replaceTasks = useCallback(
    (tasks: TaskSummary[], status?: AppStatus) => {
      setTaskMap(new Map(tasks.map((task) => [task.id, task])));
      if (status) {
        setApp(status);
        emit({ type: "status", data: status });
      }
    },
    [emit]
  );

  const mergeTasks = useCallback((tasks: TaskSummary[]) => {
    if (tasks.length === 0) return;
    setTaskMap((current) => {
      const next = new Map(current);
      for (const task of tasks) next.set(task.id, task);
      return next;
    });
  }, []);

  const applyConfigResult = useCallback(
    (result: ApplyConfigResult) => {
      setConfig(result.config);
      setSecretStatus(result.secretStatus);
      setApp(result.status);
      emit({ type: "config", data: result });
      emit({ type: "status", data: result.status });
    },
    [emit]
  );

  const applyConfigSnapshot = useCallback(
    (result: ConfigResult) => {
      setConfig(result.config);
      setSecretStatus(result.secretStatus);
      setApp(result.status);
      emit({ type: "config", data: result });
      emit({ type: "status", data: result.status });
    },
    [emit]
  );

  const loadBootstrap = useCallback(
    async (notify = false) => {
      try {
        const data = await api.bootstrap();
        setApp(data.app);
        setConfig(data.config);
        setSecretStatus(data.secretStatus);
        setConversations(data.conversations ?? []);
        setTaskMap(new Map((data.tasks ?? []).map((task) => [task.id, task])));
        setReady(true);
        setBootError(null);
        hasBootstrapped.current = true;
        emit({ type: "bootstrap", data });
        if (notify) toast("已刷新", "success", 1800);
      } catch (error) {
        const message = errorMessage(error);
        if (!hasBootstrapped.current) setBootError(message);
        toast(message || "加载失败", "error", 6000);
      }
    },
    [emit, toast]
  );

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      source?.close();
      setConnection("connecting");
      source = new EventSource("/api/events");
      source.addEventListener("open", () => {
        setConnection("online");
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
      });
      source.addEventListener("aura", (message) => {
        let event: IncomingEvent;
        try {
          event = JSON.parse((message as MessageEvent<string>).data) as IncomingEvent;
        } catch {
          return;
        }
        const data = event.data;
        if (event.type === "ready" || event.type === "status") {
          const wrapped = data as { status?: AppStatus } | AppStatus;
          const status =
            "status" in wrapped && wrapped.status ? wrapped.status : (wrapped as AppStatus);
          if (!status) return;
          setApp(status);
          emit({ type: "status", data: status });
        } else if (event.type === "task.updated") {
          const task = data as TaskSummary;
          if (!task?.id) return;
          setTaskMap((current) => new Map(current).set(task.id, task));
          emit({ type: "task", data: task });
        } else if (event.type === "worker.event") {
          emit({ type: "worker-event", data: data as WorkerEvent });
        } else if (event.type === "message.sent") {
          emit({
            type: "message",
            data: data as { conversationId?: string; message: OutboundMessage },
          });
        } else if (event.type === "conversation.updated") {
          const summary = (data as { conversation?: ConversationSummary }).conversation;
          if (!summary) return;
          setConversations((current) => {
            const index = current.findIndex((item) => item.id === summary.id);
            const next = [...current];
            if (index === -1) next.unshift(summary);
            else next[index] = { ...(next[index] ?? summary), ...summary };
            next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
            return next;
          });
        } else if (event.type === "conversations.changed") {
          const next = (data as { conversations?: ConversationSummary[] }).conversations ?? [];
          setConversations(next);
          emit({ type: "conversations", data: next });
        } else if (event.type === "config.updated") {
          const update = data as {
            config: AppConfig;
            secretStatus?: SecretStatus;
            status?: AppStatus;
          };
          if (!update.config) return;
          setConfig(update.config);
          if (update.secretStatus) setSecretStatus(update.secretStatus);
          if (update.status) {
            setApp(update.status);
            emit({ type: "status", data: update.status });
          }
          emit({ type: "config", data: update });
        } else if (event.type === "message.accepted") {
          emit({ type: "message-accepted", data });
        } else if (event.type === "error") {
          toast((data as { message?: string })?.message ?? "Host 错误", "error", 6000);
        }
      });
      source.addEventListener("error", () => {
        if (!source) return;
        if (source.readyState === EventSource.CLOSED) {
          setConnection("offline");
          source.close();
          source = null;
          if (!reconnectTimer && !disposed) reconnectTimer = setTimeout(connect, 3000);
        } else {
          setConnection("connecting");
        }
      });
    };

    const focus = () => {
      if (source?.readyState === EventSource.CLOSED || !source) connect();
    };
    window.addEventListener("focus", focus);
    connect();
    return () => {
      disposed = true;
      window.removeEventListener("focus", focus);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [emit, toast]);

  const tasks = useMemo(
    () =>
      [...taskMap.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [taskMap]
  );

  const value = useMemo<AuraContextValue>(
    () => ({
      app,
      config,
      secretStatus,
      conversations,
      tasks,
      ready,
      bootError,
      connection,
      view,
      setView,
      refresh: loadBootstrap,
      subscribe,
      updateConversations,
      replaceTasks,
      mergeTasks,
      applyConfigResult,
      applyConfigSnapshot,
    }),
    [
      app,
      config,
      secretStatus,
      conversations,
      tasks,
      ready,
      bootError,
      connection,
      view,
      loadBootstrap,
      subscribe,
      updateConversations,
      replaceTasks,
      mergeTasks,
      applyConfigResult,
      applyConfigSnapshot,
    ]
  );

  return <AuraContext.Provider value={value}>{children}</AuraContext.Provider>;
}

export function useAura(): AuraContextValue {
  const context = useContext(AuraContext);
  if (!context) throw new Error("useAura 必须在 AuraProvider 内使用");
  return context;
}
