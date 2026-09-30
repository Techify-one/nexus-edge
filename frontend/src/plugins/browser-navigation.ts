type Installation = {
  dispose(): void;
  coreWindow: Window;
};

const installations = new WeakMap<Window, Installation>();

/** Keep independently mounted plugin routers in sync with the Core router. */
export function synchronizeBrowserNavigation(
  target: Window = window,
): Installation {
  const installed = installations.get(target);
  if (installed) return installed;

  const history = target.history;
  const pushState = history.pushState;
  const replaceState = history.replaceState;
  const coreEvents = new WeakSet<Event>();
  const coreListeners = new Map<
    EventListenerOrEventListenerObject,
    EventListener
  >();
  let pending = false;
  let disposed = false;
  let writingFromCore = false;
  let lastWriteFromCore = false;

  const notify = () => {
    if (pending) return;
    pending = true;
    // Let the initiating router finish its own update before notifying peers.
    queueMicrotask(() => {
      if (!pending || disposed) return;
      pending = false;
      const event = new PopStateEvent("popstate", { state: history.state });
      if (lastWriteFromCore) coreEvents.add(event);
      target.dispatchEvent(event);
    });
  };
  const wrap = (method: History["pushState"]): History["pushState"] =>
    function (data, unused, url) {
      const previousUrl = target.location.href;
      const previousState = history.state;
      method.call(history, data, unused, url);
      lastWriteFromCore = writingFromCore;
      if (
        target.location.href !== previousUrl ||
        history.state !== previousState
      )
        notify();
    };
  const synchronizedPush = wrap(pushState);
  const synchronizedReplace = wrap(replaceState);
  history.pushState = synchronizedPush;
  history.replaceState = synchronizedReplace;

  const writeFromCore = (method: History["pushState"]): History["pushState"] =>
    function (data, unused, url) {
      writingFromCore = true;
      try {
        method.call(history, data, unused, url);
      } finally {
        writingFromCore = false;
      }
    };
  const corePush = writeFromCore(synchronizedPush);
  const coreReplace = writeFromCore(synchronizedReplace);
  const coreHistory = new Proxy(history, {
    get(object, key) {
      if (key === "pushState") return corePush;
      if (key === "replaceState") return coreReplace;
      const value = Reflect.get(object, key, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  // The data router already processes its own writes as PUSH/REPLACE. Only
  // plugin-originated synthetic events and native Back/Forward reach it.
  const coreWindow = new Proxy(target, {
    get(object, key) {
      if (key === "history") return coreHistory;
      if (key === "addEventListener")
        return (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: AddEventListenerOptions | boolean,
        ) => {
          if (type !== "popstate") {
            object.addEventListener(type, listener, options);
            return;
          }
          let wrapped = coreListeners.get(listener);
          if (!wrapped) {
            wrapped = (event) => {
              if (coreEvents.has(event)) return;
              if (typeof listener === "function") listener.call(object, event);
              else listener.handleEvent(event);
            };
            coreListeners.set(listener, wrapped);
          }
          object.addEventListener(type, wrapped, options);
        };
      if (key === "removeEventListener")
        return (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: EventListenerOptions | boolean,
        ) => {
          object.removeEventListener(
            type,
            coreListeners.get(listener) ?? listener,
            options,
          );
          coreListeners.delete(listener);
        };
      const value = Reflect.get(object, key, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  const onNativePop = (event: PopStateEvent) => {
    if (event.isTrusted) pending = false;
  };
  target.addEventListener("popstate", onNativePop);

  const installation = {
    coreWindow,
    dispose() {
      if (disposed) return;
      disposed = true;
      pending = false;
      target.removeEventListener("popstate", onNativePop);
      for (const listener of coreListeners.values())
        target.removeEventListener("popstate", listener);
      coreListeners.clear();
      if (history.pushState === synchronizedPush) history.pushState = pushState;
      if (history.replaceState === synchronizedReplace)
        history.replaceState = replaceState;
      installations.delete(target);
    },
  };
  installations.set(target, installation);
  return installation;
}
