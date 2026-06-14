/**
 * Type-level smoke checks for `Contract<TAbi>` narrowing. Not executed
 * — `tsc --noEmit` is the gate. These exist so a regression that
 * un-narrows the public surface fails CI rather than slipping through.
 */
import { Contract, type AbiShape } from "./contract";

interface CounterAbi extends AbiShape {
  functions: {
    get_count: { args: Record<string, never>; returns: bigint; view: true };
    deposit: { args: { amount: bigint }; returns: void; view: false; payable: true };
  };
  events: {
    Increment: { args: { by: bigint } };
  };
}

declare const c: Contract<CounterAbi>;

async function _checkNarrowing(): Promise<void> {
  // read() narrows to view-function names only.
  const count: bigint = await c.read("get_count");
  void count;

  // Non-view methods on read() should be a type error.
  // @ts-expect-error — `deposit` is not a view function.
  await c.read("deposit");

  // Unknown methods are rejected.
  // @ts-expect-error — `nope` is not declared.
  await c.read("nope");

  // write() narrows to non-view methods + typed args.
  await c.write("deposit", { amount: 5n });

  // Wrong arg type rejected.
  // @ts-expect-error — `amount` must be bigint.
  await c.write("deposit", { amount: "5" });

  // queryFilter narrows the event name + the resolved EventLog<TArgs>.
  const logs = await c.queryFilter("Increment", 0n, 100n);
  const _by: bigint = logs[0]!.args.by;
  void _by;

  // Unknown event rejected.
  // @ts-expect-error — `Nope` is not declared.
  await c.queryFilter("Nope");
}
void _checkNarrowing;

// Default-shape Contract stays loose — string method name accepted.
declare const loose: Contract;
async function _checkLooseFallback(): Promise<void> {
  await loose.read("anything");
  await loose.write("anything", { foo: 1 });
  await loose.queryFilter("AnyEvent");
}
void _checkLooseFallback;
