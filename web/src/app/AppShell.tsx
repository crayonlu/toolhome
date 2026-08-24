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
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useMediaQuery } from './useMediaQuery'
import { useTheme } from './theme'
import { useI18n } from '../i18n'
import { clearKey } from '../api/client'
import { Sheet } from '../components/ui/Sheet'

interface NavItem {
  to: string
  key: string
  icon: typeof Server
  end?: boolean
}

const desktopNav: NavItem[] = [
  { to: '/', key: 'nav.overview', icon: LayoutDashboard, end: true },
  { to: '/servers', key: 'nav.servers', icon: Server },
  { to: '/clis', key: 'nav.clis', icon: SquareTerminal },
  { to: '/calls', key: 'nav.calls', icon: PhoneCall },
  { to: '/credentials', key: 'nav.credentials', icon: KeyRound },
  { to: '/access-keys', key: 'nav.accessKeys', icon: Link2 },
  { to: '/endpoints', key: 'nav.endpoints', icon: Globe },
  { to: '/market', key: 'nav.market', icon: Boxes },
  { to: '/diagnostics', key: 'nav.diagnostics', icon: Activity },
  { to: '/events', key: 'nav.events', icon: ScrollText },
  { to: '/settings', key: 'nav.settings', icon: Settings },
]

const mobileTabs: NavItem[] = desktopNav.filter((item) =>
  ['/', '/servers', '/credentials'].includes(item.to),
)
const mobileMore: NavItem[] = desktopNav.filter(
  (item) => !mobileTabs.some((tab) => tab.to === item.to),
)

function ThemeSwitch() {
  const { theme, setTheme } = useTheme()
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : SunMoon
  return (
    <button
      type="button"
      onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'auto' : 'dark')}
      className="flex size-8 items-center justify-center text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
      aria-label="theme"
    >
      <Icon className="size-4" />
    </button>
  )
}

function LangSwitch() {
  const { locale, setLocale } = useI18n()
  return (
    <button
      type="button"
      onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
      className="flex h-8 items-center px-2 text-[13px] font-medium text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
    >
      {locale === 'zh' ? 'EN' : '中'}
    </button>
  )
}

function LogoutButton() {
  const { t } = useI18n()
  const navigate = useNavigate()
  return (
    <button
      type="button"
      onClick={() => {
        clearKey()
        navigate('/login')
      }}
      className="flex h-8 items-center gap-1.5 px-2 text-[13px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-danger"
    >
      <LogOut className="size-3.5" />
      {t('logout')}
    </button>
  )
}

function Brand() {
  const { t } = useI18n()
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 px-4">
      <span className="size-2 bg-accent" />
      <span className="text-[15px] font-semibold tracking-[-0.01em]">{t('app.title')}</span>
    </div>
  )
}

function SideNav() {
  const { t } = useI18n()
  return (
    <nav className="flex flex-1 flex-col gap-0.5 px-2">
      {desktopNav.map((item) => (
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
      ))}
    </nav>
  )
}

function pageKeyFor(path: string): string {
  if (path === '/') return 'nav.overview'
  if (path.startsWith('/servers')) return 'nav.servers'
  if (path.startsWith('/clis')) return 'nav.clis'
  if (path.startsWith('/credentials')) return 'nav.credentials'
  if (path.startsWith('/access-keys')) return 'nav.accessKeys'
  if (path.startsWith('/market')) return 'nav.market'
  if (path.startsWith('/endpoints')) return 'nav.endpoints'
  if (path.startsWith('/diagnostics')) return 'nav.diagnostics'
  if (path.startsWith('/events')) return 'nav.events'
  if (path.startsWith('/calls')) return 'nav.calls'
  if (path.startsWith('/settings')) return 'nav.settings'
  return 'nav.overview'
}

export function AppShell() {
  const { t } = useI18n()
  const isMobile = useMediaQuery('(max-width: 767px)')
  const location = useLocation()
  const navigate = useNavigate()
  const [moreOpen, setMoreOpen] = useState(false)
  const pageKey = useMemo(() => pageKeyFor(location.pathname), [location.pathname])

  return (
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      {!isMobile && (
        <aside className="glass hidden w-[200px] shrink-0 flex-col md:flex">
          <Brand />
          <SideNav />
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
          <span className="flex-1 text-[15px] font-semibold tracking-[-0.01em]">
            {t(pageKey)}
          </span>
          <ThemeSwitch />
          <LangSwitch />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-8 md:py-6">
            <Outlet />
          </div>
        </div>
      </main>

      {isMobile && (
        <nav className="glass-strong fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-ink-3/10 pb-[env(safe-area-inset-bottom)]">
          {mobileTabs.map((item) => (
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
          {mobileMore.map((item) => (
            <button
              key={item.to}
              type="button"
              onClick={() => {
                setMoreOpen(false)
                navigate(item.to)
              }}
              className="flex h-11 items-center gap-3 px-2 text-sm text-ink-2"
            >
              <item.icon className="size-4" />
              {t(item.key)}
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  )
}
