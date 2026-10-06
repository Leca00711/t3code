import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  mcpElicitationContentFromDraft,
  mcpElicitationDraftDefaults,
  parseMcpElicitationSchema,
  validateMcpElicitationContent,
} from "./mcpElicitation.ts";

const objectSchema = (properties: Record<string, unknown>, required?: ReadonlyArray<unknown>) => ({
  type: "object",
  properties,
  ...(required === undefined ? {} : { required }),
});

const parsedFields = (requestedSchema: unknown) => {
  const parsed = parseMcpElicitationSchema(requestedSchema);
  if (parsed.type !== "fields") throw new Error(`Expected fields, got: ${parsed.reason}`);
  return parsed.fields;
};

describe("parseMcpElicitationSchema", () => {
  it("normalizes every MCP primitive the spec allows", () => {
    expect(
      parsedFields({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...objectSchema(
          {
            confirm: { type: "boolean", title: "Run it?", default: false },
            email: {
              type: "string",
              description: "Contact",
              format: "email",
              minLength: 3,
              maxLength: 80,
            },
            count: { type: "integer", minimum: 1, maximum: 5, default: 2 },
            ratio: { type: "number" },
            plan: { type: "string", enum: ["free", "pro"], default: "pro" },
            legacy: { type: "string", enum: ["a", "b"], enumNames: ["Option A", "Option B"] },
            titled: { type: "string", oneOf: [{ const: "x", title: "Ex" }, { const: "y" }] },
            tags: {
              type: "array",
              items: { type: "string", enum: ["red", "blue"] },
              minItems: 1,
              maxItems: 2,
              default: ["red"],
            },
            titledTags: {
              type: "array",
              items: { anyOf: [{ const: "s", title: "Small" }] },
            },
          },
          ["confirm", "email"],
        ),
      }),
    ).toEqual([
      { key: "confirm", type: "boolean", title: "Run it?", required: true, default: false },
      {
        key: "email",
        type: "string",
        description: "Contact",
        required: true,
        format: "email",
        minLength: 3,
        maxLength: 80,
      },
      { key: "count", type: "integer", required: false, minimum: 1, maximum: 5, default: 2 },
      { key: "ratio", type: "number", required: false },
      {
        key: "plan",
        type: "enum",
        required: false,
        options: [
          { value: "free", label: "free" },
          { value: "pro", label: "pro" },
        ],
        default: "pro",
      },
      {
        key: "legacy",
        type: "enum",
        required: false,
        options: [
          { value: "a", label: "Option A" },
          { value: "b", label: "Option B" },
        ],
      },
      {
        key: "titled",
        type: "enum",
        required: false,
        options: [
          { value: "x", label: "Ex" },
          { value: "y", label: "y" },
        ],
      },
      {
        key: "tags",
        type: "multi_enum",
        required: false,
        options: [
          { value: "red", label: "red" },
          { value: "blue", label: "blue" },
        ],
        minItems: 1,
        maxItems: 2,
        default: ["red"],
      },
      {
        key: "titledTags",
        type: "multi_enum",
        required: false,
        options: [{ value: "s", label: "Small" }],
      },
    ]);
  });

  it("treats a missing schema or empty properties as a consent-only form", () => {
    expect(parsedFields(undefined)).toEqual([]);
    expect(parsedFields(objectSchema({}))).toEqual([]);
  });

  it("fails closed with a reason for shapes it cannot render faithfully", () => {
    const unsupported = [
      { type: "string" },
      objectSchema({}, ["missing"]),
      { ...objectSchema({}), minProperties: 1 },
      objectSchema({ name: { type: "string", pattern: "^a" } }),
      objectSchema({ name: { type: "string", format: "ipv4" } }),
      objectSchema({ nested: { type: "object", properties: {} } }),
      objectSchema({ count: { type: "number", default: "wrong" } }),
      objectSchema({ plan: { type: "string", enum: ["a"], default: "b" } }),
      objectSchema({ plan: { type: "string", enum: [1] } }),
      objectSchema({ plan: { type: "string", enum: ["a", "b"], enumNames: ["A"] } }),
      objectSchema({ tags: { type: "array", items: { type: "number" } } }),
      objectSchema({ x: "string" }),
    ];
    for (const schema of unsupported) {
      const parsed = parseMcpElicitationSchema(schema);
      expect(parsed.type, JSON.stringify(schema)).toBe("unsupported");
      if (parsed.type === "unsupported") expect(parsed.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("validateMcpElicitationContent", () => {
  const fields = parsedFields(
    objectSchema(
      {
        confirm: { type: "boolean" },
        email: { type: "string", format: "email", maxLength: 20 },
        site: { type: "string", format: "uri" },
        day: { type: "string", format: "date" },
        at: { type: "string", format: "date-time" },
        count: { type: "integer", minimum: 1, maximum: 5 },
        plan: { type: "string", enum: ["free", "pro"] },
        tags: { type: "array", items: { type: "string", enum: ["red", "blue"] }, maxItems: 1 },
      },
      ["confirm", "count"],
    ),
  );

  it("accepts content typed per the schema", () => {
    const content = {
      confirm: true,
      email: "a@b.co",
      site: "https://example.com/x",
      day: "2026-10-06",
      at: "2026-10-06T12:30:00.000Z",
      count: 3,
      plan: "pro",
      tags: ["blue"],
    };
    expect(validateMcpElicitationContent(fields, content)).toEqual({ ok: true, content });
    expect(validateMcpElicitationContent(fields, { confirm: false, count: 1 })).toEqual({
      ok: true,
      content: { confirm: false, count: 1 },
    });
  });

  it("reports one error per invalid field", () => {
    const result = validateMcpElicitationContent(fields, {
      email: "nope",
      site: "not a url",
      day: "2026-13-40",
      at: "yesterday",
      count: 2.5,
      plan: "enterprise",
      tags: ["red", "blue"],
      extra: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).toSorted()).toEqual(
      ["at", "confirm", "count", "day", "email", "extra", "plan", "site", "tags"].toSorted(),
    );
    expect(result.errors.confirm).toBe("Required.");
  });

  it("enforces string length, numeric bounds and wrong primitive types", () => {
    const check = (content: Record<string, unknown>) =>
      validateMcpElicitationContent(fields, { confirm: true, count: 1, ...content }).ok;
    expect(check({ email: "a".repeat(15) + "@b.co" })).toBe(true);
    expect(check({ email: "a".repeat(16) + "@b.co" })).toBe(false);
    expect(check({ count: 0 })).toBe(false);
    expect(check({ count: 6 })).toBe(false);
    expect(check({ count: "3" })).toBe(false);
    expect(check({ confirm: "true" })).toBe(false);
    expect(check({ count: Number.NaN })).toBe(false);
    expect(validateMcpElicitationContent(fields, null).ok).toBe(false);
    expect(validateMcpElicitationContent(fields, ["x"]).ok).toBe(false);
  });
});

describe("form drafts", () => {
  const fields = parsedFields(
    objectSchema(
      {
        confirm: { type: "boolean", default: true },
        name: { type: "string", default: "db" },
        note: { type: "string" },
        count: { type: "integer" },
        at: { type: "string", format: "date-time" },
        plan: { type: "string", enum: ["a"] },
        tags: { type: "array", items: { type: "string", enum: ["x"] } },
      },
      ["count"],
    ),
  );

  it("starts from the schema defaults", () => {
    expect(mcpElicitationDraftDefaults(fields)).toEqual({
      confirm: true,
      name: "db",
      note: "",
      count: "",
      at: "",
      plan: "",
      tags: [],
    });
  });

  it("types draft values and omits untouched optional fields", () => {
    expect(
      mcpElicitationContentFromDraft(fields, {
        ...mcpElicitationDraftDefaults(fields),
        count: " 4 ",
        at: "2026-10-06T12:30",
      }),
    ).toEqual({
      confirm: true,
      name: "db",
      count: 4,
      // The input value is the user's local wall-clock time.
      at: DateTime.formatIso(
        Option.getOrThrow(
          DateTime.makeZoned("2026-10-06T12:30", {
            timeZone: DateTime.zoneMakeLocal(),
            adjustForTimeZone: true,
          }),
        ),
      ),
    });
    // Unparseable numbers stay strings so validation reports them.
    expect(mcpElicitationContentFromDraft(fields, { count: "four" })).toEqual({ count: "four" });
  });
});

describe("date-time defaults", () => {
  it("shows a zoned default as local time and sends that same instant back", () => {
    const fields = parsedFields(
      objectSchema({
        at: { type: "string", format: "date-time", default: "2026-10-06T12:30:00Z" },
      }),
    );
    const draft = mcpElicitationDraftDefaults(fields);
    // A datetime-local input only displays zone-less values.
    expect(draft.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(mcpElicitationContentFromDraft(fields, draft)).toEqual({
      at: "2026-10-06T12:30:00.000Z",
    });
  });

  it("keeps seconds that the default carries", () => {
    const fields = parsedFields(
      objectSchema({
        at: { type: "string", format: "date-time", default: "2026-10-06T12:30:15Z" },
      }),
    );
    const draft = mcpElicitationDraftDefaults(fields);
    expect(draft.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:15$/);
    expect(mcpElicitationContentFromDraft(fields, draft)).toEqual({
      at: "2026-10-06T12:30:15.000Z",
    });
  });
});
