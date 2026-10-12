import { useState } from "react";
import { DndContext, DragOverlay, MouseSensor, TouchSensor, closestCenter, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus } from "lucide-react";
import type { Variable } from "@yumina/engine";
import type { StatusCategory, StatusConfig, StatusField } from "../../../../../../interfaces/vn/status-data";

const displays: Record<StatusField["format"], string> = { value: "Text or number", bar: "Resource bar", segments: "Attribute segments", badges: "Effect badges", inventory: "Inventory slots", gauge: "Icon gauge", resource: "Layered resource bar", chips: "Status chips", pips: "Relationship pips", "xp-ring": "XP ring", scene: "Scene badge" };

function VariableTile({ variable, disabled, onAdd }: { variable: Variable; disabled: boolean; onAdd: () => void }) {
  const { setNodeRef, setActivatorNodeRef, isDragging, attributes, listeners } = useDraggable({ id: `variable:${variable.id}`, disabled });
  return <div ref={setNodeRef} className={`flex min-w-0 items-center rounded-lg border border-border bg-background ${isDragging ? "opacity-40" : ""}`}>
    <button ref={setActivatorNodeRef} type="button" aria-label={`Drag ${variable.name} to status`} disabled={disabled} {...attributes} {...listeners} className="flex h-11 w-9 shrink-0 touch-none items-center justify-center text-muted-foreground focus-visible:outline-2 focus-visible:outline-primary"><GripVertical size={15} /></button>
    <span className="min-w-0 flex-1 truncate py-2 text-xs">{variable.name}</span>
    <button type="button" aria-label={`Add ${variable.name} to status`} disabled={disabled} onClick={onAdd} className="flex h-11 w-10 shrink-0 items-center justify-center text-primary hover:bg-primary/10"><Plus size={15} /></button>
  </div>;
}

function CategoryTab({ group, active, disabled, onClick }: { group: StatusCategory; active: boolean; disabled: boolean; onClick: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `category:${group.id}`, disabled });
  return <button ref={setNodeRef} type="button" onClick={onClick} aria-pressed={active} className={`min-h-11 max-w-full break-words rounded-lg border px-3 py-2 text-xs ${isOver ? "border-primary bg-primary/20" : active ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"}`}>{group.label}</button>;
}

function FieldTile({ field, active, disabled, onSelect, onMove }: { field: StatusField; active: boolean; disabled: boolean; onSelect: () => void; onMove: (direction: number) => void }) {
  const { setNodeRef, setActivatorNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({ id: `field:${field.id}`, disabled });
  const meter = ["bar", "resource", "segments", "pips", "gauge", "xp-ring"].includes(field.format);
  return <div ref={setNodeRef} data-status-field={field.id} style={{ transform: CSS.Transform.toString(transform), transition }} className={`flex min-w-0 items-stretch rounded-lg border bg-card ${isDragging ? "z-10 opacity-40" : ""} ${active ? "border-primary/60" : "border-border"}`}>
    <button ref={setActivatorNodeRef} type="button" aria-label={`Move ${field.label}`} disabled={disabled} {...attributes} {...listeners} onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); onMove(event.key === "ArrowUp" ? -1 : 1); } }} className="flex w-11 shrink-0 touch-none items-center justify-center rounded-l-lg text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"><GripVertical size={17} /></button>
    <button type="button" aria-pressed={active} onClick={onSelect} className="min-w-0 flex-1 rounded-r-lg px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-primary">
      <span className="flex min-w-0 items-center gap-2 text-sm"><span style={{ color: field.color }} aria-hidden="true">{field.icon || "✦"}</span><span className="min-w-0 flex-1 truncate">{field.label}</span></span>
      {meter && <span aria-hidden="true" className="mt-2 block h-1.5 overflow-hidden rounded bg-muted"><span className="block h-full w-3/5 rounded" style={{ background: field.color }} /></span>}
      <span className="mt-2 block text-[11px] text-muted-foreground">{displays[field.format]}</span>
    </button>
  </div>;
}

function FieldCanvas({ group, children, disabled }: { group: string; children: React.ReactNode; disabled: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `canvas:${group}`, disabled });
  return <div ref={setNodeRef} aria-label="Status arrangement" className={`min-h-24 space-y-2 rounded-xl border border-dashed p-3 ${isOver ? "border-primary bg-primary/5" : "border-border bg-background/40"}`}>{children}</div>;
}

