/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UsersPage from "../frontend/src/features/users/UsersPage.js";
import { I18nProvider } from "../frontend/src/i18n/index.js";
import { ability } from "../frontend/src/lib/ability.js";

afterEach(() => {
  cleanup();
  ability.update([]);
  vi.restoreAllMocks();
});

describe("users page compatibility", () => {
  it("renders legacy users when profile and table-preference routes are absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/v1/users?"))
          return Response.json({
            items: [
              {
                id: "usr_legacy",
                name: "Usuário legado",
                email: "legacy@example.com",
                active: 1,
                createdAt: 1,
                groups: [],
              },
            ],
          });
        if (
          url === "/api/v1/users/profile-options" ||
          url.includes("/api/v1/me/table-preferences/")
        )
          return Response.json(
            { error: { code: "NOT_FOUND", message: "Not found" } },
            { status: 404 },
          );
        if (url === "/api/v1/groups" || url === "/api/v1/invitations")
          return Response.json({ items: [] });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    ability.update([{ action: "manage", subject: "all" }]);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <UsersPage />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Usuário legado")).toBeTruthy();
    expect(screen.getByText("legacy@example.com")).toBeTruthy();
    expect(screen.getByText(/^(Ativo|Active)$/)).toBeTruthy();
  });
});
