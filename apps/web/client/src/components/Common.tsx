import type { ReactNode } from "react";
import type { TaskStatus } from "../types";
import { statusLabel } from "../utils";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`status-badge is-${status}`}>
      <span className="dot"></span>
      {statusLabel(status)}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  icon = "worker",
  compact = true,
}: {
  title: string;
  description: string;
  icon?: IconName;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state${compact ? " compact" : ""}`}>
      <Icon name={icon} />
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}

export function Alert({
  type,
  children,
}: {
  type: "info" | "warn" | "error";
  children: ReactNode;
}) {
  return (
    <div className={`alert is-${type}`}>
      <Icon name={type === "info" ? "check" : "alert"} />
      <div>{children}</div>
    </div>
  );
}
