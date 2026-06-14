import { describe, it, expect } from "vitest";
import {
  PydeError,
  CallExceptionError,
  ConnectionError,
  TimeoutError,
  InvalidArgumentError,
  InsufficientFundsError,
  RpcError,
  SigningError,
  isError,
  isCallException,
} from "./errors";

describe("PydeError hierarchy", () => {
  it("every typed error extends PydeError", () => {
    expect(new CallExceptionError("0x", "0x")).toBeInstanceOf(PydeError);
    expect(new ConnectionError("x")).toBeInstanceOf(PydeError);
    expect(new TimeoutError("x")).toBeInstanceOf(PydeError);
    expect(new InvalidArgumentError("x", "arg")).toBeInstanceOf(PydeError);
    expect(new InsufficientFundsError("x")).toBeInstanceOf(PydeError);
    expect(new RpcError("x")).toBeInstanceOf(PydeError);
    expect(new SigningError("x")).toBeInstanceOf(PydeError);
  });
  it("carries the right code", () => {
    expect(new ConnectionError("x").code).toBe("CONNECTION_ERROR");
    expect(new TimeoutError("x").code).toBe("TIMEOUT");
    expect(new InvalidArgumentError("x", "arg").code).toBe("INVALID_ARGUMENT");
  });
});

describe("isError + isCallException", () => {
  it("isError matches by code", () => {
    const e = new TimeoutError("nope");
    expect(isError(e, "TIMEOUT")).toBe(true);
    expect(isError(e, "RPC_ERROR")).toBe(false);
    expect(isError(new Error("plain"), "TIMEOUT")).toBe(false);
  });
  it("isCallException narrows to CallExceptionError", () => {
    const e = new CallExceptionError("0x5208", "0x");
    expect(isCallException(e)).toBe(true);
    expect(isCallException(new RpcError("nope"))).toBe(false);
  });
});

describe("CallExceptionError revert decoding", () => {
  it("decodes a length-prefixed UTF-8 revert reason", () => {
    // [len:8 LE = 5][b"hello"]
    const data = "0x" + "0500000000000000" + Buffer.from("hello", "utf-8").toString("hex");
    const e = new CallExceptionError("0x5208", data);
    expect(e.reason).toBe("hello");
  });
  it("decodes a raw UTF-8 revert reason", () => {
    const data = "0x" + Buffer.from("nope", "utf-8").toString("hex");
    const e = new CallExceptionError("0x5208", data);
    expect(e.reason).toBe("nope");
  });
  it("returns null for empty revert data", () => {
    expect(new CallExceptionError("0x5208", "0x").reason).toBeNull();
  });
});
