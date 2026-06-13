/**
 * Gemini Schema Utilities
 *
 * Handles JSON Schema transformations for Gemini API compatibility.
 * Converts standard JSON Schema to Gemini's Schema format.
 *
 * @module transformer/transformers/utils/gemini.schema
 */

/**
 * Valid field names for Gemini Schema
 */
const VALID_SCHEMA_FIELDS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'maxItems',
  'minItems',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
  'propertyOrdering',
  'default',
  'items',
  'minimum',
  'maximum',
]);

/**
 * Gemini type enum values
 */
export const GeminiType = {
  TYPE_UNSPECIFIED: 'TYPE_UNSPECIFIED',
  STRING: 'STRING',
  NUMBER: 'NUMBER',
  INTEGER: 'INTEGER',
  BOOLEAN: 'BOOLEAN',
  ARRAY: 'ARRAY',
  OBJECT: 'OBJECT',
  NULL: 'NULL',
} as const;

export type GeminiTypeValue = (typeof GeminiType)[keyof typeof GeminiType];

/**
 * Clean up parameters to match Gemini's Schema format
 * Removes invalid fields and normalizes enum/format usage
 *
 * @param obj - Object to clean up
 * @param keyName - Current key name (for context)
 */
export function cleanupParameters(obj: unknown, keyName?: string): void {
  if (!obj || typeof obj !== 'object') {
    return;
  }

  if (Array.isArray(obj)) {
    obj.forEach((item) => {
      cleanupParameters(item);
    });
    return;
  }

  const record = obj as Record<string, unknown>;

  // Remove invalid fields (except when we're inside 'properties')
  if (keyName !== 'properties') {
    Object.keys(record).forEach((key) => {
      if (!VALID_SCHEMA_FIELDS.has(key)) {
        delete record[key];
      }
    });
  }

  // enum is only valid for string type
  if (record.enum && record.type !== 'string') {
    delete record.enum;
  }

  // format is only valid for certain values
  if (
    record.type === 'string' &&
    record.format &&
    !['enum', 'date-time'].includes(record.format as string)
  ) {
    delete record.format;
  }

  // Recursively clean nested objects
  Object.keys(record).forEach((key) => {
    cleanupParameters(record[key], key);
  });
}

/**
 * Transform type array to anyOf format
 * Handles nullable types by extracting 'null' from the array
 *
 * @param typeList - List of types
 * @param resultingSchema - Schema object to modify
 */
export function flattenTypeArrayToAnyOf(
  typeList: string[],
  resultingSchema: Record<string, unknown>
): void {
  // Handle nullable
  if (typeList.includes('null')) {
    resultingSchema.nullable = true;
  }

  const listWithoutNull = typeList.filter((type) => type !== 'null');

  if (listWithoutNull.length === 1) {
    const upperCaseType = listWithoutNull[0].toUpperCase();
    resultingSchema.type = Object.values(GeminiType).includes(upperCaseType as GeminiTypeValue)
      ? upperCaseType
      : GeminiType.TYPE_UNSPECIFIED;
  } else {
    resultingSchema.anyOf = listWithoutNull.map((typeName) => {
      const upperCaseType = typeName.toUpperCase();
      return {
        type: Object.values(GeminiType).includes(upperCaseType as GeminiTypeValue)
          ? upperCaseType
          : GeminiType.TYPE_UNSPECIFIED,
      };
    });
  }
}

/**
 * Process a JSON schema to make it compatible with Gemini API
 *
 * @param jsonSchema - The JSON schema to process
 * @returns Processed schema for Gemini
 */
