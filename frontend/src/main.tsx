import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentBranding } from '~/components/brand/document-branding';
import { AppToaster } from '~/components/layout/app-toaster';
import { installExternalLinks } from '~/lib/external-links';
import { installPrefFlush } from '~/lib/pref-writes';
import { AppearanceSync } from '~/lib/prefs';
import { ThemeProvider } from '~/providers/theme-provider';
import { router } from '~/router';
import './styles/global.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1 },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

installExternalLinks();
// A pref change still waiting to be saved is sent as the page is hidden or reloaded.
installPrefFlush();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <DocumentBranding router={router} />
        <AppearanceSync />
        <RouterProvider router={router} />
        <AppToaster router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
