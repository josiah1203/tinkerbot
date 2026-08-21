import { createRoot } from "react-dom/client";
import { useState } from "react";
import {
  AirtableActivity,
  AirtableAdaptiveCard,
  AirtableCalendarEvent,
  AirtableCarousel,
  AirtableChatMessage,
  AirtableCompose,
  AirtableControlBar,
  AirtableFilterBar,
  AirtableSplitButton,
  Alert,
  AppFrame,
  Avatar,
  AvatarLabel,
  Breadcrumbs,
  Button,
  Card,
  CardHeader,
  Checkbox,
  ColorSwatch,
  CommandBar,
  DataTable,
  Divider,
  Dialog,
  EmptyState,
  IconButton,
  IconButtonGroup,
  Icon,
  Menu,
  MetricCard,
  Pagination,
  Progress,
  RadioGroup,
  SegmentedControl,
  SelectField,
  SelectButton,
  Sheet,
  Skeleton,
  Spinner,
  StatusBadge,
  Stack,
  Tag,
  Tabs,
  Text,
  TextAreaField,
  TextField,
  Timeline,
  Toast,
  Toggle,
  Tooltip,
} from "../../packages/design-system/src/index";
import "../../packages/design-system/src/styles.css";
import "./component-library-preview-source.css";
import "./figma-preview.css";

type WorkRow = { id: string; title: string; owner: string; stage: "verified" | "review" | "unknown"; updated: string };
const work: WorkRow[] = [
  { id: "wo_01J8R8ZK7P", title: "Repair checkout authorization", owner: "J. Lee", stage: "unknown", updated: "2m ago" },
  { id: "wo_01J8R7GW4A", title: "Add reviewer receipt policy", owner: "System", stage: "verified", updated: "8m ago" },
  { id: "rel_01J8R5VTPD", title: "Release API gateway", owner: "M. Patel", stage: "review", updated: "14m ago" },
];