export function processJsonSchema(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  const genAISchema: Record<string, unknown> = {};
  const schemaFieldNames = ['items'];
  const listSchemaFieldNames = ['anyOf'];
  const dictSchemaFieldNames = ['properties'];

  let workingSchema = jsonSchema;

  // Validate: type and anyOf cannot both be present
  if (workingSchema.type && workingSchema.anyOf) {
    throw new Error('type and anyOf cannot be both populated.');
  }

  // Handle nullable array/object with anyOf
  // Format: {anyOf: [{type: 'null'}, {type: 'object'}]}
  const incomingAnyOf = workingSchema.anyOf as Array<Record<string, unknown>> | undefined;
  if (incomingAnyOf && Array.isArray(incomingAnyOf) && incomingAnyOf.length === 2) {
    if (incomingAnyOf[0]?.type === 'null') {
      genAISchema.nullable = true;
      workingSchema = incomingAnyOf[1];
    } else if (incomingAnyOf[1]?.type === 'null') {
      genAISchema.nullable = true;
      workingSchema = incomingAnyOf[0];
    }
  }

  // Handle type as array
  if (workingSchema.type && Array.isArray(workingSchema.type)) {
    flattenTypeArrayToAnyOf(workingSchema.type as string[], genAISchema);
  }

  // Process each field
  for (const [fieldName, fieldValue] of Object.entries(workingSchema)) {
    // Skip undefined/null values
    if (fieldValue == null) {
      continue;
    }

    if (fieldName === 'type') {
      if (fieldValue === 'null') {
        throw new Error('type: null cannot be the only possible type for the field.');
      }
      if (Array.isArray(fieldValue)) {
        // Already handled above
        continue;
      }
      const upperCaseValue = (fieldValue as string).toUpperCase();
      genAISchema.type = Object.values(GeminiType).includes(upperCaseValue as GeminiTypeValue)
        ? upperCaseValue
        : GeminiType.TYPE_UNSPECIFIED;
    } else if (schemaFieldNames.includes(fieldName)) {
      // Recursively process schema fields like 'items'
      genAISchema[fieldName] = processJsonSchema(fieldValue as Record<string, unknown>);
    } else if (listSchemaFieldNames.includes(fieldName)) {
      // Process list schema fields like 'anyOf'
      const listValue: Record<string, unknown>[] = [];
      for (const item of fieldValue as Array<Record<string, unknown>>) {
        if (item.type === 'null') {
          genAISchema.nullable = true;
          continue;
        }
        listValue.push(processJsonSchema(item));
      }
      genAISchema[fieldName] = listValue;
    } else if (dictSchemaFieldNames.includes(fieldName)) {
      // Process dict schema fields like 'properties'
      const dictValue: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fieldValue as Record<string, unknown>)) {
        dictValue[key] = processJsonSchema(value as Record<string, unknown>);
      }
      genAISchema[fieldName] = dictValue;
    } else {
      // Skip additionalProperties
      if (fieldName === 'additionalProperties') {
        continue;
      }
      genAISchema[fieldName] = fieldValue;
    }
  }

  return genAISchema;
}

/**
 * Transform a tool definition for Gemini API
 *
 * @param tool - Tool object with functionDeclarations
 * @returns Transformed tool object
 */
export function transformTool(tool: Record<string, unknown>): Record<string, unknown> {
  const functionDeclarations = tool.functionDeclarations as Array<Record<string, unknown>>;

  if (functionDeclarations) {
    for (const functionDeclaration of functionDeclarations) {
      // Process parameters
      if (functionDeclaration.parameters) {
        const params = functionDeclaration.parameters as Record<string, unknown>;
        if (!Object.keys(params).includes('$schema')) {
          functionDeclaration.parameters = processJsonSchema(params);
        } else {
          // Move to parametersJsonSchema if $schema is present
          if (!functionDeclaration.parametersJsonSchema) {
            functionDeclaration.parametersJsonSchema = functionDeclaration.parameters;
            delete functionDeclaration.parameters;
          }
        }
      }

      // Process response schema
      if (functionDeclaration.response) {
        const response = functionDeclaration.response as Record<string, unknown>;
        if (!Object.keys(response).includes('$schema')) {
          functionDeclaration.response = processJsonSchema(response);
        } else {
          if (!functionDeclaration.responseJsonSchema) {
            functionDeclaration.responseJsonSchema = functionDeclaration.response;
            delete functionDeclaration.response;
          }
        }
      }
    }
  }

  return tool;
}
