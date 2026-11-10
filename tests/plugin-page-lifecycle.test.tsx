/* @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import type { PluginPageMountV1 } from "@nexus/plugin-sdk";
import { PluginPageHost } from "../frontend/src/plugins/PluginPageHost.js";

const mocks = vi.hoisted(() => ({ activate: vi.fn(), theme: "light" }));
vi.mock("../frontend/src/plugins/runtime.js", () => ({
  activatePluginRuntime: mocks.activate,
}));
vi.mock("../frontend/src/i18n/index.js", () => ({
  useI18n: () => ({ t: (s: string) => s, locale: "en" }),
  getAppLocale: () => "en",
}));
vi.mock("../frontend/src/theme/index.js", () => ({
  useTheme: () => ({ theme: mocks.theme }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.theme = "light";
});

function Navigation() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("?busca=a")}>Search</button>
      <button onClick={() => navigate("/app/p/example/entries#detail")}>
        Entries
      </button>
      <button onClick={() => navigate(-1)}>Back</button>
      <button onClick={() => navigate("?core-recovery=1")}>Recovery</button>
    </>
  );
}
function setup(
  mountPage: () => PluginPageMountV1 | Promise<PluginPageMountV1>,
) {
  const descriptor = {
    pluginId: "example",
    name: "Example",
    version: "1",
    releaseHash: "hash1",
    entryUrl: "/entry.js",
    styleUrls: [],
    isolation: "light",
    permissions: [],
    routes: [],
    menu: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ hostApi: 1, plugins: [descriptor] })),
  );
  mocks.activate.mockResolvedValue({
    module: { mountPage },
    session: undefined,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/app/p/example"]}>
        <Navigation />
        <Routes>
          <Route path="/app/p/:pluginId/*" element={<PluginPageHost />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(tree());
  return {
    ...result,
    client,
    descriptor,
    rerenderTree: () => result.rerender(tree()),
  };
}

describe("plugin page lifecycle", () => {
  it("keeps route-aware plugins and focused inputs mounted across search, routes and Back", async () => {
    const dispose = vi.fn();
    const updateRoute = vi.fn();
    const mountPage = vi.fn(({ container }: { container: HTMLElement }) => {
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Recurrence search");
      container.append(input);
      return { dispose, updateRoute };
    });
    setup(mountPage as never);
    const input = await screen.findByLabelText("Recurrence search");
    input.focus();
    fireEvent.click(screen.getByText("Search"));
    await waitFor(() =>
      expect(updateRoute).toHaveBeenCalledWith(
        expect.objectContaining({ search: "?busca=a" }),
      ),
    );
    expect(screen.getByLabelText("Recurrence search")).toBe(input);
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByText("Entries"));
    await waitFor(() =>
      expect(updateRoute).toHaveBeenCalledWith(
        expect.objectContaining({ relativePath: "/entries", hash: "#detail" }),
      ),
    );
    fireEvent.click(screen.getByText("Back"));
    await waitFor(() =>
      expect(updateRoute).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "?busca=a" }),
      ),
    );
    expect(mountPage).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("preserves legacy remounts and disposes when entering recovery", async () => {
    const dispose = vi.fn();
    const mountPage = vi.fn(() => ({ dispose }));
    setup(mountPage);
    await waitFor(() => expect(mountPage).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Search"));
    await waitFor(() => expect(mountPage).toHaveBeenCalledTimes(2));
    expect(dispose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Recovery"));
    await waitFor(() => expect(dispose).toHaveBeenCalledTimes(2));
  });

  it("disposes late asynchronous mounts after unmount", async () => {
    const dispose = vi.fn();
    let resolve!: (mount: PluginPageMountV1) => void;
    const mountPage = vi.fn(
      () =>
        new Promise<PluginPageMountV1>((r) => {
          resolve = r;
        }),
    );
    const { unmount } = setup(mountPage);
    await waitFor(() => expect(mountPage).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      resolve({ dispose, updateRoute: vi.fn() });
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("applies the latest route after a slow initial mount", async () => {
    const updateRoute = vi.fn();
    let resolve!: (mount: PluginPageMountV1) => void;
    const mountPage = vi.fn(
      () =>
        new Promise<PluginPageMountV1>((r) => {
          resolve = r;
        }),
    );
    setup(mountPage);
    await waitFor(() => expect(mountPage).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Search"));
    fireEvent.click(screen.getByText("Entries"));
    await act(async () => {
      resolve({ dispose: vi.fn(), updateRoute });
    });
    expect(updateRoute).toHaveBeenLastCalledWith(
      expect.objectContaining({ relativePath: "/entries" }),
    );
    expect(mountPage).toHaveBeenCalledTimes(1);
  });

  it("remounts for a new release or changed permissions", async () => {
    const dispose = vi.fn();
    const mountPage = vi.fn(() => ({ dispose, updateRoute: vi.fn() }));
    const { client, descriptor } = setup(mountPage);
    await waitFor(() => expect(mountPage).toHaveBeenCalledTimes(1));
    act(() =>
      client.setQueryData(["plugin-runtime"], {
        plugins: [{ ...descriptor, releaseHash: "hash2" }],
      }),
    );
    await waitFor(() => expect(mountPage).toHaveBeenCalledTimes(2));
    act(() =>
      client.setQueryData(["plugin-runtime"], {
        plugins: [
          {
            ...descriptor,
            releaseHash: "hash2",
            permissions: ["example.records.read"],
          },
        ],
      }),
    );
    await waitFor(() => expect(mountPage).toHaveBeenCalledTimes(3));
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
