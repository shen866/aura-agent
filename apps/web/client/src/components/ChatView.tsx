import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { api, ApiFailure } from "../api";
import { useAura } from "../AuraContext";
import { useToast } from "../toast";
import { isActiveStatus } from "../types";
import type { AppStatus, ChatMessage, Conversation } from "../types";
import type { ConversationSummary, TaskStatus, WorkerEvent } from "../types";
import { errorMessage, statusLabel, timeAgo, truncate } from "../utils";
import { EmptyState } from "./Common";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

interface LiveWorkerEntry {
  taskId: string;
  runId: string;
  conversationId: string;
  workerId: string;
  content: string;
  reasoning: string;
  progress: string;
  status: TaskStatus;
  updatedAt: string;
}

const suggestions = [
  "帮我梳理这个仓库的架构，并指出最值得改进的三个点。",
  "先查一下项目状态，再给我一份发布前的检查清单。",
  "把一个多步骤任务拆解给合适的 worker 执行。",
  "总结最近的失败任务，分析可能的失败原因。",
];

export function ChatView({ visible }: { visible: boolean }) {
  const {
    app,
    conversations,
    tasks,
    ready,
    bootError,
    subscribe,
    setView,
    updateConversations,
    mergeTasks,
  } = useAura();
  const toast = useToast();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [live, setLive] = useState<Map<string, LiveWorkerEntry>>(new Map());
  const activeIdRef = useRef<string | null>(null);
  const conversationsRef = useRef(conversations);
  const tasksRef = useRef(tasks);
  const requestSequence = useRef(0);
  const initialized = useRef(false);
  const liveRef = useRef(new Map<string, LiveWorkerEntry>());
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const forceScroll = useRef(false);

  conversationsRef.current = conversations;
  tasksRef.current = tasks;

  const changeActiveId = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
  }, []);

  const clearLive = useCallback(() => {
    liveRef.current = new Map();
    setLive(new Map());
  }, []);

  const loadConversation = useCallback(
    async (id: string) => {
      if (!id) return;
      const sequence = ++requestSequence.current;
      changeActiveId(id);
      setConversation(null);
      clearLive();
      forceScroll.current = true;
      try {
        const data = await api.conversation(id);
        if (sequence !== requestSequence.current || activeIdRef.current !== id) return;
        setConversation(data.conversation);
        mergeTasks(data.activeTasks ?? []);
      } catch (error) {
        if (sequence !== requestSequence.current) return;
        if (error instanceof ApiFailure && error.status === 404) {
          const next = conversationsRef.current.filter((item) => item.id !== id);
          updateConversations(next);
          changeActiveId(null);
          setConversation(null);
        } else {
          toast(errorMessage(error) || "加载对话失败", "error");
        }
      }
    },
    [changeActiveId, clearLive, mergeTasks, toast, updateConversations]
  );

  useEffect(() => {
    if (!ready || initialized.current) return;
    initialized.current = true;
    const first = conversations[0]?.id;
    if (first) void loadConversation(first);
  }, [ready, conversations, loadConversation]);

  const flushLive = useCallback(() => {
    if (liveTimer.current) clearTimeout(liveTimer.current);
    liveTimer.current = null;
    setLive(new Map(liveRef.current));
  }, []);

  const scheduleLiveRender = useCallback(() => {
    if (liveTimer.current) return;
    liveTimer.current = setTimeout(flushLive, 60);
  }, [flushLive]);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === "bootstrap") {
        if (initialized.current && activeIdRef.current) void loadConversation(activeIdRef.current);
        return;
      }
      if (event.type === "worker-event") {
        handleWorkerEvent(event.data);
        return;
      }
      if (event.type !== "message") return;
      const { message } = event.data;
      const conversationId = event.data.conversationId ?? message.conversationId;
      if (message.channel !== "web" || conversationId !== activeIdRef.current) return;
      setConversation((current) => {
        if (!current || current.id !== conversationId) return current;
        const exists = current.messages.some(
          (item) => (message.id && item.sourceId === message.id) || item.id === message.id
        );
        if (exists) return current;
        const assistant: ChatMessage = {
          id: `recv_${message.id}`,
          role: "assistant",
          content: message.content,
          createdAt: message.sentAt ?? new Date().toISOString(),
          ...(message.taskId ? { taskId: message.taskId } : {}),
          sourceId: message.id,
        };
        return { ...current, messages: [...current.messages, assistant] };
      });
      if (message.taskId) {
        liveRef.current.delete(message.taskId);
        scheduleLiveRender();
      }
    });
  }, [subscribe, loadConversation, scheduleLiveRender]);

  function handleWorkerEvent(event: WorkerEvent) {
    if (!event.taskId) return;
    const knownTask = tasksRef.current.find((task) => task.id === event.taskId);
    const conversationId = event.conversationId ?? knownTask?.conversationId;
    if (!conversationId || conversationId !== activeIdRef.current) return;
    const previous = liveRef.current.get(event.taskId);
    const entry: LiveWorkerEntry = previous
      ? { ...previous }
      : {
          taskId: event.taskId,
          runId: event.runId,
          conversationId,
          workerId: event.workerId ?? knownTask?.workerId ?? "worker",
          content: "",
          reasoning: "",
          progress: "",
          status: "running",
          updatedAt: new Date().toISOString(),
        };
    if (event.runId && entry.runId && event.runId !== entry.runId) {
      entry.content = "";
      entry.reasoning = "";
      entry.progress = "";
    }
    entry.runId = event.runId ?? entry.runId;
    entry.workerId = event.workerId ?? entry.workerId;
    entry.updatedAt = new Date().toISOString();
    if (event.type === "output") {
      if (event.stream === "reasoning") entry.reasoning += event.delta;
      else entry.content += event.delta;
    } else if (event.type === "progress") {
      entry.progress = event.message;
    } else if (event.type === "status") {
      entry.status = event.status;
      if (event.message) entry.progress = event.message;
    } else if (event.type === "result") {
      entry.status = "succeeded";
      if (!entry.content) entry.content = event.result.summary;
    } else if (event.type === "error") {
      entry.status = "failed";
      entry.progress = event.error.message;
    }
    liveRef.current.set(event.taskId, entry);
    scheduleLiveRender();
  }

  useEffect(() => {
    return () => {
      requestSequence.current += 1;
      if (liveTimer.current) clearTimeout(liveTimer.current);
    };
  }, []);

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(190, Math.max(44, textarea.scrollHeight))}px`;
  }, [input]);

  const activeTasks = useMemo(
    () => tasks.filter((task) => task.conversationId === activeId && isActiveStatus(task.status)),
    [tasks, activeId]
  );
  const liveEntries = useMemo(
    () =>
      [...live.values()].filter(
        (entry) =>
          entry.conversationId === activeId && (entry.content || entry.reasoning || entry.progress)
      ),
    [live, activeId]
  );

  useEffect(() => {
    const element = messagesRef.current;
    if (!element || (!nearBottom.current && !sending && !forceScroll.current)) return;
    element.scrollTop = element.scrollHeight;
    nearBottom.current = true;
    forceScroll.current = false;
  }, [conversation, liveEntries, activeTasks, sending, activeId]);

  const createConversation = useCallback(async (): Promise<Conversation | null> => {
    try {
      const data = await api.createConversation();
      updateConversations(data.conversations ?? conversationsRef.current);
      initialized.current = true;
      await loadConversation(data.conversation.id);
      inputRef.current?.focus();
      return data.conversation;
    } catch (error) {
      toast(errorMessage(error) || "新建对话失败", "error");
      return null;
    }
  }, [loadConversation, toast, updateConversations]);

  const deleteConversation = useCallback(
    async (id: string) => {
      const item = conversationsRef.current.find((conversationItem) => conversationItem.id === id);
      if (
        !window.confirm(`删除「${item?.title || "这个对话"}」及其聊天记录？执行中的任务会被取消。`)
      )
        return;
      try {
        const data = await api.deleteConversation(id);
        const next = data.conversations ?? [];
        updateConversations(next);
        if (activeIdRef.current === id) {
          requestSequence.current += 1;
          changeActiveId(null);
          setConversation(null);
          clearLive();
          const nextId = next[0]?.id;
          if (nextId) await loadConversation(nextId);
        }
        toast("对话已删除", "success");
      } catch (error) {
        toast(errorMessage(error) || "删除失败", "error");
      }
    },
    [changeActiveId, clearLive, loadConversation, toast, updateConversations]
  );

  const cancelTask = useCallback(
    async (taskId: string) => {
      if (!window.confirm("取消这个任务？运行中的 worker 会收到中止信号。")) return;
      try {
        await api.cancelTask(taskId);
        toast("已请求取消", "success");
      } catch (error) {
        toast(errorMessage(error) || "取消失败", "error");
      }
    },
    [toast]
  );

  const sendMessage = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      if (sending) return;
      const rawDraft = input;
      const content = rawDraft.trim();
      if (!content) return;
      if (!app?.model.configured) {
        toast("模型尚未配置，请先在设置页完成配置", "error");
        setView("settings");
        return;
      }
      setSending(true);
      forceScroll.current = true;
      try {
        let conversationId = activeIdRef.current;
        if (!conversationId) {
          const created = await api.createConversation();
          updateConversations(created.conversations ?? conversationsRef.current);
          conversationId = created.conversation.id;
          initialized.current = true;
          changeActiveId(conversationId);
          setConversation(created.conversation);
          clearLive();
        }
        const targetId = conversationId;
        const view = await api.sendMessage(targetId, content);
        mergeTasks(view.activeTasks ?? []);
        if (activeIdRef.current === targetId) {
          setConversation(view.conversation);
          setInput((current) => (current === rawDraft ? "" : current));
          forceScroll.current = true;
          inputRef.current?.focus();
        }
      } catch (error) {
        toast(errorMessage(error) || "发送失败", "error", 6000);
        if (error instanceof ApiFailure && error.payload?.details?.issues) {
          toast(error.payload.details.issues.join("；"), "error", 8000);
        }
      } finally {
        setSending(false);
      }
    },
    [
      app,
      changeActiveId,
      clearLive,
      input,
      mergeTasks,
      sending,
      setView,
      toast,
      updateConversations,
    ]
  );

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const readyToChat = Boolean(
    app?.model.configured && (app.state === "running" || app.state === "applying")
  );
  const liveTaskIds = new Set(liveEntries.map((entry) => entry.taskId));
  const queuedTasks = activeTasks.filter((task) => !liveTaskIds.has(task.id));
  const currentConversation = conversation?.id === activeId ? conversation : null;
  const banner = chatBanner(app, bootError);

  return (
    <section className={`view${visible ? " is-active" : ""}`} id="view-chat" hidden={!visible}>
      <aside className="chat-sidebar">
        <div className="sidebar-head">
          <div>
            <h2>对话</h2>
            <p>直接与 host 交互</p>
          </div>
          <button
            className="icon-button accent"
            type="button"
            title="新建对话"
            aria-label="新建对话"
            onClick={() => void createConversation()}
          >
            <Icon name="plus" />
          </button>
        </div>
        <div className="conversation-list">
          {conversations.length === 0 ? (
            <EmptyState title="还没有对话" description="点击右上角 + 新建一个对话。" />
          ) : (
            conversations.map((item) => (
              <ConversationItem
                key={item.id}
                item={item}
                active={item.id === activeId}
                activity={
                  tasks.filter(
                    (task) => task.conversationId === item.id && isActiveStatus(task.status)
                  ).length ||
                  item.activeTasks ||
                  0
                }
                onSelect={() => {
                  if (item.id !== activeIdRef.current) void loadConversation(item.id);
                }}
                onDelete={() => void deleteConversation(item.id)}
              />
            ))
          )}
        </div>
        <div className="sidebar-foot">
          <span className="status-line">
            {app
              ? `${app.state === "running" ? "Host 运行中" : app.state === "applying" ? "正在应用配置" : `状态：${app.state}`} · ${app.workers.length} 个 worker · ${app.issues.length} 项待配置`
              : "正在加载…"}
          </span>
        </div>
      </aside>

      <div className="chat-main">
        <div className="chat-head">
          <div className="chat-title-wrap">
            <h1>{currentConversation?.title || "Aura"}</h1>
            <p>
              {currentConversation
                ? activeTasks.length > 0
                  ? `${activeTasks.length} 个任务执行中 · host 正在协调 worker`
                  : "消息经由 host inbox → router → worker → outbox 返回"
                : "新建或选择一个对话，开始与 host 交互"}
            </p>
          </div>
          {activeTasks.length > 0 ? (
            <span className="chat-task-pill">
              <span className="live-dot"></span>
              {activeTasks.length} 个任务执行中
            </span>
          ) : null}
        </div>

        {banner.message ? (
          <div className={`banner${banner.error ? " is-error" : ""}`}>
            <Icon name="alert" />
            <div className="banner-text">{banner.message}</div>
            {banner.action ? (
              <button className="link-button" type="button" onClick={() => setView("settings")}>
                去设置
              </button>
            ) : null}
          </div>
        ) : null}

        <div
          className="messages"
          aria-live="polite"
          ref={messagesRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            nearBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          }}
        >
          {bootError && !ready ? (
            <div className="empty-chat">
              <div className="empty-orb">
                <Icon name="alert" />
              </div>
              <h2>无法连接后端</h2>
              <p>{bootError}</p>
            </div>
          ) : !currentConversation || currentConversation.messages.length === 0 ? (
            <EmptyChat
              conversation={currentConversation}
              disabled={!readyToChat}
              onSuggestion={setInput}
            />
          ) : null}
          {currentConversation?.messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {liveEntries.map((entry) => (
            <LiveBubble key={entry.taskId} entry={entry} />
          ))}
          {queuedTasks.length > 0 ? (
            <div className="message assistant is-live">
              <div className="avatar">A</div>
              <div className="message-body">
                <div className="message-meta">
                  {queuedTasks.map((task) => task.workerId).join(", ")} · 已进入执行队列
                </div>
                <div className="bubble">
                  <span className="message-meta">等待 worker 输出…</span>
                </div>
              </div>
            </div>
          ) : null}
          {sending ? (
            <div className="message assistant is-live">
              <div className="avatar">A</div>
              <div className="message-body">
                <div className="message-meta">router · 正在分析任务</div>
                <div className="bubble">
                  <span className="message-meta">等待决策…</span>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {activeTasks.length > 0 || sending ? (
          <div className="activity-strip">
            {activeTasks.map((task) => (
              <span className="activity-task" key={task.id}>
                <span className="spinner sm"></span>
                <span>
                  {task.workerId} · {statusLabel(task.status)} · {task.attempts}/{task.maxAttempts}
                </span>
                <button type="button" title="取消任务" onClick={() => void cancelTask(task.id)}>
                  <Icon name="stop" />
                </button>
              </span>
            ))}
            {sending ? (
              <span className="activity-task">
                <span className="spinner sm"></span>
                <span>等待 host 接收并路由…</span>
              </span>
            ) : null}
          </div>
        ) : null}

        <form className="composer" onSubmit={(event) => void sendMessage(event)}>
          <textarea
            ref={inputRef}
            rows={1}
            maxLength={100000}
            value={input}
            disabled={!readyToChat}
            placeholder={
              readyToChat
                ? "输入消息，Enter 发送，Shift+Enter 换行…"
                : "模型未配置，请先在设置页完成配置"
            }
            aria-label="消息输入"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <div className="composer-actions">
            <span className="composer-hint">消息会先进入 host inbox，再由 router 分派</span>
            <button
              className="send-button"
              type="submit"
              aria-label="发送"
              disabled={!readyToChat || sending}
            >
              <Icon name="send" />
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

function ConversationItem({
  item,
  active,
  activity,
  onSelect,
  onDelete,
}: {
  item: ConversationSummary;
  active: boolean;
  activity: number;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`conversation-item${active ? " is-active" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="title-row">
        {activity > 0 ? <span title="执行中的任务" className="live-dot"></span> : null}
        <strong>{item.title || "新对话"}</strong>
      </div>
      <small>{truncate(item.lastMessage || "尚无消息", 52)}</small>
      <div className="meta">
        <span>{timeAgo(item.updatedAt)}</span>
        <span>·</span>
        <span>{item.messageCount} 条</span>
      </div>
      <button
        className="conversation-delete"
        type="button"
        title="删除对话"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDelete();
        }}
      >
        <Icon name="trash" />
      </button>
    </div>
  );
}

