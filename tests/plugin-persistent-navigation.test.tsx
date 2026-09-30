/* @vitest-environment jsdom */

import type { PluginModuleV1 } from "@nexus/plugin-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  createBrowserRouter,
  Navigate,
  Outlet,
  Route,
  RouterProvider,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../frontend/src/i18n/index.js";
import { synchronizeBrowserNavigation } from "../frontend/src/plugins/browser-navigation.js";
import { resolvePluginBackTarget } from "../frontend/src/plugins/navigation.js";
import { PersistentPluginSurfaceHost } from "../frontend/src/plugins/PersistentPluginSurfaceHost.js";
import { PluginPageHost } from "../frontend/src/plugins/PluginPageHost.js";
import type { RuntimePluginDescriptor } from "../frontend/src/plugins/runtime.js";
import { ThemeProvider } from "../frontend/src/theme/index.js";

const runtime = vi.hoisted(() => ({
  api: vi.fn(),
  loadPluginModule: vi.fn(),
  activatePluginRuntime: vi.fn(),
  deactivateAllPluginRuntimes: vi.fn(),
}));

vi.mock("../frontend/src/lib/api/core-client.js", () => ({ api: runtime.api }));
vi.mock("../frontend/src/plugins/runtime.js", () => ({
  loadPluginModule: runtime.loadPluginModule,
  activatePluginRuntime: runtime.activatePluginRuntime,
  deactivateAllPluginRuntimes: runtime.deactivateAllPluginRuntimes,
}));

const pluginPath = "/app/p/meeting_recorder";
const descriptor: RuntimePluginDescriptor = {
  pluginId: "meeting_recorder",
  name: "Meeting Recorder",
  version: "1.0.0",
  releaseHash: "test-release",
  entryUrl: "/test/meeting-recorder.js",
  styleUrls: [],
  isolation: "light",
  persistentSurface: true,
  permissions: [],
  localeUrl: "/test/meeting-recorder-locale.json",
  routes: [{ routeKey: "home", path: pluginPath }],
  menu: [],
};

type PageMount = { container: HTMLElement; content: ReactNode } | null;
type Session = {
  current: PageMount;
  listeners: Set<(mount: PageMount) => void>;
};

const RecordingContext = createContext<string | null>(null);
let disposeRouter: (() => void) | undefined;
let stopSynchronization: (() => void) | undefined;
let queryClient: QueryClient | undefined;

afterEach(async () => {
  await act(async () => cleanup());
  disposeRouter?.();
  stopSynchronization?.();
  queryClient?.clear();
  disposeRouter = undefined;
  stopSynchronization = undefined;
  queryClient = undefined;
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/");
});

function CoreShell() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <PersistentPluginSurfaceHost>
      <output data-testid="core-location">{location.pathname}</output>
      <button
        onClick={() => {
          const target = resolvePluginBackTarget(location.pathname, []);
          if (target) void navigate(target);
        }}
      >
        Core back
      </button>
      <Outlet />
    </PersistentPluginSurfaceHost>
  );
}

function RecordingList() {
  const navigate = useNavigate();
  const recording = useContext(RecordingContext);
  return (
    <section aria-label="Recording list">
      <output data-testid="recording-session">{recording}</output>
      <button onClick={() => navigate(`${pluginPath}/recording-1`)}>
        Open recording
      </button>
    </section>
  );
}

function RecordingDetail() {
  const recording = useContext(RecordingContext);
  return (
    <section aria-label="Recording detail">
      <output data-testid="recording-session">{recording}</output>
    </section>
  );
}

function RecordingRoutes({ redirect }: { redirect: () => void }) {
  return (
    <Routes>
      <Route path={pluginPath} element={<RecordingList />} />
      <Route
        path={`${pluginPath}/:recordingId`}
        element={<RecordingDetail />}
      />
      <Route path="*" element={<Fallback redirect={redirect} />} />
    </Routes>
  );
}

function Fallback({ redirect }: { redirect: () => void }) {
  useEffect(redirect, [redirect]);
  return <Navigate to={pluginPath} replace />;
}

function createRecordingPlugin() {
  const providerMount = vi.fn();
  const providerUnmount = vi.fn();
  const pageDispose = vi.fn();
  const surfaceDispose = vi.fn();
  const redirect = vi.fn();

  function SessionProvider({ children }: { children: ReactNode }) {
    const [recording] = useState(() => "active-recording-session");
    useEffect(() => {
      providerMount();
      return () => {
        providerUnmount();
      };
    }, []);
    return (
      <RecordingContext.Provider value={recording}>
        <output data-testid="persistent-session">{recording}</output>
        {children}
      </RecordingContext.Provider>
    );
  }

  function PersistentRecorder({ session }: { session: Session }) {
    const [mount, setMount] = useState(session.current);
    useEffect(() => {
      session.listeners.add(setMount);
      setMount(session.current);
      return () => {
        session.listeners.delete(setMount);
      };
    }, [session]);
    return (
      <SessionProvider>
        {mount ? createPortal(mount.content, mount.container) : null}
      </SessionProvider>
    );
  }

  const updateMount = (session: Session, mount: PageMount) => {
    session.current = mount;
    session.listeners.forEach((listener) => listener(mount));
  };
  const activate = vi.fn((): Session => ({
    current: null,
    listeners: new Set(),
  }));
  const module: PluginModuleV1 = {
    activate,
    mountSurface: vi.fn(({ container, session }) => {
      const root = createRoot(container);
      root.render(
        <BrowserRouter>
          <PersistentRecorder session={session as Session} />
        </BrowserRouter>,
      );
      return {
        async dispose() {
          surfaceDispose();
          // The Core cleanup runs in another root's commit phase.
          await Promise.resolve();
          root.unmount();
        },
      };
    }),
    mountPage: vi.fn(({ container, session }) => {
      const active = session as Session;
      const mount = {
        container,
        content: <RecordingRoutes redirect={redirect} />,
      };
      updateMount(active, mount);
      return {
        dispose() {
          pageDispose();
          // React removes portal children; the host owns container removal.
          if (active.current === mount) updateMount(active, null);
        },
      };
    }),
  };
  return {
    module,
    activate,
    providerMount,
    providerUnmount,
    pageDispose,
    surfaceDispose,
    redirect,
  };
}

