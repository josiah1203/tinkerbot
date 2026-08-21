import type { ButtonHTMLAttributes, ComponentPropsWithoutRef, ReactNode } from "react";
import { useId, useState } from "react";
import "./figma.css";
import "./teams.css";
import "./teams-extra.css";
import "./teams-surfaces.css";
import "./airtable-surfaces.css";

const join = (...values: Array<string | false | undefined>) => values.filter(Boolean).join(" ");

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

export type ControlSize = "sm" | "md" | "lg";
export function Button({ variant = "secondary", size = "md", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ControlSize }) {
  return <button className={join("tb-button", `tb-button-${variant}`, `tb-button-${size}`, className)} {...props} />;
}

export function IconButton({ label, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button aria-label={label} className={join("tb-icon-button", className)} {...props}>{children}</button>;
}

export function Icon({ name, size = 16, label }: { name: "plus" | "search" | "chevronDown" | "more" | "close" | "check"; size?: 12 | 14 | 16 | 20 | 24; label?: string }) {
  const paths = { plus: <><path d="M8 3v10M3 8h10" /></>, search: <><circle cx="6.5" cy="6.5" r="3.5" /><path d="m9 9 4 4" /></>, chevronDown: <path d="m4 6 4 4 4-4" />, more: <path d="M3 8h.01M8 8h.01M13 8h.01" />, close: <><path d="m4 4 8 8M12 4 4 12" /></>, check: <path d="m3 8 3 3 7-7" /> };
  return <svg className="tb-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden={label ? undefined : true} aria-label={label} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export function AppFrame({ header, sidebar, children }: { header: ReactNode; sidebar?: ReactNode; children: ReactNode }) { return <section className="tb-app-frame"><header>{header}</header><div>{sidebar && <aside>{sidebar}</aside>}<main>{children}</main></div></section>; }

export function Stack({ gap = 8, children, className }: { gap?: 4 | 8 | 16 | 24 | 32 | 40 | 64; children: ReactNode; className?: string }) { return <div className={join("tb-stack", className)} style={{ gap }}>{children}</div>; }

export function Text({ as: Element = "p", kind = "default", children, className }: { as?: "p" | "span" | "h1" | "h2" | "h3"; kind?: "default" | "small" | "large" | "xsmall" | "heading"; children: ReactNode; className?: string }) { return <Element className={join("tb-text", `tb-text-${kind}`, className)}>{children}</Element>; }

/** Airtable-inspired building blocks for dense, composable application surfaces. */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={join("tb-card", className)}>{children}</section>;
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <header className="tb-card-header"><div><h3>{title}</h3>{description && <p>{description}</p>}</div>{action && <div className="tb-card-action">{action}</div>}</header>;
}

export function Divider({ className }: { className?: string }) { return <hr className={join("tb-divider", className)} />; }

export function Tag({ color = "gray", children }: { color?: "gray" | "red" | "blue" | "green" | "yellow" | "purple"; children: ReactNode }) {
  return <span className={join("tb-tag", `tb-tag-${color}`)}>{children}</span>;
}

export type PaletteColor = "white" | "blue" | "cyan" | "teal" | "green" | "yellow" | "orange" | "red" | "pink" | "purple" | "gray";
export function ColorSwatch({ color, selected = false, label }: { color: PaletteColor; selected?: boolean; label?: string }) {
  return <button type="button" className={join("tb-color-swatch", `tb-color-${color}`, selected && "tb-color-selected")} aria-label={label ?? color} aria-pressed={selected}><span>{selected ? "✓" : ""}</span></button>;
}

export function SelectButton({ selected, children, onClick }: { selected?: boolean; children: ReactNode; onClick?: () => void }) {
  return <button type="button" className={join("tb-select-button", selected && "tb-select-button-selected")} aria-pressed={selected} onClick={onClick}>{children}</button>;
}

export type StatusTone = "verified" | "review" | "unknown" | "blocked" | "info" | "neutral";
export function StatusBadge({ tone = "neutral", children }: { tone?: StatusTone; children: ReactNode }) {
  return <span className={join("tb-status", `tb-status-${tone}`)}>{children}</span>;
}

export function Avatar({ name, initials, presence }: { name: string; initials?: string; presence?: "online" | "offline" }) {
  const letters = initials ?? name.split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase();
  return <span className={join("tb-avatar", presence === "online" && "tb-avatar-online")} aria-label={name}>{letters}</span>;
}

export function AvatarLabel({ name, initials, color = "blue" }: { name: string; initials?: string; color?: PaletteColor }) {
  const letters = initials ?? name.split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase();
  return <span className="tb-avatar-label"><span className={join("tb-avatar-label-face", `tb-color-${color}`)}>{letters}</span><span>{name}</span></span>;
}

export function IconButtonGroup({ children, label = "Actions" }: { children: ReactNode; label?: string }) { return <div className="tb-icon-group" role="group" aria-label={label}>{children}</div>; }

type FieldBase = { label: string; hint?: string; error?: string; className?: string };
export function TextField({ label, hint, error, className, id, size = "md", ...props }: FieldBase & Omit<ComponentPropsWithoutRef<"input">, "size"> & { size?: ControlSize }) {
  const generatedId = useId(); const fieldId = id ?? generatedId;
  return <label className={join("tb-field", `tb-field-${size}`, className)} htmlFor={fieldId}><span>{label}</span><input id={fieldId} aria-invalid={Boolean(error)} {...props} />{error ? <small className="tb-field-error">{error}</small> : hint ? <small>{hint}</small> : null}</label>;
}

export function SelectField({ label, hint, error, className, id, children, size = "md", ...props }: FieldBase & Omit<ComponentPropsWithoutRef<"select">, "size"> & { size?: ControlSize }) {
  const generatedId = useId(); const fieldId = id ?? generatedId;
  return <label className={join("tb-field", `tb-field-${size}`, className)} htmlFor={fieldId}><span>{label}</span><select id={fieldId} aria-invalid={Boolean(error)} {...props}>{children}</select>{error ? <small className="tb-field-error">{error}</small> : hint ? <small>{hint}</small> : null}</label>;
}

export function TextAreaField({ label, hint, error, className, id, ...props }: FieldBase & ComponentPropsWithoutRef<"textarea">) {
  const generatedId = useId(); const fieldId = id ?? generatedId;
  return <label className={join("tb-field", className)} htmlFor={fieldId}><span>{label}</span><textarea id={fieldId} aria-invalid={Boolean(error)} {...props} />{error ? <small className="tb-field-error">{error}</small> : hint ? <small>{hint}</small> : null}</label>;
}

export function Toggle({ label, checked, onChange, disabled, size = "md", tone = "default" }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; size?: ControlSize; tone?: "default" | "danger" }) {
  return <label className={join("tb-toggle-row", `tb-toggle-row-${size}`)}><button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className={join("tb-toggle", `tb-toggle-${tone}`, checked && "tb-toggle-on")}><span /></button><span>{label}</span></label>;
}

