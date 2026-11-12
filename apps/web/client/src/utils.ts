import type { TaskStatus, TaskStats, TaskSummary } from "./types";

const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "排队中",
  retry_wait: "等待重试",
  running: "运行中",
  cancel_requested: "取消中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
};

export function statusLabel(status: TaskStatus | string | undefined): string {
  return status && status in STATUS_LABELS
    ? STATUS_LABELS[status as TaskStatus]
    : (status ?? "未知");
}

export function formatTime(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatShortTime(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function timeAgo(value: string | undefined): string {
  if (!value) return "—";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatTime(value);
}

export function formatDuration(start: string | undefined, end = new Date().toISOString()): string {
  if (!start) return "—";
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return "—";
  const ms = Math.max(0, to - from);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function truncate(value: unknown, max = 80): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function taskStats(tasks: TaskSummary[]): TaskStats {
  const stats: TaskStats = {
    total: tasks.length,
    queued: 0,
    retry_wait: 0,
    running: 0,
    cancel_requested: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const task of tasks) stats[task.status] += 1;
  return stats;
}
