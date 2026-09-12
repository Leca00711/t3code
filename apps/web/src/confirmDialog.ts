import type { ConfirmDialogOptions, ConfirmDialogVariant } from "@t3tools/contracts";

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | {
      readonly status: "confirming";
      readonly title: string;
      readonly description: string | null;
      readonly confirmLabel: string;
      readonly cancelLabel: string;
      readonly variant: ConfirmDialogVariant;
    }
  | {
      readonly status: "closing";
      readonly title: string;
      readonly description: string | null;
      readonly confirmLabel: string;
      readonly cancelLabel: string;
      readonly variant: ConfirmDialogVariant;
    };

type ConfirmationCopy = {
  readonly title: string;
  readonly description: string | null;
};

const defaultConfirmLabel = "Confirm";
const defaultCancelLabel = "Cancel";

type PendingConfirmation = {
  readonly copy: ConfirmationCopy;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly variant: ConfirmDialogVariant;
  readonly resolve: (confirmed: boolean) => void;
};

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
let registeredHostCount = 0;
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Fallback adapter: callers that do not state a title keep encoding the split
 * in the message itself. The three rules below are unchanged.
 */
function resolveConfirmDialogCopy(message: string): ConfirmationCopy {
  const normalizedMessage = message.trim();
  const lines = normalizedMessage.split("\n");
  const questionLineIndex = lines.findIndex((line) => line.trim().endsWith("?"));

  if (questionLineIndex >= 0) {
    const title = lines[questionLineIndex]!.trim();
    const description = lines
      .filter((_, index) => index !== questionLineIndex)
      .join("\n")
      .trim();
    return { title, description: description || null };
  }

  const questionMarkIndex = normalizedMessage.indexOf("?");
  if (questionMarkIndex >= 0) {
    return {
      title: normalizedMessage.slice(0, questionMarkIndex + 1).trim(),
      description: normalizedMessage.slice(questionMarkIndex + 1).trim() || null,
    };
  }

  return {
    title: "Confirm action",
    description: normalizedMessage || "This action requires your confirmation.",
  };
}

function resolveConfirmationCopy(
  message: string,
  options?: ConfirmDialogOptions,
): ConfirmationCopy {
  const heuristic = resolveConfirmDialogCopy(message);
  return {
    title: options?.title ?? heuristic.title,
    description: heuristic.description,
  };
}

function resolvePendingConfirmations(confirmed: boolean): void {
  activeConfirmation?.resolve(confirmed);
  for (const confirmation of queuedConfirmations) {
    confirmation.resolve(confirmed);
  }
  activeConfirmation = null;
  queuedConfirmations = [];
}

export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

export function subscribeConfirmDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Registers the renderer host that can present themed confirmations. The
 * returned cleanup function also cancels any request left without a host.
 */
export function registerConfirmDialogHost(): () => void {
  registeredHostCount += 1;
  let registered = true;

  return () => {
    if (!registered) return;
    registered = false;
    registeredHostCount = Math.max(0, registeredHostCount - 1);

    if (registeredHostCount === 0) {
      resolvePendingConfirmations(false);
      publish(idleState);
    }
  };
}

/**
 * Requests a themed confirmation when a host is mounted. An undefined result
 * means no themed host is currently available.
 */
export function requestConfirmDialog(
  message: string,
  options?: ConfirmDialogOptions,
): Promise<boolean> | undefined {
  if (registeredHostCount === 0) return undefined;

  const confirmation = new Promise<boolean>((resolve) => {
    const pending = {
      copy: resolveConfirmationCopy(message, options),
      confirmLabel: options?.confirmLabel ?? defaultConfirmLabel,
      cancelLabel: options?.cancelLabel ?? defaultCancelLabel,
      variant: options?.variant ?? "default",
      resolve,
    } satisfies PendingConfirmation;
    if (activeConfirmation || state.status === "closing") {
      queuedConfirmations.push(pending);
      return;
    }

    activeConfirmation = pending;
    publish({
      status: "confirming",
      title: pending.copy.title,
      description: pending.copy.description,
      confirmLabel: pending.confirmLabel,
      cancelLabel: pending.cancelLabel,
      variant: pending.variant,
    });
  });

  return confirmation;
}

export function respondToConfirmDialog(confirmed: boolean): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  confirmation.resolve(confirmed);
  publish({
    status: "closing",
    title: state.title,
    description: state.description,
    confirmLabel: state.confirmLabel,
    cancelLabel: state.cancelLabel,
    variant: state.variant,
  });
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedConfirmations.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  activeConfirmation = next;
  publish({
    status: "confirming",
    title: next.copy.title,
    description: next.copy.description,
    confirmLabel: next.confirmLabel,
    cancelLabel: next.cancelLabel,
    variant: next.variant,
  });
}

export function resetConfirmDialogForTests(): void {
  resolvePendingConfirmations(false);
  registeredHostCount = 0;
  publish(idleState);
  listeners.clear();
}
