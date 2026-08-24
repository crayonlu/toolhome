import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { AppShell } from './app/AppShell'
import { I18nProvider } from './i18n'
import { ToastProvider } from './components/ui/Toast'
import { ConfirmProvider } from './components/ui/ConfirmDialog'
import { getStoredKey } from './api/client'
import { LoginPage } from './features/login/LoginPage'
import { DashboardPage } from './features/dashboard/DashboardPage'
import { ServersPage } from './features/servers/ServersPage'
import { ServerDetailPage } from './features/servers/ServerDetailPage'
import { ClisPage } from './features/clis/ClisPage'
import { CredentialsPage } from './features/credentials/CredentialsPage'
import { AccessKeysPage } from './features/access-keys/AccessKeysPage'
import { EndpointsPage } from './features/endpoints/EndpointsPage'
import { DiagnosticsPage } from './features/diagnostics/DiagnosticsPage'
import { EventsPage } from './features/events/EventsPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { MarketPage } from './features/market/MarketPage'
import { SecureActionPage } from './features/market/SecureActionPage'
import { CallsPage } from './features/calls/CallsPage'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

function hasKey(): boolean {
  return getStoredKey() !== null
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const onUnauthorized = () => {
      window.location.href = '/login'
    }
    window.addEventListener('mch:unauthorized', onUnauthorized)
    return () => window.removeEventListener('mch:unauthorized', onUnauthorized)
  }, [])
  return hasKey() ? children : <Navigate to="/login" replace />
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route
                  element={
                    <RequireAuth>
                      <AppShell />
                    </RequireAuth>
                  }
                >
                  <Route index element={<DashboardPage />} />
                  <Route path="/servers" element={<ServersPage />} />
                  <Route path="/servers/:id" element={<ServerDetailPage />} />
                  <Route path="/clis" element={<ClisPage />} />
                  <Route path="/credentials" element={<CredentialsPage />} />
                  <Route path="/access-keys" element={<AccessKeysPage />} />
                  <Route path="/market" element={<MarketPage />} />
                  <Route path="/market/actions/:actionId" element={<SecureActionPage />} />
                  <Route path="/endpoints" element={<EndpointsPage />} />
                  <Route path="/diagnostics" element={<DiagnosticsPage />} />
                  <Route path="/events" element={<EventsPage />} />
                  <Route path="/calls" element={<CallsPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </BrowserRouter>
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  )
}
