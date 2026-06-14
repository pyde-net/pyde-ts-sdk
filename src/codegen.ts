/**
 * ABI → TypeScript codegen.
 *
 * Reads an `otigen build` artifact (the `.abi.json` file emitted alongside
 * the `.wasm`) and produces a `.d.ts` file declaring:
 *
 *   1. A `<ContractName>Abi` type — an {@link AbiShape} the SDK uses
 *      to narrow `read` / `write` / `queryFilter` / `parseLog` etc.
 *   2. Strongly typed event records (one per declared event).
 *   3. A legacy `<ContractName>Contract` interface kept for callers
 *      that prefer the cast-shape:
 *
 *      ```ts
 *      import { Contract } from "pyde-ts-sdk";
 *      import type { CounterAbi } from "./counter";
 *
 *      const counter = await Contract.fromArtifact<CounterAbi>(...);
 *      const balance = await counter.read("balance_of", { owner: "0xabc..." });
 *      // ^ method name + arg shape + return type all inferred.
 *      ```
 *
 * Spec: SDK_AUTHOR_GUIDE + HOST_FN_ABI §3.7 (`pyde.abi` ContractAbi shape).
 */

/** Function shape — accepts either the lowercase `{type}` form (older
 *  spec sketches + the SDK author guide examples) or the `otigen build`
 *  canonical `{ty}` form with UpperCamelCase scalar names. */
interface AbiFunctionRaw {
  name: string;
  params?: { name?: string; type?: string; ty?: string }[];
  returns?: string;
  view?: boolean;
  payable?: boolean;
  attrs?: { bits?: number };
}

interface AbiEventRaw {
  name: string;
  fields?: { name?: string; type?: string; ty?: string; indexed?: boolean }[];
}

interface NormalisedParam {
  name: string;
  type: string;
}

interface NormalisedFunction {
  name: string;
  params: NormalisedParam[];
  returns: string;
  view: boolean;
  payable: boolean;
}

interface NormalisedEvent {
  name: string;
  fields: { name: string; type: string; indexed: boolean }[];
}

interface AbiArtifact {
  /** Contract name — used as the prefix for emitted interfaces. */
  name?: string;
  /** Either `{abi: {...}}` or the abi object at root. */
  abi?: {
    functions?: AbiFunctionRaw[];
    events?: AbiEventRaw[];
  };
  functions?: AbiFunctionRaw[];
  events?: AbiEventRaw[];
}

/** Map an ABI scalar type to its TS type. Accepts the `otigen build`
 *  UpperCamelCase form (`U64`, `Bool`, `Address`) and the older
 *  lowercase form (`u64`, `bool`) transparently. */
function tsType(abiType: string | undefined): string {
  if (!abiType || typeof abiType !== "string") return "unknown";
  const t = abiType.trim();
  switch (t.toLowerCase()) {
    case "u8":
    case "u16":
    case "u32":
    case "i8":
    case "i16":
    case "i32":
      return "number";
    case "u64":
    case "u128":
    case "u256":
    case "i64":
    case "i128":
    case "i256":
      return "bigint";
    case "bool":
      return "boolean";
    case "string":
      return "string";
    case "address":
      return "string";
    case "hash":
    case "hash32":
      return "string";
    case "bytes":
      return "Uint8Array";
    case "()":
    case "unit":
    case "void":
      return "void";
  }
  // Vec<T> — case-insensitive match.
  const vecMatch = /^Vec<(.+)>$/i.exec(t);
  if (vecMatch) return `${tsType(vecMatch[1]!)}[]`;
  // Fallback — pass through as unknown so consumers cast explicitly.
  return "unknown";
}

/** Normalise a raw ABI function entry into the codegen's internal shape.
 *  Tolerates `{type}` vs `{ty}` divergence + missing optional fields. */
function normaliseFunction(raw: AbiFunctionRaw): NormalisedFunction {
  const params = (raw.params ?? []).map((p, i) => ({
    name: p.name ?? `arg${i}`,
    type: p.ty ?? p.type ?? "unknown",
  }));
  return {
    name: raw.name,
    params,
    returns: raw.returns ?? "()",
    view: Boolean(raw.view),
    payable: Boolean(raw.payable),
  };
}

function normaliseEvent(raw: AbiEventRaw): NormalisedEvent {
  const fields = (raw.fields ?? []).map((f, i) => ({
    name: f.name ?? `field${i}`,
    type: f.ty ?? f.type ?? "unknown",
    indexed: Boolean(f.indexed),
  }));
  return { name: raw.name, fields };
}

