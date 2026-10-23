import { OpenAIOperationError } from '../../../openai-operation';
import {
  compileCustomToolGrammar,
  InvalidCustomToolGrammarError,
  type CompiledCustomToolGrammar,
} from '../../grammars/customToolGrammar';
import type { UnifiedChatRequestMeta, UnifiedTool } from '../../types';

/**
 * Parameter schema a codex `custom` tool is exposed with.
 *
 * A custom tool takes FREE-FORM text (codex constrains it with a lark grammar,
 * e.g. `exec` receives raw JavaScript), whereas OpenAI-chat function tools take
 * JSON arguments. Declaring one required `input` string is the faithful
 * flattening: the model writes its free-form payload into `input`, and the
 * response encoder unwraps it straight back into the `custom_tool_call.input`
 * field codex expects.
 */
const CUSTOM_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    input: {
      type: 'string',
      description: 'The complete free-form input for this tool, passed through verbatim.',
    },
  },
  required: ['input'],
} as const;

/** Request-scoped codex protocol state threaded from decode to encode. */
export type CodexToolState = UnifiedChatRequestMeta['codexTools'];
type CustomToolFormats = NonNullable<CodexToolState>['customToolFormats'];

export async function compileCodexGrammars(formats: CustomToolFormats) {
  let validators: Record<string, CompiledCustomToolGrammar> | undefined;
  for (const [name, format] of Object.entries(formats ?? {})) {
    if (format.type !== 'grammar') continue;
    try {
      const validator = await compileCustomToolGrammar(format);
      validators ??= Object.create(null) as Record<string, CompiledCustomToolGrammar>;
      validators[name] = validator;
    } catch (error) {
      if (!(error instanceof InvalidCustomToolGrammarError)) throw error;
      throw new OpenAIOperationError({
        status: 400,
        code: 'invalid_request_error',
        message: `Custom tool '${name}' has an invalid ${format.syntax} grammar`,
      });
    }
  }
  return validators;
}

/** Only generated calls are checked; old executed history has its own contract. */
export function encodeGeneratedToolCallItem(
  callId: string,
  name: string,
  argumentsJson: string,
  status: 'in_progress' | 'completed',
  codexTools: CodexToolState,
) {
  const item = encodeToolCallItem(callId, name, argumentsJson, status, codexTools);
  const validator = codexTools?.grammarValidators?.[resolveDeclaredWireName(name, codexTools)];
  if (validator && status === 'completed') {
    let valid = false;
    try {
      valid = validator.accepts(item.input as string);
    } catch {
      throw new OpenAIOperationError({
        status: 502, code: 'tool_grammar_validation_failed',
        message: 'The upstream custom tool input could not be validated',
      });
    }
    if (!valid) throw new OpenAIOperationError({
      status: 502, code: 'invalid_upstream_tool_input',
      message: 'The upstream custom tool input does not match its declared grammar',
    });
  }
  return item;
}

/**
 * Unwrap a custom tool's free-form payload from the `{input:…}` JSON envelope
 * the model was asked to produce (see `CUSTOM_TOOL_PARAMETERS`).
 *
 * Falls back to the raw argument string when the model ignored the schema or
 * the stream was cut mid-JSON: passing the payload through imperfectly beats
 * dropping the tool call entirely.
 */
function unwrapCustomToolInput(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.input === 'string') {
        return parsed.input;
      }
      // A model that ignored the declared `input` property may still package
      // the free-form payload as ONE string under another key (DeepSeek emits
      // `{"code":"…"}` for `exec` under some prompts). A single string value
      // is unambiguous about which text the tool meant; anything else stays
      // JSON so nothing is silently reinterpreted.
      const values = Object.values(parsed);
      if (values.length === 1 && typeof values[0] === 'string') {
        return values[0];
      }
    }
  } catch {
    /* not valid JSON — fall through to the raw text */
  }
  return argumentsJson;
}

/**
 * Resolve a tool-call name from the upstream back to the FLATTENED declared
 * wire name codex's catalog registered.
 *
 * The declaration side flattens `<namespace>__<name>` (see collectCodexTools),
 * but not every model honours it: DeepSeek picks the bare member name (`exec`)
 * whenever the surrounding instructions call the tool that way, even though the
 * declared name is `functions__exec`. That mismatch is fatal — the call comes
 * back as an unregistered `function_call`, and codex's registry aborts the turn
 * ("invoked with incompatible payload") before the tool ever runs.
 *
 * Exact matches win. Otherwise a bare name binds to the UNIQUE declared wire
 * name ending in `__<name>`; with two candidates in different namespaces there
 * is no safe guess, so the name is left untouched.
 */
