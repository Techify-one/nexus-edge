/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "../frontend/src/components/theme/ThemeToggle.js";
import {
  Card,
  DataValue,
  Input,
  MetricCard,
} from "../frontend/src/components/ui/index.js";
import { I18nProvider } from "../frontend/src/i18n/index.js";
import { ThemeProvider } from "../frontend/src/theme/index.js";

afterEach(() => {
  cleanup();
  localStorage.removeItem("modular.theme");
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
});

describe("application theme", () => {
  it("switches themes and persists the choice", () => {
    render(
      <ThemeProvider>
        <I18nProvider>
          <ThemeToggle />
        </I18nProvider>
      </ThemeProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /ativar tema escuro|enable dark theme/i,
      }),
    );

    expect(localStorage.getItem("modular.theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(
      screen.getByRole("button", {
        name: /ativar tema claro|enable light theme/i,
      }),
    ).toBeTruthy();
  });

  it("restores a saved dark theme on a later access", () => {
    localStorage.setItem("modular.theme", "dark");

    render(
      <ThemeProvider>
        <I18nProvider>
          <ThemeToggle />
          <div data-testid="plugin-page">Plugin</div>
        </I18nProvider>
      </ThemeProvider>,
    );

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByTestId("plugin-page")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /ativar tema claro|enable light theme/i,
      }),
    ).toBeTruthy();
  });

  it("provides shared contrast surfaces and semantic metric accents", () => {
    render(
      <div>
        <Card data-testid="card">Content</Card>
        <Input aria-label="Field" />
        <MetricCard label="Spend" value="$42" tone="success" />
        <DataValue tone="info">128</DataValue>
      </div>,
    );

    expect(screen.getByTestId("card").classList.contains("app-card")).toBe(
      true,
    );
    expect(screen.getByLabelText("Field").classList.contains("app-field")).toBe(
      true,
    );
    expect(screen.getByText("$42").closest("div")?.className).toContain(
      "metric-card-success",
    );
    expect(screen.getByText("128").classList.contains("data-value-info")).toBe(
      true,
    );
  });
});
