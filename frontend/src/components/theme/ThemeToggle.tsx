import { Moon, Sun } from "lucide-react";
import { useI18n } from "../../i18n/index.js";
import { useTheme } from "../../theme/index.js";
import { Button } from "../ui/index.js";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const { t } = useI18n();
  const dark = theme === "dark";
  const label = t(dark ? "theme.enableLight" : "theme.enableDark");

  return (
    <Button
      type="button"
      variant="ghost"
      className="h-9 min-h-9 w-9 px-0"
      onClick={toggleTheme}
      aria-label={label}
      aria-pressed={dark}
      title={label}
    >
      {dark ? (
        <Sun className="h-4 w-4" aria-hidden />
      ) : (
        <Moon className="h-4 w-4" aria-hidden />
      )}
    </Button>
  );
}
