import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiFailure, api } from "../api";
import { useAura } from "../AuraContext";
import type { AuraEvent } from "../AuraContext";
import { useToast } from "../toast";
import { isActiveStatus } from "../types";
import type { MonitorEntry, TaskDetail, TaskStatus, TaskSummary } from "../types";
import {
  errorMessage,
  formatDuration,
  formatShortTime,
  formatTime,
  statusLabel,
  taskStats,
  timeAgo,
  truncate,
} from "../utils";
import { EmptyState, StatusBadge } from "./Common";
import { Icon } from "./Icon";

interface StatCardDefinition {
  key: TaskStatus | "";
  label: string;
  count: number;
  className: string;
}

function StatsGrid({
  stats,
  onSelect,
}: {
  stats: ReturnType<typeof taskStats>;
  onSelect: (status: TaskStatus | "") => void;
}) {
  const cards: StatCardDefinition[] = [
    { key: "", label: "全部任务", count: stats.total, className: "total" },
    { key: "running", label: "运行中", count: stats.running, className: "running" },
    { key: "queued", label: "排队中", count: stats.queued, className: "queued" },
    { key: "retry_wait", label: "等待重试", count: stats.retry_wait, className: "retry" },
    { key: "succeeded", label: "成功", count: stats.succeeded, className: "succeeded" },
    { key: "failed", label: "失败", count: stats.failed, className: "failed" },
    { key: "cancelled", label: "已取消", count: stats.cancelled, className: "cancelled" },
  ];

  return (
    <div className="stats-grid" id="stats-grid">
      {cards.map((card) => (
        <button
          className={`stat-card is-${card.className}`}
          data-stat-filter={card.key}
          type="button"
          key={card.key || "all"}
          onClick={() => onSelect(card.key)}
        >
          <div className="value">{card.count}</div>
          <div className="label">{card.label}</div>
        </button>
      ))}
    </div>
  );
}

