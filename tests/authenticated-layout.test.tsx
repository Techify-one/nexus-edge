/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMongoAbility } from "@casl/ability";
import { packRules } from "@casl/ability/extra";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryRouter,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { AuthenticatedLayout } from "../frontend/src/app/AuthenticatedLayout.js";
import { I18nProvider } from "../frontend/src/i18n/index.js";
import { ThemeProvider } from "../frontend/src/theme/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

describe("authenticated layout", () => {
  it("boots the authenticated shell with one combined session request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/me")
        return Response.json({
          user: { id: "usr_admin", active: true },
          principal: { authMethod: "cookie" },
          rules: packRules(
            createMongoAbility<[string, string]>([
              { action: "manage", subject: "all" },
            ]).rules,
          ),
        });
      if (url === "/api/v1/plugin-runtime")
        return Response.json({ plugins: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <I18nProvider>
            <MemoryRouter initialEntries={["/app"]}>
              <Routes>
                <Route path="/app" element={<AuthenticatedLayout />}>
                  <Route element={<Outlet />}>
                    <Route index element={<p>Ready</p>} />
                  </Route>
                </Route>
              </Routes>
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    );

    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/v1/me"),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith("/api/v1/me/ability"),
      ),
    ).toBe(false);
  });

  it("keeps the session route on a temporary 429 instead of redirecting to login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "RATE_LIMITED",
              message: "Too many requests",
            },
          },
          { status: 429 },
        ),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <I18nProvider>
            <MemoryRouter initialEntries={["/app/plugins/marketplaces"]}>
              <LocationProbe />
              <Routes>
                <Route path="/app/*" element={<AuthenticatedLayout />} />
                <Route path="/login" element={<p>Login</p>} />
              </Routes>
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    );

    expect(
      await screen.findByRole("heading", {
        name: /^(Não foi possível verificar sua sessão|Your session could not be verified)$/,
      }),
    ).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe(
      "/app/plugins/marketplaces",
    );
    expect(screen.queryByText("Login")).toBeNull();
  });
});
