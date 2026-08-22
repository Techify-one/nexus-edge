# Interface internationalization

The SPA uses a small, typed i18n layer in `frontend/src/i18n/index.tsx`. It prevents scattered user-facing strings, keeps the Workers bundle small, and exposes the same contract to Core screens and compiled plugin screens.

## Behavior

- initial locales: `pt-BR` and `en`;
- detection from the `localStorage` preference, then `navigator.languages`;
- safe `pt-BR` fallback for the end-user interface;
- `<html lang>` updates for accessibility;
- locale-aware date/time formatting through `Intl`;
- preference persisted under `modular.language`;
- TypeScript-typed keys, including `{{variable}}` interpolation;
- `Accept-Language` sent with every API call;
- known stable error codes translated on the client;
- permission keys translated into plain-language labels and grouped by system area in group and API-key forms;
- internal identifiers, source code, database objects, technical messages, and operational documents remain in English.

## Adding a language

1. Add the BCP-47 locale to `supportedLocales`.
2. Add a catalog implementing `Record<TranslationKey, string>`.
3. Register the catalog in `resources`.
4. Add `language.<locale>` to every existing catalog.
5. Run `pnpm typecheck`, `pnpm test`, and `pnpm build:frontend`.

`Record<TranslationKey, string>` makes the build fail when a new catalog omits a translation key. Business data, IDs, proper names, permission keys, and technical plugin messages must not be translated as interface text. System-owned values that are shown to users should be mapped to locale keys at the presentation layer.
