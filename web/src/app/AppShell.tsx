import {
  Activity,
  Boxes,
  Globe,
  KeyRound,
  LayoutDashboard,
  Link2,
  LogOut,
  Moon,
  PhoneCall,
  ScrollText,
  Server,
  Settings,
  SquareTerminal,
  Sun,
  SunMoon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useMediaQuery } from './useMediaQuery';
import { useTheme } from './theme';
import { usePlane, type Plane } from './plane';
import { useI18n } from '../i18n';
import { clearKey } from '../api/client';
import { Sheet } from '../components/ui/Sheet';

interface NavItem {
  to: string;
  key: string;
  icon: typeof Server;
  end?: boolean;
  /** Planes the item belongs to; undefined means every plane. */
  planes?: Plane[];
}

/**
 * Sidebar sections. The "plane" section holds per-plane resources (Servers vs
 * CLIs) and is the only one that changes when the switch flips; "shared" and
 * "system" stay put on both planes.
 */
const navGroups: { titleKey: string; items: NavItem[] }[] = [
  {
    titleKey: 'nav.section.plane',
    items: [
      { to: '/servers', key: 'nav.servers', icon: Server, planes: ['mcp'] },
      { to: '/clis', key: 'nav.clis', icon: SquareTerminal, planes: ['cli'] },
    ],
  },
  {
    titleKey: 'nav.section.shared',
    items: [
      { to: '/calls', key: 'nav.calls', icon: PhoneCall },
      { to: '/endpoints', key: 'nav.endpoints', icon: Globe },
      { to: '/market', key: 'nav.market', icon: Boxes },
      { to: '/credentials', key: 'nav.credentials', icon: KeyRound },
    ],
  },
  {
    titleKey: 'nav.section.mcp',
    items: [{ to: '/access-keys', key: 'nav.accessKeys', icon: Link2, planes: ['mcp'] }],
  },
  {
    titleKey: 'nav.section.system',
    items: [
      { to: '/diagnostics', key: 'nav.diagnostics', icon: Activity },
      { to: '/events', key: 'nav.events', icon: ScrollText },
      { to: '/settings', key: 'nav.settings', icon: Settings },
    ],
  },
];

const desktopNav: NavItem[] = [
  { to: '/', key: 'nav.overview', icon: LayoutDashboard, end: true },
  ...navGroups.flatMap((group) => group.items),
];

/** Pages that exist per plane; switching flips between the pair. */
const PLANE_REDIRECTS: Record<Plane, Record<string, string>> = {
  mcp: { '/clis': '/servers' },
  cli: { '/servers': '/clis' },
};

function navFor(plane: Plane): NavItem[] {
  return desktopNav.filter((item) => item.planes === undefined || item.planes.includes(plane));
}

/** Mobile bottom bar shows the first three nav entries of the active plane. */
function mobileTabsFor(plane: Plane): NavItem[] {
  return navFor(plane).slice(0, 3);
}

function mobileMoreGroupsFor(plane: Plane): { titleKey: string; items: NavItem[] }[] {
  const tabs = mobileTabsFor(plane);
  return navGroups
    .map((group) => ({
      titleKey: group.titleKey,
      items: group.items.filter(
        (item) =>
          (item.planes === undefined || item.planes.includes(plane)) &&
          !tabs.some((tab) => tab.to === item.to),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : SunMoon;
  return (
    <button
      type="button"
      onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'auto' : 'dark')}
      className="flex size-8 items-center justify-center text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
      aria-label="theme"
    >
      <Icon className="size-4" />
    </button>
  );
}

function LangSwitch() {
  const { locale, setLocale } = useI18n();
  return (
    <button
      type="button"
      onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
      className="flex h-8 items-center px-2 text-[13px] font-medium text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
    >
      {locale === 'zh' ? 'EN' : '中'}
    </button>
  );
}

function PlaneSwitch() {
  const { t } = useI18n();
  const { plane, setPlane } = usePlane();
  const options: { value: Plane; label: string; icon: typeof Server }[] = [
    { value: 'mcp', label: 'MCP', icon: Server },
    { value: 'cli', label: 'CLI', icon: SquareTerminal },
  ];
  return (
    <div
      role="radiogroup"
      aria-label={t('nav.plane')}
      className="flex h-8 items-center gap-0.5 bg-surface-2 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={plane === option.value}
          onClick={() => setPlane(option.value)}
          className={`flex h-7 flex-1 items-center justify-center gap-1.5 px-2.5 text-xs font-medium transition-colors ${
            plane === option.value ? 'bg-surface text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
          }`}
        >
          <option.icon className="size-3.5" />
          {option.label}
        </button>
      ))}
    </div>
  );
}

function LogoutButton() {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        clearKey();
        navigate('/login');
      }}
      className="flex h-8 items-center gap-1.5 px-2 text-[13px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-danger"
    >
      <LogOut className="size-3.5" />
      {t('logout')}
    </button>
  );
}

