import {
  type McpElicitationField,
  type McpElicitationPrompt,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import {
  type McpElicitationDraft,
  type McpElicitationDraftValue,
  mcpElicitationContentFromDraft,
  mcpElicitationDraftDefaults,
  validateMcpElicitationContent,
} from "@t3tools/shared/mcpElicitation";
import { ExternalLinkIcon } from "lucide-react";
import { memo, useId, useMemo, useState } from "react";
import { readLocalApi } from "~/localApi";
import { type PendingApproval } from "../../session-logic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerMcpElicitationPanelProps {
  approval: PendingApproval;
  elicitation: McpElicitationPrompt;
  pendingCount: number;
  isResponding: boolean;
  canRespond: boolean;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
    answers?: ProviderUserInputAnswers,
  ) => Promise<unknown>;
}

const STRING_INPUT_TYPES = {
  email: "email",
  uri: "url",
  date: "date",
  "date-time": "datetime-local",
} as const;

function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * An MCP server asking the user to fill a form or finish a page out of band.
 * The server is named up front because accepting can authorize destructive work.
 */
export const ComposerMcpElicitationPanel = memo(function ComposerMcpElicitationPanel({
  approval,
  elicitation,
  pendingCount,
  isResponding,
  canRespond,
  onRespondToApproval,
}: ComposerMcpElicitationPanelProps) {
  const fields = elicitation.mode === "form" ? elicitation.fields : [];
  const [draft, setDraft] = useState<McpElicitationDraft>(() =>
    mcpElicitationDraftDefaults(fields),
  );
  const [showErrors, setShowErrors] = useState(false);
  const content = useMemo(() => mcpElicitationContentFromDraft(fields, draft), [fields, draft]);
  const validation = useMemo(
    () => validateMcpElicitationContent(fields, content),
    [fields, content],
  );
  const errors = showErrors && !validation.ok ? validation.errors : {};
  const disabled = isResponding || !canRespond;
  const serverLabel = approval.appName ?? elicitation.serverName;
  const acceptLabel =
    approval.options?.find((option) => option.decision === "accept")?.label ??
    (elicitation.mode === "url" ? "I've completed it" : "Submit");

  const setValue = (key: string, value: McpElicitationDraftValue) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const accept = () => {
    if (elicitation.mode === "url") {
      void onRespondToApproval(approval.requestId, "accept");
      return;
    }
    if (!validation.ok) {
      setShowErrors(true);
      return;
    }
    void onRespondToApproval(approval.requestId, "accept", validation.content);
  };

  return (
    <div
      aria-label={`Request from ${serverLabel}`}
      className="flex min-w-0 flex-1 flex-col gap-2"
      role="group"
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="shrink-0 font-medium text-warning">MCP request</span>
        <span className="min-w-0 truncate font-medium text-foreground">{serverLabel}</span>
        {serverLabel !== elicitation.serverName ? (
          <span className="min-w-0 truncate">({elicitation.serverName})</span>
        ) : null}
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">1/{pendingCount}</span>
        ) : null}
      </span>
      <p className="max-h-32 overflow-auto whitespace-pre-wrap text-xs text-foreground wrap-break-word">
        {approval.responseCapability === "not_resumable"
          ? "Provider process is gone — interrupt or restart the run to respond."
          : elicitation.message}
      </p>
      {elicitation.mode === "url" ? (
        <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border p-2">
          <span className="text-xs text-muted-foreground">
            Opens <span className="font-medium text-foreground">{urlHost(elicitation.url)}</span>
          </span>
          <code className="block max-h-16 overflow-auto font-mono text-2xs break-all text-foreground">
            {elicitation.url}
          </code>
          <div>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => void readLocalApi()?.shell.openExternal(elicitation.url)}
            >
              <ExternalLinkIcon className="size-3" />
              Open in browser
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex max-h-64 min-w-0 flex-col gap-2 overflow-auto">
          {fields.map((field) => (
            <McpElicitationFieldInput
              key={field.key}
              field={field}
              value={draft[field.key]}
              error={errors[field.key]}
              disabled={disabled}
              onChange={(value) => setValue(field.key, value)}
            />
          ))}
          {errors[""] ? <span className="text-2xs text-destructive">{errors[""]}</span> : null}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={() => void onRespondToApproval(approval.requestId, "cancel")}
        >
          Cancel
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => void onRespondToApproval(approval.requestId, "decline")}
        >
          Decline
        </Button>
        <Button size="xs" variant="default" disabled={disabled} onClick={accept}>
          {acceptLabel}
        </Button>
      </div>
    </div>
  );
});

function McpElicitationFieldInput({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: McpElicitationField;
  value: McpElicitationDraftValue | undefined;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: McpElicitationDraftValue) => void;
}) {
  const id = useId();
  const label = (
    <span className="text-xs font-medium text-foreground">
      {field.title ?? field.key}
      {field.required ? <span className="text-destructive"> *</span> : null}
    </span>
  );
  const description = field.description ? (
    <span className="text-2xs text-muted-foreground">{field.description}</span>
  ) : null;
  const errorText = error ? (
    <span id={`${id}-error`} className="text-2xs text-destructive">
      {error}
    </span>
  ) : null;
  const invalidProps = error
    ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` }
    : {};

  if (field.type === "boolean") {
    return (
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="flex items-center gap-2">
          <Checkbox
            id={id}
            checked={value === true}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(checked === true)}
            {...invalidProps}
          />
          {label}
        </label>
        {description}
        {errorText}
      </div>
    );
  }

  if (field.type === "multi_enum") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset className="flex flex-col gap-1" {...invalidProps}>
        <legend>{label}</legend>
        {description}
        {field.options.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={selected.includes(option.value)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange(
                  checked === true
                    ? [...selected, option.value]
                    : selected.filter((entry) => entry !== option.value),
                )
              }
            />
            {option.label}
          </label>
        ))}
        {errorText}
      </fieldset>
    );
  }

  if (field.type === "enum") {
    const current = typeof value === "string" && value !== "" ? value : null;
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={id}>{label}</label>
        {description}
        <Select
          value={current}
          disabled={disabled}
          onValueChange={(next) => onChange(typeof next === "string" ? next : "")}
        >
          <SelectTrigger id={id} size="sm" className="w-full sm:w-64" {...invalidProps}>
            <SelectValue>
              {(selectedValue: string | null) =>
                field.options.find((option) => option.value === selectedValue)?.label ?? "Choose…"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup {...composerFloatingLayerProps} alignItemWithTrigger={false}>
            {field.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {errorText}
      </div>
    );
  }

  const isNumber = field.type === "number" || field.type === "integer";
  const inputType = isNumber
    ? "number"
    : field.type === "string" && field.format
      ? STRING_INPUT_TYPES[field.format]
      : "text";
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id}>{label}</label>
      {description}
      <Input
        id={id}
        size="sm"
        type={inputType}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        required={field.required}
        className="w-full"
        {...(isNumber
          ? {
              step: field.type === "integer" ? 1 : "any",
              ...(field.minimum === undefined ? {} : { min: field.minimum }),
              ...(field.maximum === undefined ? {} : { max: field.maximum }),
            }
          : {})}
        {...(field.type === "string" && field.maxLength !== undefined
          ? { maxLength: field.maxLength }
          : {})}
        onChange={(event) => onChange(event.currentTarget.value)}
        {...invalidProps}
      />
      {errorText}
    </div>
  );
}
