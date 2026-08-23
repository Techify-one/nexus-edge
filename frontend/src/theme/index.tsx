import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type AppTheme = "light" | "dark";

const storageKey = "modular.theme";

export function getStoredTheme(): AppTheme {
  try {
    return window.localStorage.getItem(storageKey) === "dark"
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: AppTheme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

export function initializeTheme() {
  if (typeof document !== "undefined") applyTheme(getStoredTheme());
}

type ThemeValue = {
  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<AppTheme>(getStoredTheme);
  const setTheme = useCallback((nextTheme: AppTheme) => {
    applyTheme(nextTheme);
    try {
      window.localStorage.setItem(storageKey, nextTheme);
    } catch {
      // Theme switching still works when browser storage is unavailable.
    }
    setThemeState(nextTheme);
  }, []);
  const toggleTheme = useCallback(() => {
    setThemeState((currentTheme) => {
      const nextTheme = currentTheme === "dark" ? "light" : "dark";
      applyTheme(nextTheme);
      try {
        window.localStorage.setItem(storageKey, nextTheme);
      } catch {
        // Theme switching still works when browser storage is unavailable.
      }
      return nextTheme;
    });
  }, []);

  useEffect(() => applyTheme(theme), [theme]);

  const value = useMemo(
    () => ({ theme, setTheme, toggleTheme }),
    [setTheme, theme, toggleTheme],
  );
  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}