function Brand() {
  const { t } = useI18n();
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 px-4">
      <span className="size-2 bg-accent" />
      <span className="text-[15px] font-semibold tracking-[-0.01em]">{t('app.title')}</span>
    </div>
  );
}

function SideNav({ plane }: { plane: Plane }) {
  const { t } = useI18n();
  const overview: NavItem = { to: '/', key: 'nav.overview', icon: LayoutDashboard, end: true };
  const renderLink = (item: NavItem) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        `flex h-9 items-center gap-2.5 px-3 text-sm transition-colors ${
          isActive ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2/60 hover:text-ink'
        }`
      }
    >
      <item.icon className="size-4 shrink-0" />
      {t(item.key)}
    </NavLink>
  );
  return (
    <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2">
      {renderLink(overview)}
      {navGroups.map((group) => {
        const items = group.items.filter(
          (item) => item.planes === undefined || item.planes.includes(plane),
        );
        if (items.length === 0) return null;
        return (
          <div key={group.titleKey} className="mt-3 flex flex-col gap-0.5">
            <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3/70">
              {t(group.titleKey)}
            </div>
            {items.map(renderLink)}
          </div>
        );
      })}
    </nav>
  );
}

function pageKeyFor(path: string): string {
  if (path === '/') return 'nav.overview';
  if (path.startsWith('/servers')) return 'nav.servers';
  if (path.startsWith('/clis')) return 'nav.clis';
  if (path.startsWith('/credentials')) return 'nav.credentials';
  if (path.startsWith('/access-keys')) return 'nav.accessKeys';
  if (path.startsWith('/market')) return 'nav.market';
  if (path.startsWith('/endpoints')) return 'nav.endpoints';
  if (path.startsWith('/diagnostics')) return 'nav.diagnostics';
  if (path.startsWith('/events')) return 'nav.events';
  if (path.startsWith('/calls')) return 'nav.calls';
  if (path.startsWith('/settings')) return 'nav.settings';
  return 'nav.overview';
}

export function AppShell() {
  const { t } = useI18n();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const location = useLocation();
  const navigate = useNavigate();
  const { plane } = usePlane();
  const [moreOpen, setMoreOpen] = useState(false);
  const pageKey = useMemo(() => pageKeyFor(location.pathname), [location.pathname]);

  // A plane switch must not strand the user on the other plane's pages.
  useEffect(() => {
    const redirect =
      PLANE_REDIRECTS[plane][location.pathname] ??
      (location.pathname.startsWith('/servers/') && plane === 'cli' ? '/clis' : undefined) ??
      (location.pathname.startsWith('/servers') && plane === 'cli' ? '/clis' : undefined);
    if (redirect !== undefined) navigate(redirect, { replace: true });
  }, [plane, location.pathname, navigate]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      {!isMobile && (
        <aside className="glass hidden w-[200px] shrink-0 flex-col md:flex">
          <Brand />
          <div className="px-3 pb-1">
            <PlaneSwitch />
          </div>
          <SideNav plane={plane} />
          <div className="flex items-center gap-1 border-t border-ink-3/10 p-2">
            <ThemeSwitch />
            <LangSwitch />
            <div className="flex-1" />
            <LogoutButton />
          </div>
        </aside>
      )}

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="glass flex h-12 shrink-0 items-center gap-2 px-4 md:hidden">
          <span className="size-2 bg-accent" />
          <span className="flex-1 text-[15px] font-semibold tracking-[-0.01em]">{t(pageKey)}</span>
          <ThemeSwitch />
          <LangSwitch />
        </header>

        {isMobile && (
          <div className="px-4 pb-1">
            <PlaneSwitch />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-4 pb-24 pt-5 md:px-8 md:py-6">
            <Outlet />
          </div>
        </div>
      </main>

      {isMobile && (
        <nav className="glass-strong fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-ink-3/10 pb-[env(safe-area-inset-bottom)]">
          {mobileTabsFor(plane).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${
                  isActive ? 'text-accent' : 'text-ink-3'
                }`
              }
            >
              <item.icon className="size-5" />
              {t(item.key)}
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] text-ink-3"
          >
            <Settings className="size-5" />
            {t('nav.more')}
          </button>
        </nav>
      )}

      <Sheet open={moreOpen} onOpenChange={setMoreOpen} title={t('nav.more')} side="bottom">
        <div className="flex flex-col gap-0.5 pb-[env(safe-area-inset-bottom)]">
          {mobileMoreGroupsFor(plane).map((group) => (
            <div key={group.titleKey} className="mt-3 flex flex-col gap-0.5 first:mt-0">
              <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3/70">
                {t(group.titleKey)}
              </div>
              {group.items.map((item) => (
                <button
                  key={item.to}
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    navigate(item.to);
                  }}
                  className="flex h-11 items-center gap-3 px-2 text-sm text-ink-2"
                >
                  <item.icon className="size-4" />
                  {t(item.key)}
                </button>
              ))}
            </div>
          ))}
        </div>
      </Sheet>
    </div>
  );
}
