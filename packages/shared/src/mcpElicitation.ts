import type { McpElicitationChoice, McpElicitationField } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * MCP elicitation forms (spec 2025-11-25) restrict `requestedSchema` to a flat
 * object of primitives. Clients render the normalized fields; the server and
 * the provider adapter validate accepted content with the same rules, so a
 * value the form would reject never reaches the MCP server.
 */
export type McpElicitationSchemaParseResult =
  | { readonly type: "fields"; readonly fields: ReadonlyArray<McpElicitationField> }
  | { readonly type: "unsupported"; readonly reason: string };

export type McpElicitationContentValue = string | number | boolean | ReadonlyArray<string>;
export type McpElicitationContent = Readonly<Record<string, McpElicitationContentValue>>;

export type McpElicitationValidationResult =
  | { readonly ok: true; readonly content: McpElicitationContent }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/** Editable form state: text inputs keep strings until the content is built. */
export type McpElicitationDraftValue = string | boolean | ReadonlyArray<string>;
export type McpElicitationDraft = Readonly<Record<string, McpElicitationDraftValue>>;

const ROOT_KEYS = new Set(["$schema", "type", "properties", "required", "title", "description"]);
const COMMON_KEYS = ["type", "title", "description", "default"];
const STRING_FORMATS = new Set(["email", "uri", "date", "date-time"]);

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

class UnsupportedSchema extends Error {}

const unsupported = (reason: string): never => {
  throw new UnsupportedSchema(reason);
};

function assertKeys(key: string, field: JsonObject, allowed: ReadonlyArray<string>) {
  for (const name of Object.keys(field)) {
    if (!allowed.includes(name)) unsupported(`Field "${key}" uses unsupported keyword "${name}".`);
  }
}

function optionalNumber(key: string, field: JsonObject, name: string): number | undefined {
  const value = field[name];
  if (value === undefined) return undefined;
  if (!isFiniteNumber(value)) unsupported(`Field "${key}" has an invalid ${name}.`);
  return value as number;
}

function optionalText(field: JsonObject, name: "title" | "description") {
  const value = field[name];
  return typeof value === "string" && value.length > 0 ? { [name]: value } : {};
}

/** Reads enum/enumNames/oneOf (or items.anyOf) into choices; undefined when none. */
function readChoices(
  key: string,
  field: JsonObject,
): ReadonlyArray<McpElicitationChoice> | undefined {
  const { enum: enumValues, enumNames, oneOf, anyOf } = field;
  const titled = oneOf ?? anyOf;
  if (enumValues === undefined && titled === undefined) return undefined;
  if (enumValues !== undefined && !isStringArray(enumValues)) {
    unsupported(`Field "${key}" has non-string choices.`);
  }
  if (enumNames !== undefined) {
    if (
      !isStringArray(enumNames) ||
      !isStringArray(enumValues) ||
      enumNames.length !== enumValues.length
    ) {
      unsupported(`Field "${key}" has mismatched choice names.`);
    }
  }
  let choices: McpElicitationChoice[];
  if (titled !== undefined) {
    if (!Array.isArray(titled)) unsupported(`Field "${key}" has invalid titled choices.`);
    choices = (titled as unknown[]).map((option) => {
      if (
        !isObject(option) ||
        typeof option.const !== "string" ||
        Object.keys(option).some((name) => name !== "const" && name !== "title") ||
        (option.title !== undefined && typeof option.title !== "string")
      ) {
        return unsupported(`Field "${key}" has an invalid titled choice.`);
      }
      return { value: option.const, label: (option.title as string | undefined) ?? option.const };
    });
    if (isStringArray(enumValues)) {
      choices = choices.filter((choice) => enumValues.includes(choice.value));
    }
  } else {
    const values = enumValues as ReadonlyArray<string>;
    const names = enumNames as ReadonlyArray<string> | undefined;
    choices = values.map((value, index) => ({ value, label: names?.[index] ?? value }));
  }
  if (choices.length === 0) unsupported(`Field "${key}" offers no choices.`);
  return choices;
}

/**
 * Servers often omit `type` or send `default: null`. A null default is no
 * default, and an untyped field takes its type from the default, else text.
 */