function safeIdent(name: string): string {
  return /^[a-zA-Z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function paramSig(p: { name: string; type: string }): string {
  return `${safeIdent(p.name)}: ${tsType(p.type)}`;
}

function methodSig(fn: NormalisedFunction): string {
  const args = fn.params.map(paramSig).join(", ");
  const ret = tsType(fn.returns);
  const lines: string[] = [];
  const flags: string[] = [];
  if (fn.view) flags.push("view");
  if (fn.payable) flags.push("payable");
  if (flags.length > 0) lines.push(`  /** ${flags.join(" · ")} */`);
  lines.push(`  ${safeIdent(fn.name)}(${args}): Promise<${ret === "void" ? "void" : ret}>;`);
  return lines.join("\n");
}

function eventInterface(prefix: string, ev: NormalisedEvent): string {
  const fields = ev.fields
    .map(
      (f) =>
        `  /** ${f.indexed ? "indexed · " : ""}${f.type} */\n  ${safeIdent(f.name)}: ${tsType(f.type)};`,
    )
    .join("\n");
  return `export interface ${prefix}${ev.name}Event {\n${fields}\n}`;
}

function fnSpecEntry(fn: NormalisedFunction): string {
  const args =
    fn.params.length === 0
      ? "{}"
      : `{ ${fn.params.map((p) => `${safeIdent(p.name)}: ${tsType(p.type)}`).join("; ")} }`;
  const returns = tsType(fn.returns);
  const ret = returns === "void" ? "void" : returns;
  const flags = `view: ${fn.view ? "true" : "false"}; payable: ${fn.payable ? "true" : "false"}`;
  return `    ${JSON.stringify(fn.name)}: { args: ${args}; returns: ${ret}; ${flags} };`;
}

function eventSpecEntry(ev: NormalisedEvent): string {
  const args =
    ev.fields.length === 0
      ? "{}"
      : `{ ${ev.fields.map((f) => `${safeIdent(f.name)}: ${tsType(f.type)}`).join("; ")} }`;
  return `    ${JSON.stringify(ev.name)}: { args: ${args} };`;
}

/**
 * Generate a TypeScript declaration file for a Pyde contract ABI.
 *
 * @param abiJson  Raw JSON content of the `*.abi.json` artifact (or the
 *                 ABI object stringified).
 * @param contractName  Optional name used as the prefix for emitted
 *                      interfaces. Falls back to `abi.name` or
 *                      `"Contract"`.
 */
export function generateTypes(abiJson: string, contractName?: string): string {
  const artifact: AbiArtifact = JSON.parse(abiJson);
  const abi = artifact.abi ?? artifact;
  const functions = (abi.functions ?? []).map(normaliseFunction);
  const events = (abi.events ?? []).map(normaliseEvent);
  const name = contractName ?? artifact.name ?? "Contract";

  const header = [
    `/* eslint-disable */`,
    `/* prettier-ignore-start */`,
    `// Auto-generated by pyde-tsgen. Do not edit by hand.`,
    `// Source ABI: ${functions.length} function(s), ${events.length} event(s).`,
    ``,
  ].join("\n");

  const methods = functions.map(methodSig).join("\n");
  const contractIface = `export interface ${name}Contract {\n${methods || "  // (no functions in ABI)"}\n}`;

  const fnSpecBody =
    functions.length > 0 ? functions.map(fnSpecEntry).join("\n") : "    // (no functions in ABI)";
  const evSpecBody =
    events.length > 0 ? events.map(eventSpecEntry).join("\n") : "    // (no events in ABI)";
  const abiShape = [
    `/** Pass to \`Contract.fromArtifact<${name}Abi>(...)\` for typed`,
    ` *  \`read\` / \`write\` / \`queryFilter\` / \`parseLog\` narrowing. */`,
    `export interface ${name}Abi {`,
    `  functions: {`,
    fnSpecBody,
    `  };`,
    `  events: {`,
    evSpecBody,
    `  };`,
    `}`,
  ].join("\n");

  const eventBlock =
    events.length > 0 ? "\n\n" + events.map((ev) => eventInterface(name, ev)).join("\n\n") : "";

  return [
    header,
    abiShape,
    ``,
    contractIface + eventBlock,
    ``,
    `/* prettier-ignore-end */`,
    ``,
  ].join("\n");
}