export function resolveDeclaredWireName(name: string, codexTools: CodexToolState): string {
  if (!name || !codexTools) return name;
  const declared = new Set<string>(codexTools.customToolNames ?? []);
  for (const wireName of Object.keys(codexTools.toolNamespaces ?? {})) {
    declared.add(wireName);
  }
  if (declared.has(name)) return name;
  const qualified = name.replaceAll('.', '__');
  if (declared.has(qualified)) return qualified;

  const suffix = `__${name}`;
  let match: string | undefined;
  for (const wireName of declared) {
    if (!wireName.endsWith(suffix)) continue;
    if (match !== undefined) return name; // ambiguous across namespaces
    match = wireName;
  }
  return match ?? name;
}

/** Whether this upstream tool-call name belongs to a codex `custom` tool. */
export function isCustomToolCallName(name: string, codexTools: CodexToolState): boolean {
  if (!codexTools?.customToolNames?.length) return false;
  return codexTools.customToolNames.includes(resolveDeclaredWireName(name, codexTools));
}

/**
 * Encode ONE OpenAI-chat tool call as the Responses output item codex expects.
 *
 * A tool codex declared `type:'custom'` MUST come back as a `custom_tool_call`
 * carrying free-form `input`; sending it a `function_call` for a tool it
 * registered as custom leaves the call unroutable. Everything else is a
 * `function_call`, with the codex `namespace` restored when the tool came from
 * one. Item ids must carry the protocol's prefix (`ctc_` / `fc_`), which is
 * synthesized from the call id since the chat wire has only that one handle.
 */
export function encodeToolCallItem(
  callId: string,
  name: string,
  argumentsJson: string,
  status: 'in_progress' | 'completed',
  codexTools: CodexToolState,
): Record<string, unknown> {
  const bareId = callId;
  // A provider may answer with the bare member name; look it up as the
  // flattened name its declaration actually registered (see
  // resolveDeclaredWireName — DeepSeek's `exec` for `functions__exec`).
  const wireName = resolveDeclaredWireName(name, codexTools);

  const namespace = codexTools?.toolNamespaces?.[wireName];
  // The wire name is the FLATTENED `<namespace>__<name>`; codex expects the
  // bare name plus the separate namespace axis on the item. This holds for the
  // custom branch too — emitting the flattened name verbatim leaves codex with
  // an unregistered `functions__exec` and the call dies as
  // "unsupported custom tool call" (the `functions` namespace is how responses
  // lite ships EVERY built-in tool, exec included).
  const bareName = namespace && wireName.startsWith(`${namespace}__`)
    ? wireName.slice(namespace.length + 2)
    : wireName;

  if (codexTools?.customToolNames?.includes(wireName)) {
    return {
      id: `ctc_${bareId}`,
      type: 'custom_tool_call',
      status,
      call_id: callId,
      name: bareName,
      ...(namespace ? { namespace } : {}),
      input: unwrapCustomToolInput(argumentsJson),
    };
  }

  return {
    id: `fc_${bareId}`,
    type: 'function_call',
    status,
    call_id: callId,
    name: bareName,
    ...(namespace ? { namespace } : {}),
    arguments: argumentsJson,
  };
}

/** What `collectCodexTools` recovers from an `additional_tools` item. */
export interface CodexToolDeclarations {
  tools: UnifiedTool[];
  /** Names declared `type:'custom'` — re-encoded as `custom_tool_call` on the way back. */
  customToolNames: string[];
  /** Call handles whose request/output item must stay custom on re-encode. */
  customToolCallIds: string[];
  /** Tool name → codex namespace, restored onto `function_call` items on the way back. */
  toolNamespaces: Record<string, string>;
  customToolFormats?: CustomToolFormats;
  customToolDescriptions?: Record<string, string>;
}

/**
 * Decode codex's `additional_tools` item into plain OpenAI-chat function tools.
 *
 * codex does NOT use the top-level `tools` field — it ships every tool inside one
 * `{type:'additional_tools', role:'developer', tools:[…]}` input item, in three
 * flavours:
 *   - `{type:'function', name, description, parameters}` — already chat-shaped.
 *   - `{type:'namespace', name, tools:[…]}` — a group (e.g. `collaboration`)
 *     whose members are functions. The MEMBER name is what the model calls; the
 *     namespace is carried on codex's `function_call` item as a separate field,
 *     so it is recorded and restored rather than baked into the name.
 *   - `{type:'custom', name, description, format}` — free-form text tool,
 *     flattened onto `CUSTOM_TOOL_PARAMETERS` (see there).
 *
 * Dropping this item left the upstream request with NO tools at all, so the
 * model could only ever answer in prose — codex's whole agent loop was dead.
 */
