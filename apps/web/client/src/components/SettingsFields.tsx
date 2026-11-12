import type { ReactNode } from "react";
import type { SecretPath, SecretStatus } from "../types";
import { Icon } from "./Icon";

interface FieldProps {
  label: string;
  path: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number";
  placeholder?: string;
  hint?: string;
  full?: boolean;
  min?: number;
  max?: number;
  step?: number;
}

export function Field({
  label,
  path,
  value,
  onChange,
  type = "text",
  placeholder = "",
  hint = "",
  full = false,
  min,
  max,
  step,
}: FieldProps) {
  return (
    <div className={`field${full ? " full" : ""}`}>
      <label>{label}</label>
      <input
        className="input"
        type={type}
        data-path={path}
        data-value-type={type === "number" ? "number" : "text"}
        value={value}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export interface SelectChoice {
  value: string;
  label: string;
}

interface SelectFieldProps {
  label: string;
  path: string;
  value: string;
  choices: readonly SelectChoice[];
  onChange: (value: string) => void;
  hint?: string;
  full?: boolean;
}

export function SelectField({
  label,
  path,
  value,
  choices,
  onChange,
  hint = "",
  full = false,
}: SelectFieldProps) {
  return (
    <div className={`field${full ? " full" : ""}`}>
      <label>{label}</label>
      <select
        className="select"
        data-path={path}
        data-value-type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {choices.map((choice, index) => (
          <option key={`${index}:${choice.value}`} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

interface CheckFieldProps {
  label: string;
  path: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  full?: boolean;
}

export function CheckField({
  label,
  path,
  checked,
  onChange,
  hint = "",
  full = false,
}: CheckFieldProps) {
  return (
    <div className={`field${full ? " full" : ""}`}>
      <label>{label}</label>
      <label className="check">
        <input
          type="checkbox"
          data-path={path}
          data-value-type="bool"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{hint || "启用"}</span>
      </label>
    </div>
  );
}

interface SecretFieldProps {
  label: string;
  path: SecretPath;
  value: string;
  status: SecretStatus[SecretPath] | undefined;
  cleared: boolean;
  onChange: (value: string) => void;
  onClear: () => void;
  hint?: string;
  full?: boolean;
}

export function SecretField({
  label,
  path,
  value,
  status,
  cleared,
  onChange,
  onClear,
  hint = "",
  full = false,
}: SecretFieldProps) {
  const statusHint = status?.hint ?? "";
  const placeholder = cleared
    ? "保存后将清除"
    : status?.set
      ? `已配置 ${statusHint}，留空保持不变`
      : "尚未配置";
  return (
    <div className={`field${full ? " full" : ""}`}>
      <label>{label}</label>
      <div className="input-row">
        <input
          className="input secret"
          type="password"
          data-secret-path={path}
          value={value}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        <button className="secret-clear" type="button" data-secret-clear={path} onClick={onClear}>
          清除
        </button>
      </div>
      <span className="hint">
        {hint ||
          (status?.set
            ? `当前值 ${statusHint}。留空提交会保留原值；点击清除后保存会删除。`
            : "Token 只保存在本机 data/config.json，文件权限为 600。")}
      </span>
    </div>
  );
}

type SectionIcon = "key" | "plug" | "monitor" | "worker" | "settings";

interface SectionHeaderProps {
  icon: SectionIcon;
  title: string;
  description: string;
  headMeta?: ReactNode;
}

export function SectionHeader({ icon, title, description, headMeta }: SectionHeaderProps) {
  return (
    <div className="settings-card-head">
      <div className="section-icon">
        <Icon name={icon} />
      </div>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {headMeta ? <div className="head-meta">{headMeta}</div> : null}
    </div>
  );
}

interface WebhookBoxProps {
  path: string;
  label: string;
  onCopy: (url: string) => void;
}

export function WebhookBox({ path, label, onCopy }: WebhookBoxProps) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const url = `${origin}${path}`;
  return (
    <div className="field full">
      <label>{label}</label>
      <div className="webhook-url">
        <code>{url}</code>
        <button
          className="row-action"
          type="button"
          data-copy={url}
          title="复制地址"
          onClick={() => onCopy(url)}
        >
          <Icon name="copy" />
        </button>
      </div>
      <span className="hint">在平台侧把 Webhook 指向该地址；签名密钥使用上方配置。</span>
    </div>
  );
}