function TaskTable({
  tasks,
  selectedId,
  onSelect,
  onCancel,
}: {
  tasks: TaskSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="task-table">
        <thead>
          <tr>
            <th>任务</th>
            <th>Worker</th>
            <th>状态</th>
            <th>尝试</th>
            <th>更新时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="task-rows">
          {tasks.map((task) => (
            <tr
              data-task-id={task.id}
              className={task.id === selectedId ? "is-selected" : undefined}
              key={task.id}
              onClick={() => onSelect(task.id)}
            >
              <td>
                <div className="task-title">
                  <strong>{truncate(task.input || "(空输入)", 64)}</strong>
                  <small>{task.id}</small>
                </div>
              </td>
              <td>
                <span className="worker-chip">
                  <Icon name="worker" />
                  {task.workerId}
                </span>
              </td>
              <td>
                <StatusBadge status={task.status} />
              </td>
              <td>
                <span className="attempt">
                  {task.attempts}/{task.maxAttempts}
                </span>
              </td>
              <td>
                <span className="time-cell" title={formatTime(task.updatedAt)}>
                  {timeAgo(task.updatedAt)}
                </span>
              </td>
              <td>
                {isActiveStatus(task.status) ? (
                  <button
                    className="row-action"
                    type="button"
                    data-cancel-row={task.id}
                    title="取消任务"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCancel(task.id);
                    }}
                  >
                    <Icon name="stop" />
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tasks.length === 0 ? (
        <div className="empty-state compact" id="task-empty">
          <strong>暂无任务</strong>
          <span>在对话页发送消息后，任务会出现在这里。</span>
        </div>
      ) : null}
    </div>
  );
}

function outputPreview(content: string): string {
  if (content.length <= 6000) return content;
  return `…（已截断前 ${content.length - 6000} 字符）\n${content.slice(-6000)}`;
}

function TimelineEntryView({ entry }: { entry: MonitorEntry }) {
  const time = formatShortTime(entry.at);

  if (entry.kind === "task") {
    const running = ["running", "retry_wait", "queued"].includes(entry.status);
    return (
      <div className={`timeline-entry${running ? " is-running" : ""}`}>
        <div className="timeline-head">
          <strong>任务状态</strong>
          <StatusBadge status={entry.status} />
          <span className="time">{time}</span>
        </div>
        <div className="timeline-text">第 {entry.attempt} 次执行</div>
      </div>
    );
  }

  if (entry.kind === "status") {
    return (
      <div className={`timeline-entry${entry.status === "running" ? " is-running" : ""}`}>
        <div className="timeline-head">
          <strong>Worker 状态</strong>
          <span>{statusLabel(entry.status)}</span>
          <span className="time">{time}</span>
        </div>
        {entry.message ? <div className="timeline-text">{entry.message}</div> : null}
      </div>
    );
  }

  if (entry.kind === "progress") {
    return (
      <div className="timeline-entry">
        <div className="timeline-head">
          <strong>进度</strong>
          <span className="time">{time}</span>
        </div>
        <div className="timeline-text">{entry.message}</div>
      </div>
    );
  }

  if (entry.kind === "output") {
    return (
      <div className="timeline-entry">
        <div className="timeline-head">
          <strong>{entry.stream === "reasoning" ? "推理输出" : "内容输出"}</strong>
          <span>{entry.chunks} chunks</span>
          <span className="time">{time}</span>
        </div>
        <div className={`timeline-output${entry.stream === "reasoning" ? " is-reasoning" : ""}`}>
          {outputPreview(entry.content)}
        </div>
      </div>
    );
  }

  if (entry.kind === "result") {
    return (
      <div className="timeline-entry is-result">
        <div className="timeline-head">
          <strong>Worker 结果</strong>
          <span className="time">{time}</span>
        </div>
        <div className="timeline-text">{entry.summary}</div>
      </div>
    );
  }

  return (
    <div className="timeline-entry is-error">
      <div className="timeline-head">
        <strong>Worker 错误</strong>
        <span className="time">{time}</span>
      </div>
      <div className="timeline-text">{entry.message}</div>
    </div>
  );
}

function TaskDetailPanel({
  selectedId,
  detail,
  loading,
  onCancel,
  onCopy,
}: {
  selectedId: string | null;
  detail: TaskDetail | null;
  loading: boolean;
  onCancel: (id: string) => void;
  onCopy: (id: string) => void;
}) {
  if (!selectedId) {
    return (
      <EmptyState
        title="选择一个任务"
        description="查看输入、结果、配置快照与实时执行时间线。"
        icon="monitor"
      />
    );
  }

  if (!detail || detail.task.id !== selectedId) {
    return (
      <EmptyState
        title={loading ? "加载任务详情…" : "暂无任务详情"}
        description="任务可能已被持久化或已不存在。"
        icon="clock"
      />
    );
  }

  const task = detail.task;
  const active = isActiveStatus(task.status);
  const profile = task.profile;
  const metadata = Object.fromEntries(
    Object.entries(task.metadata ?? {}).filter(([key]) => !key.startsWith("__"))
  );

  return (
    <>
      <div className="detail-head">
        <div>
          <h3>{truncate(task.input || "(空输入)", 110)}</h3>
          <small>{task.id}</small>
        </div>
        <div className="spacer"></div>
        <button
          className="row-action"
          type="button"
          data-copy-task={task.id}
          title="复制任务 ID"
          onClick={() => onCopy(task.id)}
        >
          <Icon name="copy" />
        </button>
        {active ? (
          <button
            className="button small danger"
            type="button"
            data-cancel-task={task.id}
            onClick={() => onCancel(task.id)}
          >
            <Icon name="stop" />
            取消
          </button>
        ) : null}
      </div>
      <div className="detail-body">
        <div className="detail-section">
          <h4>状态</h4>
          <div className="kv-grid">
            <div className="kv">
              <span>状态</span>
              <strong>{statusLabel(task.status)}</strong>
            </div>
            <div className="kv">
              <span>尝试</span>
              <strong>
                {task.attempts}/{task.maxAttempts}
              </strong>
            </div>
            <div className="kv">
              <span>Worker</span>
              <strong>{task.workerId}</strong>
            </div>
            <div className="kv">
              <span>模型</span>
              <strong>{profile.model ?? "—"}</strong>
            </div>
            <div className="kv">
              <span>创建</span>
              <strong>{formatTime(task.createdAt)}</strong>
            </div>
            <div className="kv">
              <span>耗时</span>
              <strong>
                {formatDuration(task.createdAt, active ? new Date().toISOString() : task.updatedAt)}
              </strong>
            </div>
            <div className="kv">
              <span>Run</span>
              <strong title={task.runId}>{task.runId.slice(0, 18)}…</strong>
            </div>
            <div className="kv">
              <span>优先级</span>
              <strong>{task.priority}</strong>
            </div>
            <div className="kv">
              <span>输出格式</span>
              <strong>{profile.outputFormat ?? "—"}</strong>
            </div>
            <div className="kv">
              <span>渠道</span>
              <strong>{task.origin.channel ?? "—"}</strong>
            </div>
            <div className="kv">
              <span>会话</span>
              <strong title={task.origin.conversationId}>
                {truncate(task.origin.conversationId ?? "—", 24)}
              </strong>
            </div>
            <div className="kv">
              <span>下次重试</span>
              <strong>{task.nextAttemptAt ? formatTime(task.nextAttemptAt) : "—"}</strong>
            </div>
          </div>
        </div>

        <div className="detail-section">
          <h4>输入</h4>
          <div className="detail-input">{task.input || "(空)"}</div>
        </div>

        {task.error ? (
          <div className="detail-section">
            <h4>错误</h4>
            <div className="detail-error">{task.error}</div>
          </div>
        ) : null}

        {task.result?.summary ? (
          <div className="detail-section">
            <h4>结果</h4>
            <div className="detail-result">{task.result.summary}</div>
            {task.result.data !== undefined ? (
              <div className="detail-input">{JSON.stringify(task.result.data, null, 2)}</div>
            ) : null}
          </div>
        ) : null}

        {task.result?.artifacts?.length ? (
          <div className="detail-section">
            <h4>Artifacts</h4>
            <div className="artifact-list">
              {task.result.artifacts.map((artifact, index) => (
                <span className="artifact" key={`${artifact.type}-${artifact.name}-${index}`}>
                  {artifact.type} · {artifact.name}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="detail-section">
          <h4>配置快照</h4>
          <div className="kv-grid">
            <div className="kv">
              <span>Capabilities</span>
              <strong>{profile.capabilities.join(", ") || "—"}</strong>
            </div>
            <div className="kv">
              <span>推理强度</span>
              <strong>{profile.reasoningEffort ?? "—"}</strong>
            </div>
            <div className="kv">
              <span>Tools allow</span>
              <strong>{profile.tools.allow?.join(", ") || "全部"}</strong>
            </div>
            <div className="kv">
              <span>Tools deny</span>
              <strong>{profile.tools.deny?.join(", ") || "—"}</strong>
            </div>
            <div className="kv">
              <span>记忆读</span>
              <strong>{profile.memory.read ? "开" : "关"}</strong>
            </div>
            <div className="kv">
              <span>记忆写</span>
              <strong>{profile.memory.write ? "开" : "关"}</strong>
            </div>
          </div>
        </div>

        {Object.keys(metadata).length > 0 ? (
          <div className="detail-section">
            <h4>Metadata</h4>
            <div className="detail-input">{JSON.stringify(metadata, null, 2)}</div>
          </div>
        ) : null}

        <div className="detail-section">
          <h4>执行时间线</h4>
          <div className="timeline">
            {detail.events.length > 0 ? (
              detail.events.map((entry) => <TimelineEntryView entry={entry} key={entry.id} />)
            ) : (
              <div className="timeline-text">暂无实时事件。服务重启后仅保留任务权威状态。</div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export function MonitorView({ visible }: { visible: boolean }) {
  const { app, tasks, subscribe, replaceTasks } = useAura();
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filterStatus, setFilterStatus] = useState<TaskStatus | "">("");
  const [filterWorker, setFilterWorker] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [filterSearch, setFilterSearch] = useState("");
  const [, setTimeRevision] = useState(0);

  const selectedIdRef = useRef<string | null>(null);
  const detailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailRequestRef = useRef(0);
  const tasksRequestRef = useRef(0);
  const mountedRef = useRef(true);

  const clearDetailTimer = useCallback(() => {
    if (detailTimerRef.current) clearTimeout(detailTimerRef.current);
    detailTimerRef.current = null;
  }, []);

  const clearSelection = useCallback(() => {
    selectedIdRef.current = null;
    detailRequestRef.current += 1;
    clearDetailTimer();
    setSelectedId(null);
    setDetail(null);
    setDetailLoading(false);
  }, [clearDetailTimer]);

  const loadDetail = useCallback(
    async (id: string) => {
      const request = ++detailRequestRef.current;
      setDetailLoading(true);
      try {
        const next = await api.task(id);
        if (
          !mountedRef.current ||
          request !== detailRequestRef.current ||
          selectedIdRef.current !== id
        )
          return;
        setDetail(next);
      } catch (error) {
        if (
          !mountedRef.current ||
          request !== detailRequestRef.current ||
          selectedIdRef.current !== id
        )
          return;
        if (error instanceof ApiFailure && error.status === 404) {
          clearSelection();
          return;
        }
        toast(errorMessage(error) || "加载任务详情失败", "error");
      } finally {
        if (mountedRef.current && request === detailRequestRef.current) setDetailLoading(false);
      }
    },
    [clearSelection, toast]
  );

  const scheduleDetailRefresh = useCallback(() => {
    const id = selectedIdRef.current;
    if (!id) return;
    clearDetailTimer();
    detailTimerRef.current = setTimeout(() => {
      detailTimerRef.current = null;
      if (mountedRef.current && selectedIdRef.current === id) void loadDetail(id);
    }, 400);
  }, [clearDetailTimer, loadDetail]);

  const refreshTasks = useCallback(
    async (notify = false) => {
      const request = ++tasksRequestRef.current;
      try {
        const data = await api.tasks({ limit: 200 });
        if (!mountedRef.current || request !== tasksRequestRef.current) return;
        replaceTasks(data.tasks, data.status);
        const currentId = selectedIdRef.current;
        if (currentId && !data.tasks.some((task) => task.id === currentId)) clearSelection();
        if (notify) toast("任务列表已刷新", "success", 2000);
      } catch (error) {
        if (!mountedRef.current || request !== tasksRequestRef.current) return;
        toast(errorMessage(error) || "刷新任务失败", "error");
      }
    },
    [clearSelection, replaceTasks, toast]
  );

  const selectTask = useCallback(
    (id: string) => {
      clearDetailTimer();
      selectedIdRef.current = id;
      setSelectedId(id);
      setDetail(null);
      void loadDetail(id);
    },
    [clearDetailTimer, loadDetail]
  );

  const cancelTask = useCallback(
    async (id: string) => {
      if (!window.confirm("取消这个任务？运行中的 worker 会收到中止信号。")) return;
      try {
        await api.cancelTask(id);
        if (!mountedRef.current) return;
        toast("已请求取消", "success");
        scheduleDetailRefresh();
      } catch (error) {
        if (!mountedRef.current) return;
        toast(errorMessage(error) || "取消失败", "error");
      }
    },
    [scheduleDetailRefresh, toast]
  );

  const copyTask = useCallback(
    async (id: string) => {
      try {
        await navigator.clipboard.writeText(id);
        if (mountedRef.current) toast("已复制到剪贴板", "success", 2000);
      } catch {
        if (mountedRef.current) toast("复制失败，请手动选择文本", "error");
      }
    },
    [toast]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      detailRequestRef.current += 1;
      tasksRequestRef.current += 1;
      clearDetailTimer();
    };
  }, [clearDetailTimer]);

  useEffect(() => {
    const timer = setTimeout(() => setFilterSearch(searchInput), 220);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (filterWorker && !app?.workers.some((worker) => worker.id === filterWorker)) {
      setFilterWorker("");
    }
  }, [app, filterWorker]);

  useEffect(() => {
    if (!visible) return;
    void refreshTasks();
    const id = selectedIdRef.current;
    if (id) void loadDetail(id);
  }, [visible, refreshTasks, loadDetail]);

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, clearSelection]);

  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setTimeRevision((current) => current + 1), 30000);
    return () => clearInterval(timer);
  }, [visible]);

  useEffect(() => {
    const onEvent = (event: AuraEvent) => {
      if (event.type === "bootstrap") {
        const id = selectedIdRef.current;
        if (id) void loadDetail(id);
      } else if (event.type === "task") {
        if (event.data.id === selectedIdRef.current) scheduleDetailRefresh();
      } else if (event.type === "worker-event") {
        if (event.data.taskId === selectedIdRef.current) scheduleDetailRefresh();
      }
    };
    return subscribe(onEvent);
  }, [subscribe, loadDetail, scheduleDetailRefresh]);

  const stats = useMemo(() => taskStats(tasks), [tasks]);
  const filteredTasks = useMemo(() => {
    const search = filterSearch.trim().toLowerCase();
    return tasks
      .filter((task) => !filterStatus || task.status === filterStatus)
      .filter((task) => !filterWorker || task.workerId === filterWorker)
      .filter(
        (task) =>
          !search ||
          task.input.toLowerCase().includes(search) ||
          task.id.toLowerCase().includes(search) ||
          task.workerId.toLowerCase().includes(search)
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }, [tasks, filterStatus, filterWorker, filterSearch]);

  return (
    <section
      className={`view${visible ? " is-active" : ""}`}
      data-view-panel="monitor"
      id="view-monitor"
      hidden={!visible}
    >
      <div className="page-head">
        <div>
          <span className="eyebrow">Observability</span>
          <h1>Worker 监控</h1>
          <p>任务状态以 Host 持久化记录为准，流式输出仅作调试参考。</p>
        </div>
        <div className="page-actions">
          <button
            className="button ghost"
            id="monitor-refresh"
            type="button"
            onClick={() => void refreshTasks(true)}
          >
            <Icon name="refresh" />
            刷新
          </button>
        </div>
      </div>

      <StatsGrid stats={stats} onSelect={setFilterStatus} />

      <div className="monitor-layout">
        <div className="monitor-main card">
          <div className="toolbar">
            <div className="filter-group">
              <label className="field-inline">
                <span>状态</span>
                <select
                  id="filter-status"
                  value={filterStatus}
                  onChange={(event) => setFilterStatus(event.target.value as TaskStatus | "")}
                >
                  <option value="">全部</option>
                  <option value="queued">排队中</option>
                  <option value="running">运行中</option>
                  <option value="retry_wait">等待重试</option>
                  <option value="cancel_requested">取消中</option>
                  <option value="succeeded">成功</option>
                  <option value="failed">失败</option>
                  <option value="cancelled">已取消</option>
                </select>
              </label>
              <label className="field-inline">
                <span>Worker</span>
                <select
                  id="filter-worker"
                  value={filterWorker}
                  onChange={(event) => setFilterWorker(event.target.value)}
                >
                  <option value="">全部 worker</option>
                  {(app?.workers ?? []).map((worker) => (
                    <option value={worker.id} key={worker.id}>
                      {worker.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="search-box">
              <Icon name="search" />
              <input
                id="filter-search"
                type="search"
                placeholder="搜索任务、ID 或 worker"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
              />
            </label>
          </div>
          <TaskTable
            tasks={filteredTasks}
            selectedId={selectedId}
            onSelect={selectTask}
            onCancel={(id) => void cancelTask(id)}
          />
        </div>

        <aside className="task-detail card" id="task-detail">
          <TaskDetailPanel
            selectedId={selectedId}
            detail={detail}
            loading={detailLoading}
            onCancel={(id) => void cancelTask(id)}
            onCopy={(id) => void copyTask(id)}
          />
        </aside>
      </div>
    </section>
  );
}
