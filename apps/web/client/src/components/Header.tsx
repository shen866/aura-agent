import { useEffect, useState } from "react";
import { useAura } from "../AuraContext";
import { isActiveStatus } from "../types";
import type { ViewName } from "../types";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

const tabs: { id: ViewName; label: string; icon: IconName }[] = [
  { id: "chat", label: "对话", icon: "chat" },
  { id: "monitor", label: "Worker 监控", icon: "monitor" },
  { id: "settings", label: "设置", icon: "settings" },
];

function initialTheme(): "light" | "dark" {
  return localStorage.getItem("aura-theme") === "light" ? "light" : "dark";
}

export function Header() {
  const { app, tasks, connection, view, setView, refresh } = useAura();
  const [theme, setTheme] = useState<"light" | "dark">(initialTheme);
  const activeTasks = tasks.filter((task) => isActiveStatus(task.status)).length;
  const connectionLabel =
    connection === "online" ? "已连接" : connection === "offline" ? "已断开" : "连接中";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("aura-theme", theme);
  }, [theme]);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <span></span>
        </span>
        <div className="brand-text">
          <strong>Aura</strong>
          <small>multi-agent console</small>
        </div>
      </div>
      <nav className="tabs" aria-label="主导航">
        {tabs.map((tab) => (
          <button
            className={`tab${view === tab.id ? " is-active" : ""}`}
            type="button"
            key={tab.id}
            onClick={() => setView(tab.id)}
            aria-current={view === tab.id ? "page" : undefined}
          >
            <Icon name={tab.icon} />
            <span>{tab.label}</span>
            {tab.id === "monitor" && activeTasks > 0 ? (
              <span className="tab-badge">{activeTasks}</span>
            ) : null}
          </button>
        ))}
      </nav>
      <div className="top-meta">
        <span className="connection" data-state={connection}>
          <span className="dot"></span>
          <span>{connectionLabel}</span>
        </span>
        <span
          className={`model-pill${app?.model.configured ? " is-ready" : ""}`}
          title={
            app?.model.configured ? `${app.model.format} · ${app.model.model}` : "模型尚未配置完成"
          }
        >
          <Icon name="worker" />
          <span>{app?.model.model || "未配置"}</span>
        </span>
        <button
          className="icon-button"
          type="button"
          title={theme === "light" ? "切换到深色" : "切换到浅色"}
          aria-label="切换主题"
          onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
        >
          <Icon name={theme === "light" ? "moon" : "sun"} />
        </button>
        <button
          className="icon-button"
          type="button"
          title="刷新"
          aria-label="刷新"
          onClick={() => void refresh(true)}
        >
          <Icon name="refresh" />
        </button>
      </div>
    </header>
  );
}