function normalizeLooseField(raw: JsonObject): JsonObject {
  const { default: fieldDefault, ...rest } = raw;
  const field = fieldDefault === null ? rest : raw;
  if (field.type !== undefined || field.enum !== undefined || field.oneOf !== undefined) {
    return field;
  }
  const inferred =
    typeof field.default === "boolean"
      ? "boolean"
      : typeof field.default === "number"
        ? "number"
        : "string";
  return { ...field, type: inferred };
}

function parseField(key: string, input: unknown, required: boolean): McpElicitationField {
  if (!isObject(input)) return unsupported(`Field "${key}" is not a schema object.`);
  const raw = normalizeLooseField(input);
  const base = {
    key,
    ...optionalText(raw, "title"),
    ...optionalText(raw, "description"),
    required,
  };
  const fieldDefault = raw.default;

  if (raw.type === "array") {
    assertKeys(key, raw, [...COMMON_KEYS, "items", "minItems", "maxItems", "uniqueItems"]);
    const items = raw.items;
    if (!isObject(items) || (items.type !== undefined && items.type !== "string")) {
      return unsupported(`Field "${key}" is an array that is not a list of choices.`);
    }
    assertKeys(key, items, ["type", "enum", "enumNames", "anyOf", "oneOf"]);
    const options = readChoices(key, items);
    if (options === undefined) return unsupported(`Field "${key}" is a list without choices.`);
    if (
      fieldDefault !== undefined &&
      (!isStringArray(fieldDefault) ||
        fieldDefault.some((value) => !options.some((option) => option.value === value)))
    ) {
      return unsupported(`Field "${key}" has an invalid default.`);
    }
    const minItems = optionalNumber(key, raw, "minItems");
    const maxItems = optionalNumber(key, raw, "maxItems");
    return {
      ...base,
      type: "multi_enum",
      options,
      ...(minItems === undefined ? {} : { minItems }),
      ...(maxItems === undefined ? {} : { maxItems }),
      ...(fieldDefault === undefined ? {} : { default: fieldDefault as ReadonlyArray<string> }),
    };
  }

  if (raw.enum !== undefined || raw.oneOf !== undefined) {
    if (raw.type !== undefined && raw.type !== "string") {
      return unsupported(`Field "${key}" has non-string choices.`);
    }
    assertKeys(key, raw, [...COMMON_KEYS, "enum", "enumNames", "oneOf"]);
    const options = readChoices(key, raw)!;
    if (
      fieldDefault !== undefined &&
      (typeof fieldDefault !== "string" || !options.some((option) => option.value === fieldDefault))
    ) {
      return unsupported(`Field "${key}" has an invalid default.`);
    }
    return {
      ...base,
      type: "enum",
      options,
      ...(fieldDefault === undefined ? {} : { default: fieldDefault as string }),
    };
  }

  switch (raw.type) {
    case "boolean": {
      assertKeys(key, raw, COMMON_KEYS);
      if (fieldDefault !== undefined && typeof fieldDefault !== "boolean") {
        return unsupported(`Field "${key}" has an invalid default.`);
      }
      return {
        ...base,
        type: "boolean",
        ...(fieldDefault === undefined ? {} : { default: fieldDefault as boolean }),
      };
    }
    case "string": {
      assertKeys(key, raw, [...COMMON_KEYS, "minLength", "maxLength", "format"]);
      const format = raw.format;
      if (format !== undefined && (typeof format !== "string" || !STRING_FORMATS.has(format))) {
        return unsupported(`Field "${key}" uses unsupported format "${String(format)}".`);
      }
      const minLength = optionalNumber(key, raw, "minLength");
      const maxLength = optionalNumber(key, raw, "maxLength");
      const field: McpElicitationField = {
        ...base,
        type: "string",
        ...(minLength === undefined ? {} : { minLength }),
        ...(maxLength === undefined ? {} : { maxLength }),
        ...(format === undefined
          ? {}
          : { format: format as "email" | "uri" | "date" | "date-time" }),
      };
      if (fieldDefault !== undefined) {
        if (typeof fieldDefault !== "string" || validateField(field, fieldDefault) !== null) {
          return unsupported(`Field "${key}" has an invalid default.`);
        }
        return { ...field, default: fieldDefault };
      }
      return field;
    }
    case "number":
    case "integer": {
      assertKeys(key, raw, [...COMMON_KEYS, "minimum", "maximum"]);
      const minimum = optionalNumber(key, raw, "minimum");
      const maximum = optionalNumber(key, raw, "maximum");
      const field: McpElicitationField = {
        ...base,
        type: raw.type,
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
      };
      if (fieldDefault !== undefined) {
        if (validateField(field, fieldDefault) !== null) {
          return unsupported(`Field "${key}" has an invalid default.`);
        }
        return { ...field, default: fieldDefault as number };
      }
      return field;
    }
    default:
      return unsupported(`Field "${key}" has unsupported type "${String(raw.type)}".`);
  }
}