export function Checkbox({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return <label className="tb-checkbox" htmlFor={id}><input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span aria-hidden="true">✓</span>{label}</label>;
}

export function RadioGroup({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string; description?: string }> }) {
  const groupId = useId();
  return <fieldset className="tb-radio-group"><legend>{label}</legend>{options.map((option) => <label key={option.value} htmlFor={`${groupId}-${option.value}`}><input id={`${groupId}-${option.value}`} type="radio" name={groupId} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} /><span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span></label>)}</fieldset>;
}

export function SegmentedControl({ value, onChange, items }: { value: string; onChange: (value: string) => void; items: Array<{ value: string; label: string; icon?: ReactNode }> }) {
  return <div className="tb-segmented" role="group">{items.map((item) => <button type="button" key={item.value} className={value === item.value ? "tb-segmented-active" : ""} aria-pressed={value === item.value} onClick={() => onChange(item.value)}>{item.icon}<span>{item.label}</span></button>)}</div>;
}

export function Tabs({ items, value, onChange }: { items: Array<{ value: string; label: string; count?: number }>; value: string; onChange: (value: string) => void }) {
  return <div className="tb-tabs" role="tablist">{items.map((item) => <button key={item.value} role="tab" aria-selected={value === item.value} className={value === item.value ? "tb-tab-active" : ""} onClick={() => onChange(item.value)}>{item.label}{item.count != null && <b>{item.count}</b>}</button>)}</div>;
}