export function collectCodexTools(entry: Record<string, unknown>): CodexToolDeclarations {
  const result: CodexToolDeclarations = {
    tools: [],
    customToolNames: [],
    customToolCallIds: [],
    toolNamespaces: {},
  };

  const visit = (declarations: unknown, namespace?: string): void => {
    if (!Array.isArray(declarations)) return;
    for (const raw of declarations) {
      if (!raw || typeof raw !== 'object') continue;
      const tool = raw as Record<string, unknown>;
      const name = typeof tool.name === 'string' ? tool.name : '';
      if (!name) continue;
      const description = typeof tool.description === 'string' ? tool.description : '';

      if (tool.type === 'namespace') {
        visit(tool.tools, name);
        continue;
      }

      // NAMESPACED FLATTENING: a flat wire (chat/anthropic) has no namespace
      // axis, so a namespaced tool rides as `<namespace>__<name>` (codex's own
      // flat naming convention, cf. its `mcp__server` namespace ids). The bare
      // name MUST NOT be used: two namespaces declaring the same inner name
      // (e.g. `search` under two MCP servers) then collide and the upstream
      // rejects the whole request ("Tool names must be unique" — observed on
      // the official DeepSeek chat wire). The reconstruction map keys the
      // FLATTENED name; the decode strips the prefix back into
      // `{name, namespace}` for codex.
      const wireName = namespace ? `${namespace}__${name}` : name;
      if (result.tools.some((existing) => existing.function.name === wireName)) continue;

      if (tool.type === 'custom') {
        const format = tool.format as NonNullable<CustomToolFormats>[string] | undefined;
        if (format) {
          result.customToolFormats ??= Object.create(null) as NonNullable<CustomToolFormats>;
          result.customToolFormats[wireName] = format;
          result.customToolDescriptions ??= Object.create(null) as Record<string, string>;
          result.customToolDescriptions[wireName] = description;
        }
        result.customToolNames.push(wireName);
        result.tools.push({
          type: 'function',
          function: {
            name: wireName,
            description: format?.type === 'grammar'
              ? `${description}\nThe input must match this ${format.syntax} grammar exactly:\n${format.definition}`
              : description,
            parameters: CUSTOM_TOOL_PARAMETERS as unknown as UnifiedTool['function']['parameters'],
          },
        });
      } else if (tool.type === 'function') {
        result.tools.push({
          type: 'function',
          function: {
            name: wireName,
            description,
            parameters: (tool.parameters || {}) as UnifiedTool['function']['parameters'],
            ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
          },
        });
      } else {
        continue;
      }

      if (namespace) result.toolNamespaces[wireName] = namespace;
    }
  };

  visit(entry.tools);
  return result;
}

export function mergeCodexTools(
  left: CodexToolDeclarations,
  right: CodexToolDeclarations,
): CodexToolDeclarations {
  const tools = [...left.tools];
  const names = new Set(tools.map((tool) => tool.function.name));
  const formats = right.customToolFormats ? { ...left.customToolFormats } : left.customToolFormats;
  const descriptions = right.customToolDescriptions ? { ...left.customToolDescriptions } : left.customToolDescriptions;
  for (const tool of right.tools) {
    if (names.has(tool.function.name)) continue;
    tools.push(tool);
    names.add(tool.function.name);
    const format = right.customToolFormats?.[tool.function.name];
    if (format) formats![tool.function.name] = format;
    const description = right.customToolDescriptions?.[tool.function.name];
    if (description !== undefined) descriptions![tool.function.name] = description;
  }
  return {
    tools,
    customToolNames: [...new Set([...left.customToolNames, ...right.customToolNames])],
    customToolCallIds: [...new Set([...left.customToolCallIds, ...right.customToolCallIds])],
    toolNamespaces: { ...left.toolNamespaces, ...right.toolNamespaces },
    ...(formats ? { customToolFormats: formats } : {}),
    ...(descriptions ? { customToolDescriptions: descriptions } : {}),
  };
}

export function rememberCustomCall(
  state: CodexToolDeclarations,
  rawCallId: unknown,
  rawName?: unknown,
): void {
  if (typeof rawCallId === 'string' && rawCallId && !state.customToolCallIds.includes(rawCallId)) {
    state.customToolCallIds.push(rawCallId);
  }
  if (typeof rawName === 'string' && rawName && !state.customToolNames.includes(rawName)) {
    state.customToolNames.push(rawName);
  }
}

export function rememberToolNamespace(
  state: CodexToolDeclarations,
  rawName: unknown,
  rawNamespace: unknown,
): void {
  if (
    typeof rawName === 'string' && rawName &&
    typeof rawNamespace === 'string' && rawNamespace
  ) {
    state.toolNamespaces[rawName] = rawNamespace;
  }
}
