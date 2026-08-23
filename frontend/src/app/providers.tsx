import { AbilityProvider } from "@casl/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { Toaster } from "sonner";
import { I18nProvider } from "../i18n/index.js";
import { ability } from "../lib/ability.js";
import { ThemeProvider, useTheme } from "../theme/index.js";
import { queryClient } from "./query-client.js";

function SessionBoundary({ children }: { children: ReactNode }) {
  useEffect(() => {
    const unauthenticated = () => {
      queryClient.clear();
      const path = `${location.pathname}${location.search}`;
      const returnTo = path.startsWith("/app") ? path : "/app";
      location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    };
    window.addEventListener("app:unauthenticated", unauthenticated);
    return () =>
      window.removeEventListener("app:unauthenticated", unauthenticated);
  }, []);
  return children;
}

function AppToaster() {
  const { theme } = useTheme();
  return <Toaster richColors position="top-right" theme={theme} />;
}

export const AppProviders = ({ children }: { children: ReactNode }) => (
  <ThemeProvider>
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <AbilityProvider value={ability}>
          <SessionBoundary>{children}</SessionBoundary>
        </AbilityProvider>
        <AppToaster />
      </QueryClientProvider>
    </I18nProvider>
  </ThemeProvider>
);
