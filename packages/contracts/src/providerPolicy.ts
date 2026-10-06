import {
  ChatImageAttachment,
  ChatFileAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "./chatAttachment.ts";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;

export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";

export const ProviderRequestKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;

export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;

export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;

export const ProviderApprovalOption = Schema.Struct({
  decision: ProviderApprovalDecision,
  label: TrimmedNonEmptyString,
  /** Provider-supplied caution shown next to the option, such as a prompt injection warning. */
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderApprovalOption = typeof ProviderApprovalOption.Type;

const McpElicitationFieldBaseFields = {
  /** Property name in the MCP `requestedSchema`; the key of the accepted content. */
  key: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  required: Schema.Boolean,
};

export const McpElicitationChoice = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
});
export type McpElicitationChoice = typeof McpElicitationChoice.Type;

/** One MCP elicitation primitive, normalized from the server's `requestedSchema`. */
export const McpElicitationField = Schema.Union([
  Schema.Struct({
    ...McpElicitationFieldBaseFields,
    type: Schema.Literal("boolean"),
    default: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    ...McpElicitationFieldBaseFields,
    type: Schema.Literal("string"),
    minLength: Schema.optional(Schema.Number),
    maxLength: Schema.optional(Schema.Number),
    format: Schema.optional(Schema.Literals(["email", "uri", "date", "date-time"])),
    default: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...McpElicitationFieldBaseFields,
    type: Schema.Literals(["number", "integer"]),
    minimum: Schema.optional(Schema.Number),
    maximum: Schema.optional(Schema.Number),
    default: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    ...McpElicitationFieldBaseFields,
    type: Schema.Literal("enum"),
    options: Schema.Array(McpElicitationChoice),
    default: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...McpElicitationFieldBaseFields,
    type: Schema.Literal("multi_enum"),
    options: Schema.Array(McpElicitationChoice),
    minItems: Schema.optional(Schema.Number),
    maxItems: Schema.optional(Schema.Number),
    default: Schema.optional(Schema.Array(Schema.String)),
  }),
]);
export type McpElicitationField = typeof McpElicitationField.Type;

/**
 * What an MCP server asks the user for. Form mode carries the fields to fill;
 * URL mode carries the page the user completes out of band.
 */
export const McpElicitationPrompt = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("form"),
    serverName: Schema.String,
    message: Schema.String,
    fields: Schema.Array(McpElicitationField),
  }),
  Schema.Struct({
    mode: Schema.Literal("url"),
    serverName: Schema.String,
    message: Schema.String,
    url: Schema.String,
  }),
]);
export type McpElicitationPrompt = typeof McpElicitationPrompt.Type;

export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const UserInputAttachments = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Union([ChatImageAttachment, ChatFileAttachment])).pipe(
    Schema.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
);
export type UserInputAttachments = typeof UserInputAttachments.Type;

export const UserInputAttachmentAnswerPayload = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  questionTextById: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: UserInputAttachments,
});
export type UserInputAttachmentAnswerPayload = typeof UserInputAttachmentAnswerPayload.Type;