/** Normalizes an MCP `requestedSchema` into renderable fields, or says why it cannot. */
export function parseMcpElicitationSchema(
  requestedSchema: unknown,
): McpElicitationSchemaParseResult {
  if (requestedSchema === undefined) return { type: "fields", fields: [] };
  try {
    if (!isObject(requestedSchema)) unsupported("The requested schema is not an object.");
    const schema = requestedSchema as JsonObject;
    for (const name of Object.keys(schema)) {
      if (!ROOT_KEYS.has(name))
        unsupported(`The requested schema uses unsupported keyword "${name}".`);
    }
    if (schema.type !== undefined && schema.type !== "object") {
      unsupported("The requested schema is not an object schema.");
    }
    const properties = schema.properties ?? {};
    if (!isObject(properties)) unsupported("The requested schema has invalid properties.");
    const required = schema.required ?? [];
    if (!isStringArray(required)) unsupported("The requested schema has an invalid required list.");
    const propertyMap = properties as JsonObject;
    for (const key of required as ReadonlyArray<string>) {
      if (!Object.hasOwn(propertyMap, key)) unsupported(`Required field "${key}" is not defined.`);
    }
    const fields = Object.entries(propertyMap).map(([key, raw]) =>
      parseField(key, raw, (required as ReadonlyArray<string>).includes(key)),
    );
    return { type: "fields", fields };
  } catch (error) {
    if (error instanceof UnsupportedSchema) return { type: "unsupported", reason: error.message };
    throw error;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

function isValidDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return daysInMonth !== undefined && day >= 1 && day <= daysInMonth;
}

function validateField(field: McpElicitationField, value: unknown): string | null {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "Must be true or false.";
    case "string": {
      if (typeof value !== "string") return "Must be text.";
      const length = [...value].length;
      if (field.minLength !== undefined && length < field.minLength) {
        return `Must be at least ${field.minLength} characters.`;
      }
      if (field.maxLength !== undefined && length > field.maxLength) {
        return `Must be at most ${field.maxLength} characters.`;
      }
      if (field.format === "email" && !EMAIL.test(value)) return "Must be an email address.";
      if (field.format === "uri" && !URL.canParse(value)) return "Must be a URL.";
      if (field.format === "date" && !isValidDate(value)) return "Must be a date (YYYY-MM-DD).";
      if (
        field.format === "date-time" &&
        (!DATE_TIME.test(value) || Option.isNone(DateTime.make(value)))
      ) {
        return "Must be a date and time.";
      }
      return null;
    }
    case "number":
    case "integer": {
      if (!isFiniteNumber(value)) return "Must be a number.";
      if (field.type === "integer" && !Number.isInteger(value)) return "Must be a whole number.";
      if (field.minimum !== undefined && value < field.minimum) {
        return `Must be at least ${field.minimum}.`;
      }
      if (field.maximum !== undefined && value > field.maximum) {
        return `Must be at most ${field.maximum}.`;
      }
      return null;
    }
    case "enum":
      return typeof value === "string" && field.options.some((option) => option.value === value)
        ? null
        : "Choose one of the listed options.";
    case "multi_enum": {
      if (
        !isStringArray(value) ||
        new Set(value).size !== value.length ||
        value.some((entry) => !field.options.some((option) => option.value === entry))
      ) {
        return "Choose from the listed options.";
      }
      if (field.minItems !== undefined && value.length < field.minItems) {
        return `Choose at least ${field.minItems}.`;
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        return `Choose at most ${field.maxItems}.`;
      }
      return null;
    }
  }
}

