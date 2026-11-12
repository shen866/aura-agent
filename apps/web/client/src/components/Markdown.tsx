import { Fragment } from "react";
import type { ReactNode } from "react";

const INLINE_PATTERN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:[^)\s]+\))/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  INLINE_PATTERN.lastIndex = 0;
  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      const link = /^\[([^\]]+)\]\((https?:[^)\s]+)\)$/.exec(token);
      if (link) {
        nodes.push(
          <a key={key} href={link[2]} target="_blank" rel="noopener noreferrer">
            {link[1]}
          </a>
        );
      }
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function textBlock(text: string, key: string): ReactNode {
  const lines = text.split("\n");
  return (
    <Fragment key={key}>
      {lines.map((line, index) => (
        <Fragment key={`${key}-${index}`}>
          {index > 0 ? <br /> : null}
          {inline(line, `${key}-${index}`)}
        </Fragment>
      ))}
    </Fragment>
  );
}

/** 与旧控制台一致的小型 Markdown 子集，使用 React 节点避免注入原始 HTML。 */
export function Markdown({ children }: { children: string }) {
  const nodes: ReactNode[] = [];
  const pattern = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(children)) !== null) {
    if (match.index > cursor)
      nodes.push(textBlock(children.slice(cursor, match.index), `text-${index}`));
    nodes.push(
      <pre key={`code-${index}`}>
        <code>{(match[2] ?? "").replace(/\n$/, "")}</code>
      </pre>
    );
    cursor = match.index + match[0].length;
    index += 1;
  }
  if (cursor < children.length || nodes.length === 0) {
    nodes.push(textBlock(children.slice(cursor), `text-${index}`));
  }
  return <>{nodes}</>;
}
