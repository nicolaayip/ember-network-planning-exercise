/** @format */

import type { ReactNode } from "react";

export function Panel({
  title,
  sub,
  headerAction,
  children,
  tight,
  className = "",
}: {
  title?: ReactNode;
  sub?: ReactNode;
  headerAction?: ReactNode;
  children: ReactNode;
  tight?: boolean;
  className?: string;
}) {
  return (
    <section className={`panel ${tight ? "tight" : ""} ${className}`}>
      {title && (
        <div className="panel-header">
          <h2>
            {title}
            {sub && <small>{sub}</small>}
          </h2>
          {headerAction && <div className="panel-header-action">{headerAction}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  active,
  activeTone,
  onClick,
  compact,
  className = "",
  dayType,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  active?: boolean;
  activeTone?: "weekday" | "weekend";
  onClick?: () => void;
  compact?: boolean;
  className?: string;
  dayType?: "weekday" | "weekend";
}) {
  const classes = [
    "stat",
    compact && "stat-compact",
    active && "active",
    active && activeTone === "weekday" && "active-weekday",
    active && activeTone === "weekend" && "active-weekend",
    onClick && "clickable",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className="label-container">
        <div className="label">{label}</div>

        {dayType && (
          <div
            className={`day-type ${dayType === "weekday" ? "day-type-weekday" : "day-type-weekend"}`}
          >
            {dayType === "weekday" ? "weekday" : "weekend"}
          </div>
        )}
      </div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Badge({
  kind,
  children,
}: {
  kind: "ok" | "warn" | "bad" | "info" | "neutral";
  children: ReactNode;
}) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

export function Check({ ok }: { ok: boolean | undefined }) {
  if (ok === undefined) return <span className="muted">–</span>;
  return <span className={`check ${ok ? "ok" : "bad"}`}>{ok ? "✓" : "✗"}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export type ConsiderationItem = {
  label?: string;
  text: string;
  sources?: string[];
};

function ConsiderationList({ items }: { items: ConsiderationItem[] }) {
  return (
    <ul className="consideration-list">
      {items.map((item) => (
        <li key={`${item.label ?? ""}-${item.text}`}>
          {item.label && (
            <>
              <strong className="consideration-label">{item.label}</strong>{" "}
            </>
          )}
          <span className="consideration-answer">{item.text}</span>
          {item.sources && item.sources.length > 0 && (
            <span className="consideration-sources">
              {item.sources.map((s) => (
                <span key={s} className="source-tag">
                  {s}
                </span>
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Route review feedback — edit copy in the view that renders this. */
export function Feedback({
  feedback,
  improvements,
  improvementsTitle = "Suggested improvements",
  considerations,
  paragraphs,
  placeholder = "Replace with feedback and suggested improvements for the proposal.",
}: {
  feedback?: string;
  improvements?: string[];
  improvementsTitle?: string;
  considerations?: ConsiderationItem[];
  paragraphs?: string[];
  placeholder?: string;
}) {
  return (
    <section className="feedback">
      {paragraphs && paragraphs?.length && (
        <>
          <h3>Draft</h3>
          {paragraphs.map((p) => (
            <p key={p.slice(0, 48)} className="feedback-body">
              {p}
            </p>
          ))}
        </>
      )}

      <h3>Feedback</h3>
      {feedback ? (
        <p className="feedback-body">{feedback}</p>
      ) : (
        <p className="feedback-body feedback-placeholder">{placeholder}</p>
      )}
      <h3>{improvementsTitle}</h3>
      {improvements && improvements.length > 0 ? (
        <ul className="feedback-body">
          {improvements.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : (
        <ul className="feedback-body feedback-placeholder">
          <li>{placeholder}</li>
        </ul>
      )}
      {considerations && considerations.length > 0 && (
        <div className="feedback-considerations">
          <p className="feedback-considerations-sub">
            Additional factors to weigh that are not yet built into the model
          </p>
          <ConsiderationList items={considerations} />
        </div>
      )}
    </section>
  );
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
  disabled,
  title,
  className = "",
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; swatch?: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <div
      className={["seg", disabled && "disabled", className].filter(Boolean).join(" ")}
      title={disabled ? title : undefined}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? "active" : ""}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.swatch && (
            <span className="seg-swatch" style={{ background: o.swatch }} aria-hidden />
          )}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  unit?: string;
  render: (row: T, i: number) => ReactNode;
  num?: boolean;
  wrap?: boolean;
  title?: string;
  /** Fixed-width # column (44px) — use on route stops and legs tables. */
  rowNum?: boolean;
}

export type TableSection<T> =
  | { kind: "columns"; columns: Column<T>[] }
  | { kind: "group"; header: ReactNode; columns: Column<T>[] };

const cellClass = <T,>(c: Column<T>, groupStart?: boolean) =>
  [
    c.num ? "num" : "",
    c.wrap ? "wrap" : "",
    c.rowNum ? "col-row-num" : "",
    groupStart ? "col-group-start" : "",
  ]
    .filter(Boolean)
    .join(" ");

function columnHeader<T>(c: Column<T>) {
  return (
    <>
      {c.header}
      {c.unit ? <span className="col-unit">{c.unit}</span> : null}
    </>
  );
}

function flatColumns<T>(sections: TableSection<T>[]): Column<T>[] {
  return sections.flatMap((s) => s.columns);
}

export function DataTable<T>({
  rows,
  columns,
  sections,
  rowKey,
  rowClassName,
  maxHeight,
}: {
  rows: T[];
  /** Flat column list — use when no grouped headers are needed. */
  columns?: Column<T>[];
  /** Optional grouped header row above nested column headers. */
  sections?: TableSection<T>[];
  rowKey: (row: T, i: number) => string;
  rowClassName?: (row: T, i: number) => string | undefined;
  maxHeight?: number;
}) {
  const resolved: TableSection<T>[] = sections ?? [
    { kind: "columns", columns: columns ?? [] },
  ];
  const allColumns = flatColumns(resolved);
  const hasGroups = resolved.some((s) => s.kind === "group");
  const groupStartKeys = new Set<string>();
  resolved.forEach((section, si) => {
    if (si === 0) return;
    const first = section.columns[0];
    if (first) groupStartKeys.add(first.key);
  });

  return (
    <div className="table-wrap" style={maxHeight ? { maxHeight } : undefined}>
      <table className="data">
        <thead>
          {hasGroups ? (
            <>
              <tr>
                {resolved.map((section, si) => (
                  <th
                    key={`group-${si}`}
                    colSpan={section.columns.length}
                    className={[
                      "group-header",
                      si > 0 && "col-group-start",
                      section.kind === "columns" && "group-header-spacer",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {section.kind === "group" ? section.header : null}
                  </th>
                ))}
              </tr>
              <tr>
                {resolved.flatMap((section) =>
                  section.columns.map((c) => (
                    <th
                      key={c.key}
                      className={cellClass(c, groupStartKeys.has(c.key))}
                      title={c.title}
                    >
                      {columnHeader(c)}
                    </th>
                  )),
                )}
              </tr>
            </>
          ) : (
            <tr>
              {allColumns.map((c) => (
                <th key={c.key} className={cellClass(c)} title={c.title}>
                  {columnHeader(c)}
                </th>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey(r, i)} className={rowClassName?.(r, i)}>
              {allColumns.map((c) => (
                <td key={c.key} className={cellClass(c, groupStartKeys.has(c.key))}>
                  {c.render(r, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
