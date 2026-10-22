// Dashboard (PLAN §32, features 47–53): configurable widgets, layout saved per profile.
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, LayoutGrid } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useOpsMutation, useOpsQuery, useSnapshot } from '../../features/analytics/hooks.ts';
import type { Snapshot } from '../../features/analytics/snapshot.ts';
import { Button, Card, ErrorText, Loading, Page } from '../../features/analytics/ui.tsx';
import {
  type DashboardLayout,
  moveWidget,
  normalizeLayout,
  toggleWidget,
  WIDGETS,
  type WidgetId,
} from '../../features/dashboard/layout.ts';
import { QuickActions } from '../../features/dashboard/QuickActions.tsx';
import { WidgetBody } from '../../features/dashboard/Widgets.tsx';
import { useNotificationGenerator } from '../../features/notifications/useNotifications.ts';
import { useT } from '../../lib/i18n.ts';

const meta = new Map(WIDGETS.map((w) => [w.id, w]));

export default function DashboardPage() {
  const t = useT();
  useNotificationGenerator();
  const snap = useSnapshot();
  const saved = useOpsQuery(['dashboard-layout'], (ops) => ops.getDashboardLayout());
  const save = useOpsMutation((ops, l: DashboardLayout) => ops.setDashboardLayout(l));
  const [layout, setLayout] = useState<DashboardLayout | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (saved.isSuccess && !layout) setLayout(normalizeLayout(saved.data));
  }, [saved.isSuccess, saved.data, layout]);

  const update = (l: DashboardLayout) => {
    setLayout(l);
    save.mutate(l);
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!layout || !e.over || e.active.id === e.over.id) return;
    update(
      moveWidget(layout, e.active.id as WidgetId, layout.order.indexOf(e.over.id as WidgetId)),
    );
  };

  if (snap.error)
    return (
      <Page title={t('nav.dashboard', 'Dashboard')}>
        <ErrorText error={snap.error} />
      </Page>
    );
  if (!snap.data || !layout) return <Loading />;
  const visible = editing ? layout.order : layout.order.filter((id) => !layout.hidden.includes(id));
  return (
    <Page
      title={t('nav.dashboard', 'Dashboard')}
      actions={
        <>
          <QuickActions snap={snap.data} />
          <Button aria-pressed={editing} onClick={() => setEditing(!editing)}>
            <LayoutGrid aria-hidden className="size-4" />
            {editing
              ? t('dashboard.page.done', 'Done')
              : t('dashboard.page.customize', 'Customize')}
          </Button>
        </>
      }
    >
      {editing && (
        <p className="text-sm text-muted">
          {t(
            'dashboard.page.dragWidgetsByThe',
            'Drag widgets by the handle (or focus the handle and use Space + arrow keys), or use the arrow buttons. Hidden widgets stay listed here while customizing. The layout is saved for this profile.',
          )}
        </p>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={visible} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {visible.map((id) => (
              <SortableWidget
                key={id}
                id={id}
                snap={snap.data}
                editing={editing}
                hidden={layout.hidden.includes(id)}
                onToggle={() => update(toggleWidget(layout, id))}
                onMove={(d) => update(moveWidget(layout, id, layout.order.indexOf(id) + d))}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </Page>
  );
}

function SortableWidget({
  id,
  snap,
  editing,
  hidden,
  onToggle,
  onMove,
}: {
  id: WidgetId;
  snap: Snapshot;
  editing: boolean;
  hidden: boolean;
  onToggle: () => void;
  onMove: (delta: number) => void;
}) {
  const t = useT();
  const s = useSortable({ id, disabled: !editing });
  const w = meta.get(id);
  const wide = w?.wide ? 'md:col-span-2' : '';
  return (
    <div
      ref={s.setNodeRef}
      style={{ transform: CSS.Transform.toString(s.transform), transition: s.transition }}
      className={`${wide} ${hidden ? 'opacity-50' : ''} ${s.isDragging ? 'z-10' : ''}`}
    >
      <Card
        className="h-full"
        title={w?.title}
        actions={
          editing && (
            <>
              <Button
                variant="ghost"
                aria-label={t('dashboard.page.moveEarlier', 'Move {{title}} earlier', {
                  title: w?.title ?? '',
                })}
                onClick={() => onMove(-1)}
              >
                <ArrowUp aria-hidden className="size-4" />
              </Button>
              <Button
                variant="ghost"
                aria-label={t('dashboard.page.moveLater', 'Move {{title}} later', {
                  title: w?.title ?? '',
                })}
                onClick={() => onMove(1)}
              >
                <ArrowDown aria-hidden className="size-4" />
              </Button>
              <Button
                variant="ghost"
                aria-label={hidden ? `Show ${w?.title}` : `Hide ${w?.title}`}
                aria-pressed={!hidden}
                onClick={onToggle}
              >
                {hidden ? (
                  <EyeOff aria-hidden className="size-4" />
                ) : (
                  <Eye aria-hidden className="size-4" />
                )}
              </Button>
              <button
                type="button"
                className="cursor-grab rounded p-1 hover:bg-surface-2"
                aria-label={t('dashboard.page.drag', 'Drag {{title}}', { title: w?.title ?? '' })}
                {...s.attributes}
                {...s.listeners}
              >
                <GripVertical aria-hidden className="size-4" />
              </button>
            </>
          )
        }
      >
        {hidden ? (
          <p className="text-sm text-muted">{t('dashboard.page.hidden', 'Hidden')}</p>
        ) : (
          <WidgetBody id={id} snap={snap} />
        )}
      </Card>
    </div>
  );
}
