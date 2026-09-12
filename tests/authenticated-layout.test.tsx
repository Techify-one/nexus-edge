/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { AuthenticatedLayout } from "../frontend/src/app/AuthenticatedLayout.js";
import { I18nProvider } from "../frontend/src/i18n/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

describe("authenticated layout", () => {
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
      </QueryClientProvider>,
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