export function StatusBuilder({ config, variables, selectedId, disabled, onSelect, onDrop }: {
  config: StatusConfig; variables: Variable[]; selectedId?: string; disabled: boolean;
  onSelect: (id: string) => void; onDrop: (active: string, over: string) => void;
}) {
  const [category, setCategory] = useState(config.fields.find(field => field.id === selectedId)?.group ?? config.groups[0]!.id);
  const [search, setSearch] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 5 } }));
  const group = config.groups.some(item => item.id === category) ? category : config.groups[0]!.id;
  const fields = config.fields.filter(field => field.group === group);
  const palette = variables.filter(variable => !variable.internal && variable.enabled !== false && variable.name.toLowerCase().includes(search.toLowerCase()));
  const dragLabel = dragging?.startsWith("field:") ? config.fields.find(field => field.id === dragging.slice(6))?.label : variables.find(variable => variable.id === dragging?.slice(9))?.name;
  function drop(event: DragEndEvent) {
    setDragging(null);
    if (disabled || !event.over) return;
    const active = String(event.active.id), over = String(event.over.id).replace(/^canvas:/, "category:");
    onDrop(active, over);
    const destination = over.startsWith("category:") ? over.slice(9) : config.fields.find(field => field.id === over.slice(6))?.group;
    if (destination) setCategory(destination);
    setAnnouncement("Status arrangement updated.");
  }
  return <DndContext sensors={sensors} accessibility={{ screenReaderInstructions: { draggable: "For fields, focus a handle and use Up or Down to reorder. Use the field category control to move between categories. Use the Add button to add a variable." } }} collisionDetection={args => {
    const hits = pointerWithin(args);
    const targets = hits.filter(hit => hit.id !== args.active.id && !String(hit.id).startsWith("canvas:"));
    if (targets.length) return targets;
    if (hits.some(hit => String(hit.id).startsWith("canvas:"))) {
      const fields = args.droppableContainers.filter(item => item.id !== args.active.id && String(item.id).startsWith("field:"));
      return fields.length ? closestCenter({ ...args, droppableContainers: fields }) : hits;
    }
    return [];
  }} onDragStart={event => setDragging(String(event.active.id))} onDragCancel={() => setDragging(null)} onDragEnd={drop}>
    <section className="space-y-3" aria-label="Add status fields">
      <div><h3 className="text-sm font-medium">Add fields</h3><p className="mt-1 text-xs text-muted-foreground">Drag a variable into your screen, or click +.</p></div>
      <input type="search" aria-label="Find a status variable" placeholder="Find a variable…" value={search} onChange={event => setSearch(event.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs focus:border-primary focus:outline-none" />
      <div className="grid max-h-44 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
        {palette.map(variable => <VariableTile key={variable.id} variable={variable} disabled={disabled} onAdd={() => onDrop(`variable:${variable.id}`, `category:${group}`)} />)}
        {!palette.length && <p className="py-2 text-xs text-muted-foreground">No matching variables.</p>}
      </div>
    </section>
    <section className="space-y-3" aria-label="Arrange status fields">
      <div><h3 className="text-sm font-medium">Arrange your screen</h3><p className="mt-1 text-xs text-muted-foreground">Drag the handles to reorder, or focus a handle and use the arrow keys. Drop onto a category to move a field. Click a field to customize it.</p></div>
      <div className="flex flex-wrap gap-2" aria-label="Builder categories">{config.groups.map(item => <CategoryTab key={item.id} group={item} active={group === item.id} disabled={disabled} onClick={() => { setCategory(item.id); onSelect(config.fields.find(field => field.group === item.id)?.id ?? "__none"); }} />)}</div>
      <SortableContext items={fields.map(field => `field:${field.id}`)} strategy={verticalListSortingStrategy}>
        <FieldCanvas group={group} disabled={disabled}>
          {fields.map(field => <FieldTile key={field.id} field={field} active={selectedId === field.id} disabled={disabled} onSelect={() => onSelect(field.id)} onMove={direction => { const next = fields[fields.indexOf(field) + direction]; if (next && !disabled) { onDrop(`field:${field.id}`, `field:${next.id}`); setAnnouncement("Status arrangement updated."); } }} />)}
          {!fields.length && <p className="px-2 py-6 text-center text-xs text-muted-foreground">Drop a variable here to add your first field.</p>}
        </FieldCanvas>
      </SortableContext>
      <p role="status" className="sr-only">{announcement}</p>
    </section>
    <DragOverlay>{dragging && <div className="max-w-64 truncate rounded-lg border border-primary bg-card px-4 py-3 text-sm shadow-lg">{dragLabel}</div>}</DragOverlay>
  </DndContext>;
}