export function Breadcrumbs({ items }: { items: string[] }) {
  return <nav className="tb-breadcrumbs" aria-label="Breadcrumb">{items.map((item, index) => <span key={`${item}-${index}`}>{index > 0 && <i>/</i>}{item}</span>)}</nav>;
}

export function CommandBar({ placeholder = "Search work, factories, commands…", shortcut = "⌘ K" }: { placeholder?: string; shortcut?: string }) {
  return <button className="tb-command" type="button"><span aria-hidden="true">⌕</span><span>{placeholder}</span><kbd>{shortcut}</kbd></button>;
}

export function Alert({ tone = "info", title, children, action }: { tone?: "info" | "success" | "danger" | "warning"; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className={join("tb-alert", `tb-alert-${tone}`)} role={tone === "danger" ? "alert" : "status"}><div><strong>{title}</strong><p>{children}</p></div>{action}</div>;
}

export function Progress({ value, label }: { value: number; label?: string }) {
  const normalized = Math.max(0, Math.min(100, value));
  return <div className="tb-progress" aria-label={label ?? "Progress"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={normalized} role="progressbar">{label && <span>{label}<b>{normalized}%</b></span>}<i><em style={{ width: `${normalized}%` }} /></i></div>;
}

export function Spinner({ label = "Loading" }: { label?: string }) { return <span className="tb-spinner" role="status" aria-label={label} />; }

export function Skeleton({ lines = 3 }: { lines?: number }) { return <div className="tb-skeleton" aria-label="Loading content">{Array.from({ length: lines }, (_, index) => <i key={index} />)}</div>; }

export function Toast({ title, children, onDismiss }: { title: string; children: ReactNode; onDismiss?: () => void }) {
  return <div className="tb-toast" role="status"><div><strong>{title}</strong><p>{children}</p></div>{onDismiss && <IconButton label="Dismiss notification" onClick={onDismiss}>×</IconButton>}</div>;
}

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="tb-empty"><span aria-hidden="true">+</span><h3>{title}</h3><p>{children}</p>{action}</div>;
}

export function Dialog({ title, children, open, onClose, footer }: { title: string; children: ReactNode; open: boolean; onClose: () => void; footer?: ReactNode }) {
  if (!open) return null;
  return <div className="tb-dialog-backdrop" role="presentation"><section className="tb-dialog" role="dialog" aria-modal="true" aria-label={title}><IconButton label="Close dialog" onClick={onClose}>×</IconButton><h2>{title}</h2><div>{children}</div>{footer && <footer>{footer}</footer>}</section></div>;
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return <span className="tb-tooltip"><span>{children}</span><i role="tooltip">{label}</i></span>;
}

export function Menu({ items }: { items: Array<{ label: string; shortcut?: string; danger?: boolean; onSelect?: () => void }> }) {
  return <div className="tb-menu" role="menu">{items.map((item) => <button key={item.label} role="menuitem" onClick={item.onSelect} className={item.danger ? "tb-menu-danger" : ""}>{item.label}{item.shortcut && <kbd>{item.shortcut}</kbd>}</button>)}</div>;
}

export function Sheet({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <aside className="tb-sheet" aria-label={title}><header><h3>{title}</h3><IconButton label="Close sheet">×</IconButton></header><div>{children}</div>{action && <footer>{action}</footer>}</aside>;
}

export type Column<Row> = { key: string; header: string; render: (row: Row) => ReactNode };
export function DataTable<Row extends { id: string }>({ columns, rows, selected, onSelect }: { columns: Array<Column<Row>>; rows: Row[]; selected?: Set<string>; onSelect?: (id: string, checked: boolean) => void }) {
  return <div className="tb-table-wrap"><table className="tb-table"><thead><tr>{onSelect && <th aria-label="Select" />}{columns.map((column) => <th key={column.key}>{column.header}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.id}>{onSelect && <td><input type="checkbox" aria-label={`Select ${row.id}`} checked={selected?.has(row.id) ?? false} onChange={(event) => onSelect(row.id, event.target.checked)} /></td>}{columns.map((column) => <td key={column.key}>{column.render(row)}</td>)}</tr>)}</tbody></table></div>;
}

export function Pagination({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }) {
  return <nav className="tb-pagination" aria-label="Pagination"><Button size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>Previous</Button><span>Page {page} of {pages}</span><Button size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>Next</Button></nav>;
}

export function MetricCard({ label, value, trend, tone = "neutral" }: { label: string; value: string; trend: string; tone?: StatusTone }) {
  return <article className="tb-metric"><span>{label}</span><strong>{value}</strong><StatusBadge tone={tone}>{trend}</StatusBadge></article>;
}

export function Timeline({ items }: { items: Array<{ title: string; meta: string; tone?: StatusTone }> }) {
  return <ol className="tb-timeline">{items.map((item) => <li key={item.title}><span className={`tb-timeline-${item.tone ?? "neutral"}`} /><div><strong>{item.title}</strong><p>{item.meta}</p></div></li>)}</ol>;
}

export type TeamsButtonVariant = "primary" | "default" | "subtle" | "danger";
export function TeamsButton({ variant = "default", size = "md", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: TeamsButtonVariant; size?: ControlSize }) { return <button className={join("teams-button", variant !== "default" && `teams-button-${variant}`, `teams-button-${size}`, className)} {...props} />; }
export function TeamsField({ label, children }: { label: string; children: ReactNode }) { return <label className="teams-input"><span>{label}</span>{children}</label>; }
export function TeamsCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) { return <label className="teams-check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>; }
export function TeamsRadio({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) { return <label className="teams-radio"><input type="radio" checked={checked} onChange={onChange} />{label}</label>; }
export function TeamsTabs({ items, value, onChange }: { items: Array<{ value: string; label: string }>; value: string; onChange: (value: string) => void }) { return <div className="teams-tabs" role="tablist">{items.map((item) => <button key={item.value} role="tab" aria-selected={value === item.value} onClick={() => onChange(item.value)}>{item.label}</button>)}</div>; }
export function TeamsPersona({ name, subtitle, initials }: { name: string; subtitle?: string; initials?: string }) { return <div className="teams-persona"><span className="teams-avatar">{initials ?? name.split(" ").map((part) => part[0]).join("").slice(0,2)}</span><span><b>{name}</b>{subtitle && <small>{subtitle}</small>}</span></div>; }
export function TeamsChatMessage({ author, time, children, initials }: { author: string; time: string; children: ReactNode; initials?: string }) { return <article className="teams-message"><span className="teams-avatar">{initials ?? author.slice(0,2)}</span><div className="teams-message-body"><div className="teams-message-head"><b>{author}</b><time>{time}</time></div><p>{children}</p></div></article>; }
export function TeamsCommandBar({ placeholder = "Search" }: { placeholder?: string }) { return <div className="teams-bar"><Icon name="search" /><input aria-label={placeholder} placeholder={placeholder} /><IconButton label="More"><Icon name="more" /></IconButton></div>; }
export function TeamsMenu({ items }: { items: Array<{ label: string; onClick?: () => void; danger?: boolean }> }) { return <div className="teams-menu" role="menu">{items.map((item) => <button key={item.label} role="menuitem" onClick={item.onClick} style={item.danger ? { color: "#c4314b" } : undefined}>{item.label}</button>)}</div>; }
export function TeamsMessageBar({ tone = "info", children }: { tone?: "info" | "success" | "warning" | "error"; children: ReactNode }) { return <div className={join("teams-alert", `teams-alert-${tone}`)} role={tone === "error" ? "alert" : "status"}>{children}</div>; }
export function TeamsCard({ children }: { children: ReactNode }) { return <article className="teams-card">{children}</article>; }
export function TeamsDialog({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) { return <section className="teams-dialog" role="dialog" aria-label={title}><h2>{title}</h2><p>{children}</p>{footer && <footer>{footer}</footer>}</section>; }
export function TeamsBadge({ tone, children }: { tone?: "success" | "warning" | "error"; children: ReactNode }) { return <span className={join("teams-badge", tone && `teams-badge-${tone}`)}>{children}</span>; }
export function TeamsSplitButton({ label, onClick }: { label: string; onClick?: () => void }) { return <span className="teams-split"><TeamsButton variant="primary" onClick={onClick}>{label}</TeamsButton><TeamsButton variant="primary" aria-label={`${label} options`}><Icon name="chevronDown" /></TeamsButton></span>; }
export function TeamsToolbar({ children }: { children: ReactNode }) { return <div className="teams-toolbar" role="toolbar">{children}</div>; }
export function TeamsBreadcrumbs({ items }: { items: string[] }) { return <nav className="teams-breadcrumbs" aria-label="Breadcrumb">{items.map((item,index) => <span key={item}>{index > 0 && " / "}{item}</span>)}</nav>; }
export function TeamsAccordion({ title, children, open = false }: { title: string; children: ReactNode; open?: boolean }) { return <details className="teams-accordion" open={open}><summary>{title}<Icon name="chevronDown" /></summary><div>{children}</div></details>; }
export function TeamsCompose({ placeholder = "Type a new message", onSend }: { placeholder?: string; onSend?: () => void }) { return <div className="teams-compose"><textarea aria-label={placeholder} placeholder={placeholder} /><div><IconButton label="Attach"><Icon name="plus" /></IconButton><TeamsButton variant="primary" onClick={onSend}>Send</TeamsButton></div></div>; }
export function TeamsActivityItem({ icon, title, meta }: { icon: ReactNode; title: string; meta: string }) { return <div className="teams-activity"><span>{icon}</span><div><b>{title}</b><small>{meta}</small></div></div>; }
export function TeamsAdaptiveCard({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }) { return <article className="teams-adaptive">{title && <header>{title}</header>}<div>{children}</div>{footer && <footer>{footer}</footer>}</article>; }
export function TeamsCarousel({ children }: { children: ReactNode }) { return <div className="teams-carousel"><div className="teams-carousel-track">{children}</div></div>; }
export function TeamsFilterBar({ filters, onRemove }: { filters: string[]; onRemove?: (filter: string) => void }) { return <div className="teams-filterbar"><Icon name="search" />{filters.map((filter) => <button key={filter} type="button" className="teams-filterchip" onClick={() => onRemove?.(filter)}>{filter} ×</button>)}</div>; }
export function TeamsCalendarEvent({ title, time }: { title: string; time: string }) { return <article className="teams-calendar-event"><b>{title}</b><small>{time}</small></article>; }
export function TeamsCallControls() { return <div className="teams-call-controls"><button aria-label="Toggle microphone"><Icon name="more" /></button><button aria-label="Toggle camera"><Icon name="more" /></button><button aria-label="Leave call"><Icon name="close" /></button></div>; }
export function AirtableChatMessage({ author, time, children, initials }: { author: string; time: string; children: ReactNode; initials?: string }) { return <article className="at-chat"><span className="at-chat-avatar">{initials ?? author.slice(0,2)}</span><div><b>{author}</b><time>{time}</time><p>{children}</p></div></article>; }
export function AirtableCompose({ placeholder = "Write a message" }: { placeholder?: string }) { return <div className="at-compose"><textarea aria-label={placeholder} placeholder={placeholder}/><footer><IconButton label="Attach"><Icon name="plus"/></IconButton><Button variant="primary" size="sm">Send</Button></footer></div>; }
export function AirtableFilterBar({ filters }: { filters: string[] }) { return <div className="at-filterbar"><Icon name="search"/>{filters.map((filter) => <button key={filter} className="at-filterchip">{filter} ×</button>)}</div>; }
export function AirtableAdaptiveCard({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) { return <article className="at-adaptive"><header>{title}</header><div>{children}</div>{footer && <footer>{footer}</footer>}</article>; }
export function AirtableCarousel({ children }: { children: ReactNode }) { return <div className="at-carousel">{children}</div>; }
export function AirtableCalendarEvent({ title, time }: { title: string; time: string }) { return <article className="at-calendar"><b>{title}</b><small>{time}</small></article>; }
export function AirtableActivity({ icon, title, meta }: { icon: ReactNode; title: string; meta: string }) { return <div className="at-activity"><span>{icon}</span><div><b>{title}</b><small>{meta}</small></div></div>; }
export function AirtableSplitButton({ label }: { label: string }) { return <span className="at-split"><Button variant="primary">{label}</Button><Button variant="primary" aria-label={`${label} options`}><Icon name="chevronDown"/></Button></span>; }
export function AirtableControlBar() { return <div className="at-controlbar"><button aria-label="Audio"><Icon name="more"/></button><button aria-label="Video"><Icon name="more"/></button><button aria-label="End"><Icon name="close"/></button></div>; }

export function ComponentLibraryState() {
  const [tab, setTab] = useState("all");
  const [toggle, setToggle] = useState(true);
  return { tab, setTab, toggle, setToggle };
}
