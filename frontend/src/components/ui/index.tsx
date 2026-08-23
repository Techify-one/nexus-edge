import {
  forwardRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { twMerge } from "tailwind-merge";
import { useI18n } from "../../i18n/index.js";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "danger" | "ghost";
    busy?: boolean;
  }
>(
  (
    { className, variant = "primary", busy, children, disabled, ...props },
    ref,
  ) => (
    <button
      ref={ref}
      disabled={disabled || busy}
      className={twMerge(
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-indigo-600 text-white hover:bg-indigo-700",
        variant === "secondary" &&
          "border bg-white text-slate-800 hover:bg-slate-50",
        variant === "danger" && "bg-red-600 text-white hover:bg-red-700",
        variant === "ghost" && "text-slate-600 hover:bg-slate-100",
        className,
      )}
      {...props}
    >
      {busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  ),
);
Button.displayName = "Button";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={twMerge(
      "min-h-11 w-full rounded-xl border bg-white px-3 text-sm shadow-sm placeholder:text-slate-400",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type">
>(({ className, ...props }, ref) => {
  const [visible, setVisible] = useState(false);
  const { t } = useI18n();
  return (
    <div className="relative">
      <Input
        ref={ref}
        type={visible ? "text" : "password"}
        className={twMerge("pr-11", className)}
        {...props}
      />
      <button
        type="button"
        className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-xl text-slate-500 hover:text-slate-800 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500"
        onClick={() => setVisible((current) => !current)}
        aria-label={t(visible ? "common.hidePassword" : "common.showPassword")}
        aria-pressed={visible}
      >
        {visible ? (
          <EyeOff className="h-5 w-5" aria-hidden />
        ) : (
          <Eye className="h-5 w-5" aria-hidden />
        )}
      </button>
    </div>
  );
});
PasswordInput.displayName = "PasswordInput";
export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={twMerge(
      "min-h-11 w-full rounded-xl border bg-white px-3 text-sm shadow-sm",
      className,
    )}
    {...props}
  />
));
Select.displayName = "Select";
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={twMerge(
      "min-h-28 w-full rounded-xl border bg-white p-3 text-sm shadow-sm",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
export const Label = ({
  children,
  htmlFor,
}: {
  children: ReactNode;
  htmlFor?: string;
}) => (
  <label
    htmlFor={htmlFor}
    className="mb-1.5 block text-sm font-medium text-slate-700"
  >
    {children}
  </label>
);
export const Card = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={twMerge("rounded-2xl border bg-white p-5 shadow-sm", className)}
    {...props}
  />
);
export const SingleLineFilterBar = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <Card className={twMerge("p-3", className)} {...props}>
    <div className="flex flex-nowrap gap-3 [&>*]:min-w-0 [&>*]:flex-1">
      {children}
    </div>
  </Card>
);
export const Badge = ({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}) => (
  <span
    className={twMerge(
      "inline-flex rounded-full px-2.5 py-1 text-xs font-semibold",
      tone === "neutral" && "bg-slate-100 text-slate-700",
      tone === "success" && "bg-emerald-50 text-emerald-700",
      tone === "warning" && "bg-amber-50 text-amber-700",
      tone === "danger" && "bg-red-50 text-red-700",
    )}
  >
    {children}
  </span>
);
export const FieldError = ({ children }: { children?: ReactNode }) =>
  children ? (
    <p className="mt-1 text-sm text-red-600" role="alert">
      {children}
    </p>
  ) : null;
export const EmptyState = ({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) => (
  <Card className="py-12 text-center">
    <h3 className="font-semibold">{title}</h3>
    <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
      {description}
    </p>
    {action && <div className="mt-5">{action}</div>}
  </Card>
);
export const PageHeader = ({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) => (
  <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
    <div>
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {description && (
        <p className="mt-1 text-sm text-slate-500">{description}</p>
      )}
    </div>
    {action}
  </div>
);
export const Skeleton = ({ className }: { className?: string }) => (
  <div
    className={twMerge("h-10 animate-pulse rounded-xl bg-slate-200", className)}
    aria-hidden
  />
);