function Preview() {
  const [tab, setTab] = useState("all");
  const [digest, setDigest] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toastVisible, setToastVisible] = useState(true);
  const [selected, setSelected] = useState(new Set<string>([work[0].id]));
  const [density, setDensity] = useState("comfortable");
  const [notify, setNotify] = useState(true);
  const [scope, setScope] = useState("workspace");
  const [page, setPage] = useState(1);

  return <div className="react-library-preview">
    <div className="react-preview-head"><div><span className="react-kicker">React package</span><h3>Composable primitives, not static examples.</h3></div><StatusBadge tone="verified">@tinkerbot/design-system</StatusBadge></div>
    <div className="react-grid react-grid-three">
      <Card className="react-sample"><CardHeader title="Actions & identity" description="Figma kit: 28 / 32 / 36px variants." action={<Tag color="blue">Action</Tag>} /><Divider /><div className="react-card-body"><div className="react-row"><Button variant="primary" size="sm">Create</Button><Button variant="primary">Create work order</Button><Button variant="primary" size="lg">Create</Button></div><div className="react-row"><Button>View evidence</Button><Button variant="danger">Revoke access</Button><Avatar name="Jordan Lee" presence="online" /><AvatarLabel name="Jordan Lee" /><IconButtonGroup><Tooltip label="About verification"><IconButton label="About verification">?</IconButton></Tooltip><IconButton label="More actions">•••</IconButton></IconButtonGroup></div></div></Card>
      <article className="react-sample"><h4>Navigation</h4><Breadcrumbs items={["Acme", "Payments", "Work"]} /><div className="react-gap"><CommandBar /></div><Tabs items={[{ value: "all", label: "All work", count: 142 }, { value: "assigned", label: "Assigned", count: 8 }, { value: "blocked", label: "Blocked", count: 4 }]} value={tab} onChange={setTab} /></article>
      <article className="react-sample"><h4>State &amp; feedback</h4><div className="react-row"><StatusBadge tone="verified">Verified</StatusBadge><StatusBadge tone="review">Needs approval</StatusBadge><StatusBadge tone="unknown">UNKNOWN</StatusBadge></div><div className="react-gap"><Toggle label="Digest mode" checked={digest} onChange={setDigest} /></div><div className="react-gap"><Toggle size="sm" tone="danger" label="Pause mutations" checked={!digest} onChange={(value) => setDigest(!value)} /></div><div className="react-gap"><Button size="sm" onClick={() => setDialogOpen(true)}>Open confirmation</Button></div></article>
    </div>
    <div className="react-grid react-grid-three">
      <article className="react-sample"><h4>Messaging & compose</h4><AirtableChatMessage author="Jordan Lee" time="2m ago" initials="JL">Evidence is ready for the approval queue.</AirtableChatMessage><AirtableCompose /></article>
      <article className="react-sample"><h4>Filters & activity</h4><AirtableFilterBar filters={["Assigned to me", "High risk"]} /><div className="react-gap"><AirtableActivity icon={<Icon name="check" />} title="Policy updated" meta="Jordan Lee · 4 minutes ago" /></div><AirtableControlBar /></article>
      <article className="react-sample"><h4>Cards, carousel & calendar</h4><AirtableAdaptiveCard title="Release review" footer={<AirtableSplitButton label="Review" />}>Two checks need an owner before release.</AirtableAdaptiveCard><div className="react-gap"><AirtableCarousel><AirtableCalendarEvent title="Approval window" time="Today · 3:00 PM" /><AirtableCalendarEvent title="Release cutoff" time="Tomorrow · 10:00 AM" /></AirtableCarousel></div></article>
    </div>
    <div className="react-grid react-grid-three">
      <article className="react-sample"><h4>App frame & text</h4><AppFrame header={<div className="react-row"><Icon name="plus" /><Text kind="large">Projects</Text></div>} sidebar={<Stack gap={8}><Text kind="small">Workspace</Text><SelectButton selected>Overview</SelectButton><SelectButton>Settings</SelectButton></Stack>}><Stack gap={8}><Text as="h3" kind="xsmall">Production</Text><Text>Compact app-frame composition from the kit.</Text></Stack></AppFrame></article>
      <article className="react-sample"><h4>Selection controls</h4><div className="react-stack"><SegmentedControl value={density} onChange={setDensity} items={[{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }, { value: "wide", label: "Wide" }]} /><div className="react-row"><SelectButton selected>Grid</SelectButton><SelectButton>List</SelectButton><ColorSwatch color="blue" selected /><ColorSwatch color="cyan" /><ColorSwatch color="teal" /><ColorSwatch color="green" /><ColorSwatch color="yellow" /><ColorSwatch color="orange" /><ColorSwatch color="red" /><ColorSwatch color="pink" /><ColorSwatch color="purple" /></div><Checkbox label="Notify approvers when evidence changes" checked={notify} onChange={setNotify} /><RadioGroup label="Approval scope" value={scope} onChange={setScope} options={[{ value: "workspace", label: "Workspace", description: "All projects can use this policy." }, { value: "project", label: "Project only", description: "Scope it to Payments." }]} /></div></article>
      <article className="react-sample"><h4>Tags & progress</h4><div className="react-row"><Tag color="blue">API</Tag><Tag color="green">Verified</Tag><Tag color="yellow">Needs review</Tag><Tag color="purple">Policy</Tag></div><div className="react-gap"><Progress value={68} label="Evidence coverage" /></div><div className="react-row react-gap"><Spinner label="Syncing" /><span className="react-muted">Syncing checks</span></div></article>
      <article className="react-sample"><h4>Loading & pagination</h4><Skeleton lines={3} /><div className="react-gap"><Pagination page={page} pages={6} onChange={setPage} /></div></article>
    </div>
    <div className="react-grid react-grid-two">
      <article className="react-sample"><h4>Inputs</h4><div className="react-form-grid"><TextField label="Factory name" defaultValue="Payments production" /><SelectField label="Risk class" size="sm" defaultValue="high"><option value="high">High risk</option><option value="standard">Standard</option></SelectField><TextField label="Production URL" size="lg" placeholder="https://" /><TextAreaField className="react-field-wide" label="Approval note" defaultValue="Verification must remain deterministic." hint="Recorded with the decision." /></div></article>
      <article className="react-sample"><h4>Alerts &amp; recovery</h4><div className="react-stack"><Alert tone="info" title="Refresh delayed">Last confirmed 2m ago. We’ll retry automatically.</Alert><Alert tone="danger" title="Payment required" action={<Button size="sm" variant="danger">Resolve</Button>}>Paid mutations are currently paused.</Alert>{toastVisible && <Toast title="Policy saved" onDismiss={() => setToastVisible(false)}>Human merge remains required.</Toast>}</div></article>
    </div>
    <div className="react-grid react-grid-two">
      <article className="react-sample"><h4>Data table</h4><DataTable columns={[{ key: "work", header: "Work order", render: (row) => <><strong>{row.title}</strong><br /><span className="react-mono">{row.id}</span></> }, { key: "owner", header: "Owner", render: (row) => row.owner }, { key: "state", header: "Evidence", render: (row) => <StatusBadge tone={row.stage}>{row.stage === "unknown" ? "UNKNOWN" : row.stage === "review" ? "Reviewing" : "Verified"}</StatusBadge> }, { key: "updated", header: "Updated", render: (row) => <span className="react-mono">{row.updated}</span> }]} rows={work} selected={selected} onSelect={(id, checked) => setSelected((current) => { const next = new Set(current); checked ? next.add(id) : next.delete(id); return next; })} /></article>
      <article className="react-sample"><h4>Menu, sheet &amp; timeline</h4><div className="react-split"><Menu items={[{ label: "Copy work-order ID", shortcut: "⌘ C" }, { label: "Open evidence" }, { label: "Cancel work order", danger: true }]} /><Sheet title="Evidence needs review" action={<Button variant="primary" size="sm">Review evidence</Button>}><p className="react-muted">Checkout authorization has no confirmed verdict.</p></Sheet></div><Timeline items={[{ title: "Human approval requested", meta: "Policy: human-merge-required · 2m ago", tone: "review" }, { title: "tb check completed", meta: "Verdict: UNKNOWN · 4m ago", tone: "unknown" }, { title: "Evidence recorded", meta: "Run r_01J8RX · 6m ago", tone: "info" }]} /></article>
    </div>
    <div className="react-grid react-grid-three"><MetricCard label="Verification pass rate" value="96.4%" trend="+4.2 pts" tone="verified" /><MetricCard label="Median cycle time" value="2.8d" trend="↓ 18%" tone="verified" /><EmptyState title="No work orders yet" action={<Button variant="primary" size="sm">Create work order</Button>}>Create a work order or connect an intake source.</EmptyState></div>
    <Dialog title="Disconnect repository?" open={dialogOpen} onClose={() => setDialogOpen(false)} footer={<><Button onClick={() => setDialogOpen(false)}>Cancel</Button><Button variant="danger" onClick={() => setDialogOpen(false)}>Disconnect</Button></>}>New work will stop. Existing evidence and work orders remain available.</Dialog>
  </div>;
}

const mount = document.querySelector("#react-component-library");
if (mount) createRoot(mount).render(<Preview />);
