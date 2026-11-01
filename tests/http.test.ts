import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateAddress } from "../src/http.js";

test("private and loopback networks are rejected", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.2", "169.254.1.1", "::1", "fd00::1"]) assert.equal(isPrivateAddress(address), true);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPrivateAddress(address), false);
});
