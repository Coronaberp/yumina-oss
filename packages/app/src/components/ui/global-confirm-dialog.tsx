import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

interface ConfirmRequest {
  description: string;
  title?: string;
  confirmLabel?: string;
  tone?: "destructive" | "warning";
}

interface ConfirmState {
  request: ConfirmRequest | null;
  resolve: ((value: boolean) => void) | null;
}

const useGlobalConfirmStore = create<ConfirmState>(() => ({
  request: null,
  resolve: null,
}));

interface PromptState {
  request: { description: string; value: string } | null;
  resolve: ((value: string | null) => void) | null;
}
const useGlobalPromptStore = create<PromptState>(() => ({ request: null, resolve: null }));

// eslint-disable-next-line react-refresh/only-export-components -- Imperative actions share the global dialog host's store.
export function promptAction(description: string, initialValue = ""): Promise<string | null> {
  return new Promise(resolve => {
    useGlobalPromptStore.getState().resolve?.(null);
    useGlobalPromptStore.setState({ request: { description, value: initialValue }, resolve });
  });
}

function GlobalPromptDialog() {
  const { t } = useTranslation();
  const request = useGlobalPromptStore(state => state.request);
  const settle = (value: string | null) => {
    const resolve = useGlobalPromptStore.getState().resolve;
    useGlobalPromptStore.setState({ request: null, resolve: null });
    resolve?.(value);
  };
  return <Dialog open={request !== null} onOpenChange={open => { if (!open) settle(null); }}>
    <DialogContent mobileSheet>
      <form className="space-y-5" onSubmit={event => { event.preventDefault(); settle(request?.value ?? ""); }}>
        <DialogHeader><DialogTitle>{t("action.edit")}</DialogTitle><DialogDescription>{request?.description}</DialogDescription></DialogHeader>
        <input autoFocus aria-label={request?.description} value={request?.value ?? ""}
          onFocus={event => event.target.select()}
          onChange={event => { if (request) useGlobalPromptStore.setState({ request: { ...request, value: event.target.value } }); }}
          className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary" />
        <DialogFooter>
          <button type="button" onClick={() => settle(null)} className="min-h-11 rounded-lg border border-border px-4 text-sm">{t("action.cancel")}</button>
          <button type="submit" className="min-h-11 rounded-lg bg-primary px-4 text-sm text-primary-foreground">{t("action.confirm")}</button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

// eslint-disable-next-line react-refresh/only-export-components -- Imperative actions share the global dialog host's store.
export function confirmAction(
  description: string,
  options: Omit<ConfirmRequest, "description"> = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = useGlobalConfirmStore.getState().resolve;
    previous?.(false);
    useGlobalConfirmStore.setState({
      request: { description, ...options },
      resolve,
    });
  });
}

export function GlobalConfirmDialog() {
  const { t } = useTranslation();
  const request = useGlobalConfirmStore((state) => state.request);

  const settle = (value: boolean) => {
    const resolve = useGlobalConfirmStore.getState().resolve;
    useGlobalConfirmStore.setState({ request: null, resolve: null });
    resolve?.(value);
  };

  return (
    <><GlobalPromptDialog /><ConfirmDialog
      open={request !== null}
      onOpenChange={(open) => { if (!open) settle(false); }}
      title={request?.title ?? t("action.confirm")}
      description={request?.description}
      confirmLabel={request?.confirmLabel ?? (request?.tone === "destructive" ? t("action.delete") : t("action.confirm"))}
      cancelLabel={t("action.cancel")}
      onConfirm={() => settle(true)}
      tone={request?.tone ?? "warning"}
    /></>
  );
}
