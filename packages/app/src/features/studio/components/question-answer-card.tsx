import { useId, useState } from "react";
import { ArrowUp, CheckCircle2, HelpCircle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StudioQuestionPrompt } from "../lib/types";

interface QuestionAnswerCardProps {
  prompt: StudioQuestionPrompt;
  answer?: string;
  busy: boolean;
  onAnswer: (answer: string) => Promise<void> | void;
}

/** Structured ask_user UI. Answers use Studio's ordinary chat path and resume the same conversation. */
export function QuestionAnswerCard({ prompt, answer: sentAnswer, busy, onAnswer }: QuestionAnswerCardProps) {
  const { t } = useTranslation("editor");
  const inputId = useId();
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const answered = sentAnswer !== undefined;
  const disabled = answered || busy || sending;
  const submit = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    setSending(true);
    try {
      await onAnswer(trimmed);
      setAnswer("");
    }
    finally { setSending(false); }
  };

  if (answered) return (
    <section className="mt-2 rounded-xl border border-primary/25 bg-primary/5 p-3" aria-label={t("studio.aiChat.questionAnswer.title", { defaultValue: "Answer Illumi" })}>
      <div className="flex items-start gap-2 text-xs font-medium text-foreground" role="status">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 whitespace-pre-wrap break-words">{t("studio.aiChat.questionAnswer.sent", { defaultValue: "Sent: {{answer}}", answer: sentAnswer })}</span>
      </div>
    </section>
  );

  return (
    <section className="mt-2 rounded-xl border border-primary/25 bg-primary/5 p-3" aria-label={t("studio.aiChat.questionAnswer.title", { defaultValue: "Answer Illumi" })}>
      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
        <HelpCircle className="h-4 w-4 text-primary" aria-hidden="true" />
        <span>{t("studio.aiChat.questionAnswer.choose", { defaultValue: "Choose an answer" })}</span>
      </div>
      {prompt.rationale && <p className="mt-1 text-[11px] text-muted-foreground">{prompt.rationale}</p>}
      {prompt.options.length > 0 && <div className="mt-2 grid gap-1.5">
        {prompt.options.map((option, index) => (
          <button key={`${index}:${option.label}`} type="button" disabled={disabled} onClick={() => void submit(option.label)}
            className="group flex min-h-10 items-start gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 py-2 text-left transition-colors hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-65">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-primary/35 text-[9px] text-primary">{index + 1}</span>
            <span className="min-w-0"><span className="block text-xs font-medium text-foreground">{option.label}</span>
              {option.description && <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">{option.description}</span>}</span>
          </button>
        ))}
      </div>}
      <form className="mt-2 flex items-end gap-1.5" onSubmit={event => { event.preventDefault(); void submit(answer); }}>
        <label className="sr-only" htmlFor={inputId}>
          {t("studio.aiChat.questionAnswer.customLabel", { defaultValue: "Write another answer" })}
        </label>
        <textarea id={inputId} value={answer} onChange={event => setAnswer(event.target.value)}
          disabled={disabled} rows={1} maxLength={2000} placeholder={t("studio.aiChat.questionAnswer.customPlaceholder", { defaultValue: "Or write your own answer…" })}
          className="min-h-9 flex-1 resize-y rounded-lg border border-border/70 bg-background/60 px-2.5 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" />
        <button type="submit" disabled={disabled || !answer.trim()} aria-label={t("studio.aiChat.questionAnswer.submit", { defaultValue: "Send answer" })}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40">
          {busy || sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
      </form>
    </section>
  );
}