describe("persistent plugin navigation through real Core hosts", () => {
  it("returns detail to list and then Core without a wildcard redirect or provider unmount", async () => {
    const plugin = createRecordingPlugin();
    runtime.api.mockImplementation(async (path: string) => {
      if (path !== "/api/v1/plugin-runtime")
        throw new Error(`Unexpected API: ${path}`);
      return { hostApi: 1, plugins: [descriptor] };
    });
    runtime.loadPluginModule.mockResolvedValue(plugin.module);
    // Both real hosts share one activated module and session, as in the runtime.
    let activation:
      Promise<{ module: PluginModuleV1; session: Session }> | undefined;
    runtime.activatePluginRuntime.mockImplementation((input, host) => {
      expect(input).toBe(descriptor);
      activation ??= runtime
        .loadPluginModule(input.entryUrl)
        .then(async (module: PluginModuleV1) => ({
          module,
          session: (await module.activate!(host)) as Session,
        }));
      return activation;
    });
    runtime.deactivateAllPluginRuntimes.mockResolvedValue(undefined);
    window.history.replaceState(null, "", pluginPath);
    const synchronization = synchronizeBrowserNavigation();
    stopSynchronization = synchronization.dispose;
    const router = createBrowserRouter(
      [
        {
          path: "/app",
          element: <CoreShell />,
          children: [
            {
              index: true,
              element: <section aria-label="Core home">Core home</section>,
            },
            { path: "p/:pluginId/*", element: <PluginPageHost /> },
          ],
        },
      ],
      { window: synchronization.coreWindow },
    );
    disposeRouter = () => router.dispose();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ThemeProvider>
            <RouterProvider router={router} />
          </ThemeProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );

    async function expectPath(path: string) {
      await waitFor(() => {
        expect(window.location.pathname).toBe(path);
        expect(router.state.location.pathname).toBe(path);
        expect(screen.getByTestId("core-location").textContent).toBe(path);
      });
    }

    await screen.findByRole("region", { name: "Recording list" });
    await expectPath(pluginPath);
    expect(screen.getByTestId("recording-session").textContent).toBe(
      "active-recording-session",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open recording" }));
    await screen.findByRole("region", { name: "Recording detail" });
    await expectPath(`${pluginPath}/recording-1`);
    expect(screen.queryByRole("region", { name: "Recording list" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Core back" }));
    await screen.findByRole("region", { name: "Recording list" });
    await expectPath(pluginPath);
    expect(
      screen.queryByRole("region", { name: "Recording detail" }),
    ).toBeNull();
    expect(screen.getByTestId("recording-session").textContent).toBe(
      "active-recording-session",
    );
    expect(plugin.pageDispose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Core back" }));
    await screen.findByRole("region", { name: "Core home" });
    await expectPath("/app");
    // Flush peer-router notifications and any effect-driven Navigate replace.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await expectPath("/app");
    expect(screen.queryByRole("region", { name: "Recording list" })).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Recording detail" }),
    ).toBeNull();
    expect(document.querySelector("[data-nexus-plugin]")).toBeNull();
    expect(screen.getByTestId("persistent-session").textContent).toBe(
      "active-recording-session",
    );
    expect(plugin.redirect).not.toHaveBeenCalled();
    expect(plugin.providerMount).toHaveBeenCalledTimes(1);
    expect(plugin.providerUnmount).not.toHaveBeenCalled();
    expect(plugin.surfaceDispose).not.toHaveBeenCalled();
    expect(plugin.pageDispose).toHaveBeenCalledTimes(3);
    expect(plugin.activate).toHaveBeenCalledTimes(1);
    expect(runtime.loadPluginModule).toHaveBeenCalledTimes(1);
    expect(plugin.module.mountSurface).toHaveBeenCalledTimes(1);
    expect(plugin.module.mountPage).toHaveBeenCalledTimes(3);
    expect(runtime.deactivateAllPluginRuntimes).not.toHaveBeenCalled();
    const active = await activation!;
    expect(active.session.current).toBeNull();
    expect(active.session.listeners.size).toBe(1);
  });
});
