import { zodResolver } from "@hookform/resolvers/zod";
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { toast } from "sonner";
import { api, ApiError } from "../../lib/api/core-client.js";
import { APP_MARK, APP_NAME } from "../../lib/branding.js";
import { LanguageSwitcher } from "../../components/i18n/LanguageSwitcher.js";
import { ThemeToggle } from "../../components/theme/ThemeToggle.js";
import { useI18n, type TranslationKey } from "../../i18n/index.js";
import {
  Button,
  Card,
  FieldError,
  Input,
  Label,
  PasswordInput,
} from "../../components/ui/index.js";

type Setup = {
  name: string;
  email: string;
  password: string;
  confirmation: string;
};
const createSetupSchema = (t: (key: TranslationKey) => string) =>
  z
    .object({
      name: z.string().min(2, t("auth.nameMin")),
      email: z.email(t("auth.invalidEmail")),
      password: z.string().min(8, t("auth.passwordMin")),
      confirmation: z.string(),
    })
    .refine((value) => value.password === value.confirmation, {
      path: ["confirmation"],
      message: t("auth.passwordMismatch"),
    });

const AuthFrame = ({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) => (
  <main className="grid min-h-screen place-items-center bg-slate-50 p-4">
    <Card className="w-full max-w-md p-6 sm:p-8">
      <div className="mb-4 flex items-center justify-end gap-2">
        <ThemeToggle />
        <LanguageSwitcher />
      </div>
      <div className="mb-6 flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-indigo-600 text-lg font-black text-white">
          {APP_MARK}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">
            {APP_NAME}
          </p>
          <h1 className="text-xl font-bold">{title}</h1>
          <p className="text-sm text-slate-500">{description}</p>
        </div>
      </div>
      {children}
    </Card>
  </main>
);

export function HomeRedirect() {
  const navigate = useNavigate();
  const { t } = useI18n();
  useEffect(() => {
    void (async () => {
      const setup = await api<{ state: string }>("/api/v1/setup/status");
      if (setup.state !== "complete")
        return navigate("/setup", { replace: true });
      try {
        await api("/api/v1/me");
        navigate("/app", { replace: true });
      } catch {
        navigate("/login", { replace: true });
      }
    })();
  }, [navigate]);
  return (
    <main className="grid min-h-screen place-items-center">
      <p className="text-sm text-slate-500">{t("auth.checking")}</p>
    </main>
  );
}

export function SetupPage() {
  const navigate = useNavigate();
  const { locale, t } = useI18n();
  const setupSchema = useMemo(() => createSetupSchema(t), [locale, t]);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Setup>({ resolver: zodResolver(setupSchema) });
  const submit = async (values: Setup) => {
    try {
      await api("/api/v1/setup/first-admin", {
        method: "POST",
        body: JSON.stringify(values),
      });
      toast.success(t("auth.setupSuccess"));
      navigate("/login", { replace: true });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("auth.setupFailure"),
      );
    }
  };
  return (
    <AuthFrame
      title={t("auth.setupTitle")}
      description={t("auth.setupDescription")}
    >
      <form className="space-y-4" onSubmit={handleSubmit(submit)}>
        <div>
          <Label htmlFor="name">{t("auth.name")}</Label>
          <Input id="name" autoComplete="name" {...register("name")} />
          <FieldError>{errors.name?.message}</FieldError>
        </div>
        <div>
          <Label htmlFor="email">{t("common.email")}</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            {...register("email")}
          />
          <FieldError>{errors.email?.message}</FieldError>
        </div>
        <div>
          <Label htmlFor="password">{t("auth.password")}</Label>
          <PasswordInput
            id="password"
            autoComplete="new-password"
            minLength={8}
            {...register("password")}
          />
          <FieldError>{errors.password?.message}</FieldError>
        </div>
        <div>
          <Label htmlFor="confirmation">{t("auth.confirmPassword")}</Label>
          <PasswordInput
            id="confirmation"
            autoComplete="new-password"
            minLength={8}
            {...register("confirmation")}
          />
          <FieldError>{errors.confirmation?.message}</FieldError>
        </div>
        <Button className="w-full" type="submit" busy={isSubmitting}>
          {t("auth.finishSetup")}
        </Button>
      </form>
    </AuthFrame>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Accept-Language": document.documentElement.lang,
        },
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      if (!response.ok) throw new Error(t("auth.invalidCredentials"));
      const requested = new URLSearchParams(location.search).get("returnTo");
      navigate(requested?.startsWith("/app") ? requested : "/app", {
        replace: true,
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("auth.signInFailure"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame
      title={t("auth.loginTitle")}
      description={t("auth.loginDescription")}
    >
      <form className="space-y-4" onSubmit={submit}>
        <div>
          <Label htmlFor="email">{t("common.email")}</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
          />
        </div>
        <div>
          <Label htmlFor="password">{t("auth.password")}</Label>
          <PasswordInput
            id="password"
            name="password"
            autoComplete="current-password"
            required
            minLength={8}
          />
        </div>
        {error && (
          <p
            className="rounded-xl bg-red-50 p-3 text-sm text-red-700"
            role="alert"
          >
            {error}
          </p>
        )}
        <Button className="w-full" type="submit" busy={busy}>
          {t("auth.signIn")}
        </Button>
      </form>
    </AuthFrame>
  );
}

export function AcceptInvitePage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [token] = useState(() => {
    const value =
      new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
    history.replaceState(null, "", location.pathname);
    return value;
  });
  const [invitation, setInvitation] = useState<{ email: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!token) {
      setError(t("auth.missingInvite"));
      return;
    }
    api<{ email: string }>(
      `/api/v1/invitations/inspect?token=${encodeURIComponent(token)}`,
    )
      .then(setInvitation)
      .catch((cause: ApiError) => setError(cause.message));
  }, [token]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/v1/invitations/accept", {
        method: "POST",
        body: JSON.stringify({
          token,
          name: form.get("name"),
          password: form.get("password"),
        }),
      });
      toast.success(t("auth.accountCreated"));
      navigate("/login");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("auth.acceptFailure"),
      );
    }
  };
  return (
    <AuthFrame
      title={t("auth.inviteTitle")}
      description={invitation ? invitation.email : t("auth.validatingInvite")}
    >
      {error ? (
        <p className="rounded-xl bg-red-50 p-4 text-sm text-red-700">{error}</p>
      ) : (
        invitation && (
          <form className="space-y-4" onSubmit={submit}>
            <div>
              <Label>{t("common.email")}</Label>
              <Input value={invitation.email} disabled />
            </div>
            <div>
              <Label htmlFor="name">{t("auth.name")}</Label>
              <Input id="name" name="name" required minLength={2} />
            </div>
            <div>
              <Label htmlFor="password">{t("auth.password")}</Label>
              <PasswordInput
                id="password"
                name="password"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </div>
            <Button className="w-full">{t("auth.createAccount")}</Button>
          </form>
        )
      )}
    </AuthFrame>
  );
}
