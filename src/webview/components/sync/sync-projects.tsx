import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useId, useState } from "react";
import { middleTruncate } from "../../../client-core/sync/sync-format";
import type { SyncProjectView, WebviewToHost } from "../../../protocol/messages";

type Choice = Extract<WebviewToHost, { t: "sync-project" }>["choice"];
const itemsFor = (linked: boolean) => [
  { value: "shared", label: "Shared" },
  { value: "own", label: "Keep separate" },
  { value: "link", label: linked ? "Linked" : "Link to project…" },
];

function LinkForm({ project, onLink, onCancel }: { project: SyncProjectView; onLink: (id: string) => void; onCancel: () => void }) {
  const id = useId();
  const [value, setValue] = useState("");
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => { e.preventDefault(); if (value.trim()) { onLink(value.trim()); } }}
    >
      <label htmlFor={id} className="sr-only">Project to link {project.name} to</label>
      <Input id={id} autoFocus value={value} placeholder="github.com/owner/repo" spellCheck={false} onChange={(e) => setValue(e.target.value)} className="h-7 min-w-0 flex-1 text-xs" />
      <Button type="button" size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
      <Button type="submit" size="xs" disabled={!value.trim()}>Link</Button>
    </form>
  );
}

function ProjectRow({ project, onChoose }: { project: SyncProjectView; onChoose: (choice: Choice) => void }) {
  const [linking, setLinking] = useState(false);
  const selected = project.choice === "linked" ? "link" : project.choice === "none" ? null : project.choice;
  const detail = project.choice === "none" ? "no remote · not shared" : project.projectId ?? "";
  return (
    <li className="flex min-w-0 flex-col gap-1.5 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm" title={project.path}>{project.name}</span>
          <span className="truncate text-xs text-muted-foreground" title={project.projectId}>{middleTruncate(detail, 40)}</span>
        </div>
        {project.choice === "none" ? (
          <Button size="xs" variant="ghost" onClick={() => setLinking(true)}>Link…</Button>
        ) : (
          <Select
            items={itemsFor(project.choice === "linked")}
            value={selected}
            onValueChange={(value) => {
              if (value === "link") { setLinking(true); return; }
              if (value === "shared" || value === "own") { onChoose(value); }
            }}
          >
            <SelectTrigger size="sm" aria-label={`Memory for ${project.name}`} className="max-w-32 shrink-0 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {itemsFor(project.choice === "linked").map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>
      {linking && <LinkForm project={project} onCancel={() => setLinking(false)} onLink={(id) => { setLinking(false); onChoose({ link: id }); }} />}
    </li>
  );
}

/** Whether each repo open here shares its memory with the other clones and worktrees of its project. */
export function SyncProjects({ projects, onChoose }: { projects: SyncProjectView[]; onChoose: (path: string, choice: Choice) => void }) {
  if (projects.length === 0) {
    return <p className="py-1.5 text-xs text-muted-foreground">No repository is open in this window.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border">
      {projects.map((p) => <ProjectRow key={p.path} project={p} onChoose={(choice) => onChoose(p.path, choice)} />)}
    </ul>
  );
}
