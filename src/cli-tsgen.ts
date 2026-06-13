#!/usr/bin/env node
/**
 * pyde-tsgen — CLI for the ABI → TypeScript codegen module.
 *
 * Usage:
 *   pyde-tsgen <input.abi.json> <output.d.ts> [--name <ContractName>]
 *
 * Example:
 *   pyde-tsgen artifacts/Counter.bundle/Counter.abi.json types/counter.d.ts --name Counter
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { generateTypes } from "./codegen.js";

function usage(): never {
  console.error("usage: pyde-tsgen <input.abi.json> <output.d.ts> [--name <ContractName>]");
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 2) usage();

  const inputPath = args[0]!;
  const outputPath = args[1]!;
  let contractName: string | undefined;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) {
      contractName = args[i + 1];
      i++;
    }
  }

  let abiJson: string;
  try {
    abiJson = readFileSync(inputPath, "utf-8");
  } catch (e) {
    console.error(`error: cannot read ${inputPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  let output: string;
  try {
    output = generateTypes(abiJson, contractName);
  } catch (e) {
    console.error(`error: codegen failed: ${(e as Error).message}`);
    process.exit(1);
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, output);
  console.log(`wrote ${outputPath}`);
}

main();
