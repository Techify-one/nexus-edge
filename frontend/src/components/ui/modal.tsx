import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { twMerge } from "tailwind-merge";
import { useI18n } from "../../i18n/index.js";

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  contentClassName,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string | undefined;
  contentClassName?: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-[1px]" />
        <Dialog.Content
          className={twMerge(
            "fixed inset-x-3 bottom-3 top-auto z-50 max-h-[90vh] overflow-y-auto rounded-2xl border bg-white p-5 shadow-2xl sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:max-w-xl sm:-translate-x-1/2 sm:-translate-y-1/2",
            contentClassName,
          )}
        >
          <div className="mb-5 pr-10">
            <Dialog.Title className="text-xl font-bold">{title}</Dialog.Title>
            {description && (
              <Dialog.Description className="mt-1 text-sm text-slate-500">
                {description}
              </Dialog.Description>
            )}
          </div>
          {children}
          <Dialog.Close
            className="absolute right-4 top-4 rounded-lg p-2 text-slate-500 hover:bg-slate-100"
            aria-label={t("common.close")}
          >
            <X className="h-5 w-5" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
