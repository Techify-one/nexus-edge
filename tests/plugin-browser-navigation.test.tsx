/* @vitest-environment jsdom */

import { useEffect } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  BrowserRouter,
  createBrowserRouter,
  RouterProvider,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { synchronizeBrowserNavigation } from "../frontend/src/plugins/browser-navigation.js";
import { resolvePluginBackTarget } from "../frontend/src/plugins/navigation.js";

let stopSynchronization: (() => void) | undefined;
let disposeRouter: (() => void) | undefined;

afterEach(() => {
  cleanup();
  disposeRouter?.();
  stopSynchronization?.();
  disposeRouter = undefined;
  stopSynchronization = undefined;
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function LocationProbe({ name }: { name: string }) {
  const location = useLocation();
  return (
    <>
      <output data-testid={name}>
        {location.pathname}
        {location.search}
        {location.hash}
      </output>
      <output data-testid={`${name}-state`}>
        {JSON.stringify(location.state)}
      </output>
    </>
  );
}

function CoreShell() {
  const navigate = useNavigate();
  return (
    <>
      <LocationProbe name="core-location" />
      <button
        onClick={() => {
          const parent = resolvePluginBackTarget(window.location.pathname, []);
          if (parent) void navigate(parent);
        }}
      >
        Core back
      </button>
      <button
        onClick={() =>
          void navigate("/app/p/example/settings?tab=audio#device")
        }
      >
        Core settings
      </button>
    </>
  );
}

function Plugin({ unmount }: { unmount: () => void }) {
  const navigate = useNavigate();
  useEffect(() => unmount, [unmount]);
  return (
    <>
      <LocationProbe name="plugin-location" />
      <button onClick={() => void navigate("/app/p/example/recording-1")}>
        Open recording
      </button>
      <button
        onClick={() =>
          void navigate("/app/p/example/recording-2?tab=transcript#text", {
            replace: true,
          })
        }
      >
        Replace recording
      </button>
    </>
  );
}

function mountRouters(path = "/app/p/example") {
  window.history.replaceState(null, "", path);
  const synchronization = synchronizeBrowserNavigation();
  stopSynchronization = synchronization.dispose;
  const router = createBrowserRouter([{ path: "*", element: <CoreShell /> }], {
    window: synchronization.coreWindow,
  });
  disposeRouter = () => router.dispose();
  const unmount = vi.fn();
  render(<RouterProvider router={router} />);
  // Plugin bundles mount their own React root and BrowserRouter.
  render(
    <BrowserRouter>
      <Plugin unmount={unmount} />
    </BrowserRouter>,
  );
  return { router, unmount };
}

async function expectLocations(path: string) {
  await waitFor(() => {
    expect(screen.getByTestId("core-location").textContent).toBe(path);
    expect(screen.getByTestId("plugin-location").textContent).toBe(path);
  });
}

describe("independent plugin browser navigation", () => {
  it.each(["meeting_recorder", "crm", "example"])(
    "returns %s details to its list without a reload",
    async (pluginId) => {
      const root = `/app/p/${pluginId}`;
      const { router, unmount } = mountRouters(root);
      await act(async () => {
        window.history.pushState({ idx: 1 }, "", `${root}/recording-1`);
      });
      await expectLocations(`${root}/recording-1`);
      fireEvent.click(screen.getByRole("button", { name: "Core back" }));
      await expectLocations(root);
      expect(unmount).not.toHaveBeenCalled();
      expect(router.state.location.pathname).toBe(root);
      fireEvent.click(screen.getByRole("button", { name: "Core back" }));
      await expectLocations("/app");
    },
  );

  it("synchronizes useNavigate in both directions and preserves the persistent provider", async () => {
    const { router, unmount } = mountRouters();
    fireEvent.click(screen.getByRole("button", { name: "Open recording" }));
    await expectLocations("/app/p/example/recording-1");
    fireEvent.click(screen.getByRole("button", { name: "Core back" }));
    await expectLocations("/app/p/example");
    fireEvent.click(screen.getByRole("button", { name: "Core settings" }));
    await expectLocations("/app/p/example/settings?tab=audio#device");
    expect(router.state.historyAction).toBe("PUSH");
    expect(unmount).not.toHaveBeenCalled();
  });

  it("returns a deep link one level at a time, independent of previous browser history", async () => {
    mountRouters("/app/p/example/settings/audio/");
    fireEvent.click(screen.getByRole("button", { name: "Core back" }));
    await expectLocations("/app/p/example/settings");
    fireEvent.click(screen.getByRole("button", { name: "Core back" }));
    await expectLocations("/app/p/example");
  });

  it("preserves replace semantics, query, hash, and browser back/forward", async () => {
    mountRouters();
    const initialLength = window.history.length;
    fireEvent.click(screen.getByRole("button", { name: "Open recording" }));
    await expectLocations("/app/p/example/recording-1");
    fireEvent.click(screen.getByRole("button", { name: "Replace recording" }));
    await expectLocations("/app/p/example/recording-2?tab=transcript#text");
    expect(window.history.length).toBe(initialLength + 1);
    expect(window.history.state.idx).toBe(1);
    act(() => window.history.back());
    await expectLocations("/app/p/example");
    act(() => window.history.forward());
    await expectLocations("/app/p/example/recording-2?tab=transcript#text");
  });

  it("synchronizes state-only replacement without adding a history entry", async () => {
    const { router } = mountRouters();
    const length = window.history.length;
    await act(async () => {
      window.history.replaceState(
        { ...window.history.state, usr: { tab: "audio" } },
        "",
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("core-location-state").textContent).toBe(
        '{"tab":"audio"}',
      );
      expect(screen.getByTestId("plugin-location-state").textContent).toBe(
        '{"tab":"audio"}',
      );
    });
    await act(async () => {
      await router.navigate("/app/p/example", {
        replace: true,
        state: { tab: "text" },
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("plugin-location-state").textContent).toBe(
        '{"tab":"text"}',
      );
    });
    expect(router.state.historyAction).toBe("REPLACE");
    expect(window.history.length).toBe(length);
  });

  it("keeps both routers aligned through interleaved writes and native traversal", async () => {
    const { router } = mountRouters();
    fireEvent.click(screen.getByRole("button", { name: "Open recording" }));
    await expectLocations("/app/p/example/recording-1");
    fireEvent.click(screen.getByRole("button", { name: "Core settings" }));
    await expectLocations("/app/p/example/settings?tab=audio#device");
    fireEvent.click(screen.getByRole("button", { name: "Replace recording" }));
    await expectLocations("/app/p/example/recording-2?tab=transcript#text");
    expect(window.history.state.idx).toBe(2);
    act(() => window.history.back());
    await expectLocations("/app/p/example/recording-1");
    expect(window.history.state.idx).toBe(1);
    act(() => window.history.forward());
    await expectLocations("/app/p/example/recording-2?tab=transcript#text");
    expect(router.state.historyAction).toBe("POP");
  });

  it("installs once, coalesces writes, and restores history", async () => {
    const originalPush = window.history.pushState;
    const originalReplace = window.history.replaceState;
    const synchronization = synchronizeBrowserNavigation();
    stopSynchronization = synchronization.dispose;
    expect(synchronizeBrowserNavigation()).toBe(synchronization);
    const listener = vi.fn();
    window.addEventListener("popstate", listener);
    try {
      window.history.pushState(
        { idx: 1, usr: { selected: true } },
        "",
        "/app/p/example/one",
      );
      window.history.replaceState(
        { idx: 1, usr: { selected: false } },
        "",
        "/app/p/example/two",
      );
      expect(listener).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0]?.[0].state).toEqual({
        idx: 1,
        usr: { selected: false },
      });
      window.history.pushState({ idx: 2 }, "", "/app/p/example/three");
      stopSynchronization();
      await Promise.resolve();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(window.history.pushState).toBe(originalPush);
      expect(window.history.replaceState).toBe(originalReplace);
    } finally {
      window.removeEventListener("popstate", listener);
    }
  });
});
