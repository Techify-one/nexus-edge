/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageSwitcher } from "../frontend/src/components/i18n/LanguageSwitcher.js";
import { PermissionChecklist } from "../frontend/src/components/permissions/PermissionChecklist.js";
import { PasswordInput } from "../frontend/src/components/ui/index.js";
import { I18nProvider, translate } from "../frontend/src/i18n/index.js";
import { permissionLabel } from "../frontend/src/lib/permissions.js";

afterEach(cleanup);

describe("internationalization and passwords", () => {
  it("switches to English, persists the locale, and reveals the password", () => {
    render(
      <I18nProvider>
        <LanguageSwitcher />
        <PasswordInput aria-label="Password field" defaultValue="secret12" />
        <PermissionChecklist
          name="permissions"
          permissions={[
            { id: "1", key: "core.user.update" },
            { id: "2", key: "core.group.read" },
            { id: "3", key: "crm.lead.read" },
          ]}
        />
      </I18nProvider>,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "en" } });
    expect(localStorage.getItem("modular.language")).toBe("en");
    expect(document.documentElement.lang).toBe("en");

    const input = screen.getByLabelText("Password field");
    expect(input.getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input.getAttribute("type")).toBe("text");
    expect(screen.getByRole("button", { name: "Hide password" })).toBeTruthy();
    expect(permissionLabel("core.user.update", translate)).toBe("Edit users");
    expect(permissionLabel("core.user.create", translate)).toBe(
      "Invite and create users",
    );
    expect(permissionLabel("core.user.delete", translate)).toBe(
      "Remove users and revoke invitations",
    );
    expect(permissionLabel("crm.lead.read", translate)).toBe("View leads");
    expect(screen.getByRole("heading", { name: "Users" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Groups and access" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "CRM — Leads" })).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "pt-BR" },
    });
    expect(permissionLabel("core.user.update", translate)).toBe(
      "Editar usuários",
    );
    expect(permissionLabel("core.user.create", translate)).toBe(
      "Convidar e criar usuários",
    );
    expect(permissionLabel("core.user.delete", translate)).toBe(
      "Remover usuários e revogar convites",
    );
    expect(permissionLabel("crm.lead.read", translate)).toBe(
      "Visualizar leads",
    );
    expect(screen.getByRole("heading", { name: "Usuários" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Grupos e acessos" }),
    ).toBeTruthy();
  });
});
