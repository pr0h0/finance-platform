// Route registry: every section of PLAN §31. The sidebar, mobile bottom navigation and command
// palette are generated from this list. Section pages live at src/pages/<id>/index.tsx (default
// export a component); shell-owned screens live in their own directories.
import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  CalendarClock,
  Coins,
  FileText,
  Home,
  type LucideIcon,
  MonitorSmartphone,
  PiggyBank,
  PlugZap,
  RefreshCw,
  Repeat,
  Settings,
  Shield,
  Target,
  Upload,
  Users,
  Wallet,
  WandSparkles,
} from 'lucide-react';
import { type ComponentType, lazy } from 'react';
import { useT } from '../lib/i18n.ts';

type Page = { default: ComponentType };
const pages = import.meta.glob<Page>('../pages/*/index.tsx');

function Missing() {
  const t = useT();
  return (
    <p className="text-sm text-muted" role="status">
      {t('app.routes.thisSectionIsNot', 'This section is not available in this build.')}
    </p>
  );
}

const page = (id: string) =>
  lazy(() => pages[`../pages/${id}/index.tsx`]?.() ?? Promise.resolve({ default: Missing }));

export interface Section {
  id: string;
  path: string;
  /** i18n key and English label */
  labelKey: string;
  label: string;
  icon: LucideIcon;
  /** main = primary sidebar group; context = secondary group */
  group: 'main' | 'context';
  /** shown in the mobile bottom bar */
  mobile?: boolean;
  /** only in connected mode / only for server admins */
  requires?: 'remote' | 'admin';
  Component: ComponentType;
}

export const SECTIONS: Section[] = [
  {
    id: 'dashboard',
    path: '/',
    labelKey: 'nav.dashboard',
    label: 'Dashboard',
    icon: Home,
    group: 'main',
    mobile: true,
    Component: page('dashboard'),
  },
  {
    id: 'transactions',
    path: '/transactions',
    labelKey: 'nav.transactions',
    label: 'Transactions',
    icon: ArrowLeftRight,
    group: 'main',
    mobile: true,
    Component: page('transactions'),
  },
  {
    id: 'planning',
    path: '/planning',
    labelKey: 'nav.planning',
    label: 'Planning',
    icon: CalendarClock,
    group: 'main',
    mobile: true,
    Component: page('planning'),
  },
  {
    id: 'budgets',
    path: '/budgets',
    labelKey: 'nav.budgets',
    label: 'Budgets',
    icon: PiggyBank,
    group: 'main',
    Component: page('budgets'),
  },
  {
    id: 'analytics',
    path: '/analytics',
    labelKey: 'nav.analytics',
    label: 'Analytics',
    icon: BarChart3,
    group: 'main',
    mobile: true,
    Component: page('analytics'),
  },
  {
    id: 'accounts',
    path: '/accounts',
    labelKey: 'nav.accounts',
    label: 'Accounts',
    icon: Wallet,
    group: 'main',
    Component: page('accounts'),
  },
  {
    id: 'goals',
    path: '/goals',
    labelKey: 'nav.goals',
    label: 'Savings goals',
    icon: Target,
    group: 'main',
    Component: page('goals'),
  },
  {
    id: 'subscriptions',
    path: '/subscriptions',
    labelKey: 'nav.subscriptions',
    label: 'Subscriptions',
    icon: Repeat,
    group: 'main',
    Component: page('subscriptions'),
  },
  {
    id: 'import',
    path: '/import',
    labelKey: 'nav.imports',
    label: 'Import center',
    icon: Upload,
    group: 'main',
    Component: page('import'),
  },
  {
    id: 'rules',
    path: '/rules',
    labelKey: 'nav.rules',
    label: 'Automation rules',
    icon: WandSparkles,
    group: 'main',
    Component: page('rules'),
  },
  {
    id: 'reports',
    path: '/reports',
    labelKey: 'nav.reports',
    label: 'Reports',
    icon: FileText,
    group: 'main',
    Component: page('reports'),
  },
  {
    id: 'converter',
    path: '/converter',
    labelKey: 'nav.converter',
    label: 'Currency converter',
    icon: Coins,
    group: 'main',
    Component: page('converter'),
  },
  {
    id: 'settings',
    path: '/settings',
    labelKey: 'nav.settings',
    label: 'Settings',
    icon: Settings,
    group: 'main',
    Component: lazy(() => import('../settings/SettingsPage.tsx')),
  },
  {
    id: 'notifications',
    path: '/notifications',
    labelKey: 'nav.notifications',
    label: 'Notifications',
    icon: Bell,
    group: 'context',
    Component: page('notifications'),
  },
  {
    id: 'sync',
    path: '/sync',
    labelKey: 'nav.sync',
    label: 'Sync status',
    icon: RefreshCw,
    group: 'context',
    Component: lazy(() => import('../sync/SyncPage.tsx')),
  },
  {
    id: 'household',
    path: '/household',
    labelKey: 'nav.household',
    label: 'Household',
    icon: Users,
    group: 'context',
    requires: 'remote',
    Component: lazy(() => import('../household/HouseholdPage.tsx')),
  },
  {
    id: 'devices',
    path: '/devices',
    labelKey: 'nav.devices',
    label: 'Devices',
    icon: MonitorSmartphone,
    group: 'context',
    requires: 'remote',
    Component: lazy(() => import('../devices/DevicesPage.tsx')),
  },
  {
    id: 'mcp',
    path: '/agents', // not /mcp: that prefix is the MCP protocol endpoint (gateway + vite proxy)
    labelKey: 'nav.mcp',
    label: 'MCP connections',
    icon: PlugZap,
    group: 'context',
    requires: 'remote',
    Component: lazy(() => import('../mcp/McpPage.tsx')),
  },
  {
    id: 'admin',
    path: '/admin',
    labelKey: 'nav.admin',
    label: 'Administration',
    icon: Shield,
    group: 'context',
    requires: 'admin',
    Component: lazy(() => import('../admin/AdminPage.tsx')),
  },
];

export function visibleSections(mode: 'local' | 'remote' | null, isAdmin: boolean): Section[] {
  return SECTIONS.filter(
    (s) =>
      !s.requires || (s.requires === 'remote' ? mode === 'remote' : mode === 'remote' && isAdmin),
  );
}
