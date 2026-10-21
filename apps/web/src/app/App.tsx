import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Spinner } from '../components/ui/index.tsx';
import { Toaster } from '../components/ui/toast.tsx';
import { Onboarding } from '../onboarding/Onboarding.tsx';
import { AppLock } from '../shell/AppLock.tsx';
import { Layout } from '../shell/Layout.tsx';
import { RouteError } from '../shell/RouteError.tsx';
import { DataProvider, useData } from './data.tsx';
import { visibleSections } from './routes.tsx';
import { useApp } from './store.ts';
import { useThemeAndLang } from './theme.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

function AppRoutes() {
  const onboarded = useApp((s) => s.onboarded);
  const { mode, profile, user } = useData();
  if (!onboarded || !mode || !profile) return <Onboarding />;
  const sections = visibleSections(mode, !!user?.isAdmin);
  return (
    <AppLock>
      <Layout sections={sections}>
        <RouteError>
          <Suspense fallback={<Spinner />}>
            <Routes>
              {sections.map((s) => (
                <Route
                  key={s.id}
                  path={`${s.path === '/' ? '' : s.path}/*`}
                  element={<s.Component />}
                />
              ))}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </RouteError>
      </Layout>
    </AppLock>
  );
}

export function App() {
  useThemeAndLang();
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <DataProvider>
          <AppRoutes />
        </DataProvider>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  );
}
