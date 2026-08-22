import { Languages } from "lucide-react";
import { supportedLocales, useI18n } from "../../i18n/index.js";

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="inline-flex items-center gap-2 text-sm text-slate-600">
      <Languages className="h-4 w-4" aria-hidden />
      <span className="sr-only">{t("common.language")}</span>
      <select
        className="min-h-9 rounded-lg border bg-white px-2 text-sm shadow-sm"
        value={locale}
        onChange={(event) =>
          setLocale(event.target.value as (typeof supportedLocales)[number])
        }
        aria-label={t("common.language")}
      >
        {supportedLocales.map((item) => (
          <option key={item} value={item}>
            {t(`language.${item}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