function EmptyChat({
  conversation,
  disabled,
  onSuggestion,
}: {
  conversation: Conversation | null;
  disabled: boolean;
  onSuggestion: (value: string) => void;
}) {
  return (
    <div className="empty-chat">
      <div className="empty-orb">
        <Icon name="worker" />
      </div>
      <h2>{conversation ? conversation.title || "新对话" : "让 Aura 开始工作"}</h2>
      <p>
        {conversation
          ? "这个对话还没有消息。发送一条消息，host 会持久化 inbox 并交给 router 决策。"
          : "Aura 使用 router Agent 做决策，worker 执行任务，最终回复会回到这里。先新建一个对话，或直接输入。"}
      </p>
      <div className="suggestion-grid">
        {suggestions.map((suggestion) => (
          <button
            className="suggestion"
            type="button"
            key={suggestion}
            disabled={disabled}
            onClick={() => {
              onSuggestion(suggestion);
              inputFocus();
            }}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function inputFocus() {
  requestAnimationFrame(() =>
    document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const assistant = message.role === "assistant";
  const meta = [
    assistant ? "Aura" : "你",
    timeAgo(message.createdAt),
    message.taskId ? `task ${message.taskId.slice(0, 14)}…` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={`message ${assistant ? "assistant" : "user"}`}>
      <div className="avatar">{assistant ? "A" : "你"}</div>
      <div className="message-body">
        <div className="message-meta">{meta}</div>
        <div className="bubble">
          <Markdown>{message.content}</Markdown>
        </div>
      </div>
    </div>
  );
}

function LiveBubble({ entry }: { entry: LiveWorkerEntry }) {
  return (
    <div className="message assistant is-live">
      <div className="avatar">A</div>
      <div className="message-body">
        <div className="message-meta">
          {entry.workerId || "worker"} ·{" "}
          {entry.status === "running" ? "流式输出" : statusLabel(entry.status)}
        </div>
        <div className="bubble">
          {entry.content ? (
            <Markdown>{entry.content}</Markdown>
          ) : (
            <span className="message-meta">{entry.progress || "Worker 正在处理…"}</span>
          )}
        </div>
        {entry.reasoning ? (
          <div className="reasoning">{truncate(entry.reasoning, 1600)}</div>
        ) : null}
      </div>
    </div>
  );
}

function chatBanner(
  app: AppStatus | null,
  bootError: string | null
): { message: string; error: boolean; action: boolean } {
  if (bootError) return { message: bootError, error: true, action: false };
  if (!app) return { message: "正在连接 Aura 后端…", error: false, action: false };
  if (app.state === "error")
    return { message: app.lastError || "Host 启动失败，请检查设置。", error: true, action: true };
  if (!app.model.configured)
    return {
      message: app.issues.length
        ? `模型尚未就绪：${app.issues.join("；")}。`
        : "模型尚未就绪，请前往设置完成配置。",
      error: false,
      action: true,
    };
  if (app.state === "applying")
    return { message: "配置正在应用，Host 将短暂重启。", error: false, action: false };
  if (app.state === "starting")
    return { message: "Host 正在启动，请稍候…", error: false, action: false };
  if (app.state === "stopped")
    return { message: "Host 已停止，请检查设置并重新应用配置。", error: true, action: true };
  if (app.configWarnings.length)
    return { message: app.configWarnings.join("；"), error: false, action: false };
  return { message: "", error: false, action: false };
}