/** Checks accepted content against the normalized fields, rejecting unknown keys. */
export function validateMcpElicitationContent(
  fields: ReadonlyArray<McpElicitationField>,
  content: unknown,
): McpElicitationValidationResult {
  if (!isObject(content)) return { ok: false, errors: { "": "Content must be an object." } };
  const errors: Record<string, string> = {};
  const accepted: Record<string, McpElicitationContentValue> = {};
  for (const field of fields) {
    if (!Object.hasOwn(content, field.key) || content[field.key] === undefined) {
      if (field.required) errors[field.key] = "Required.";
      continue;
    }
    const value = content[field.key];
    const error = validateField(field, value);
    if (error === null) accepted[field.key] = value as McpElicitationContentValue;
    else errors[field.key] = error;
  }
  for (const key of Object.keys(content)) {
    if (!fields.some((field) => field.key === key)) errors[key] = "Unexpected field.";
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, content: accepted };
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * A browser date-time input shows only zone-less local values, so a zoned
 * default is converted to local time; submitting converts it back to the
 * same instant.
 */
function localDateTimeInputValue(value: string): string {
  const parsed = DateTime.make(value);
  if (Option.isNone(parsed)) return value;
  const parts = DateTime.toParts(DateTime.setZone(parsed.value, DateTime.zoneMakeLocal()));
  const date = `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}`;
  const time = `${pad(parts.hour)}:${pad(parts.minute)}`;
  if (parts.millisecond !== 0) {
    return `${date}T${time}:${pad(parts.second)}.${String(parts.millisecond).padStart(3, "0")}`;
  }
  return parts.second === 0 ? `${date}T${time}` : `${date}T${time}:${pad(parts.second)}`;
}

/** The initial form state, prefilled with schema defaults. */
export function mcpElicitationDraftDefaults(
  fields: ReadonlyArray<McpElicitationField>,
): McpElicitationDraft {
  const draft: Record<string, McpElicitationDraftValue> = {};
  for (const field of fields) {
    switch (field.type) {
      case "boolean":
        draft[field.key] = field.default ?? false;
        break;
      case "multi_enum":
        draft[field.key] = field.default ?? [];
        break;
      case "number":
      case "integer":
        draft[field.key] = field.default === undefined ? "" : String(field.default);
        break;
      default:
        draft[field.key] =
          field.type === "string" && field.format === "date-time" && field.default !== undefined
            ? localDateTimeInputValue(field.default)
            : (field.default ?? "");
    }
  }
  return draft;
}

/**
 * Types a form draft for submission: numbers are parsed, local date-times
 * become ISO instants, and blank optional inputs are left out.
 */
export function mcpElicitationContentFromDraft(
  fields: ReadonlyArray<McpElicitationField>,
  draft: McpElicitationDraft,
): Record<string, McpElicitationContentValue> {
  const content: Record<string, McpElicitationContentValue> = {};
  for (const field of fields) {
    const value = draft[field.key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0 || field.required) content[field.key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      content[field.key] = value;
      continue;
    }
    const text = value as string;
    if (field.type === "number" || field.type === "integer") {
      const trimmed = text.trim();
      if (trimmed === "") continue;
      const parsed = Number(trimmed);
      content[field.key] = Number.isFinite(parsed) ? parsed : text;
      continue;
    }
    if (text === "") continue;
    if (field.type === "string" && field.format === "date-time" && !DATE_TIME.test(text)) {
      // A browser date-time input has no zone; it is the user's local time.
      const parsed = DateTime.makeZoned(text, {
        timeZone: DateTime.zoneMakeLocal(),
        adjustForTimeZone: true,
      });
      content[field.key] = Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : text;
      continue;
    }
    content[field.key] = text;
  }
  return content;
}
