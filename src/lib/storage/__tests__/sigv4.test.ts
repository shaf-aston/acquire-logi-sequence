import { describe, it, expect } from "vitest";
import { signingKey, signPutObject } from "@/lib/storage/sigv4";

describe("sigv4 signing key", () => {
  // Official AWS test vector — "Examples of how to derive a signing key for
  // Signature Version 4" (AWS General Reference).
  it("matches the documented AWS derivation vector", () => {
    const key = signingKey(
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "20150830",
      "us-east-1",
      "iam",
    );
    expect(key.toString("hex")).toBe(
      "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
    );
  });
});

describe("signPutObject", () => {
  const base = {
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "auto",
    service: "s3",
    url: "https://acct.r2.cloudflarestorage.com/bucket/raw/abc.pdf",
    body: new TextEncoder().encode("hello"),
    contentType: "application/pdf",
    amzDate: "20240101T000000Z",
  };

  it("is deterministic and well-formed", () => {
    const a = signPutObject(base);
    const b = signPutObject(base);
    expect(a.headers.Authorization).toBe(b.headers.Authorization);
    expect(a.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20240101\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    // x-amz-content-sha256 must be the hex sha256 of the body ("hello").
    expect(a.headers["x-amz-content-sha256"]).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("changes the signature when the body changes", () => {
    const a = signPutObject(base);
    const b = signPutObject({ ...base, body: new TextEncoder().encode("world") });
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });
});
