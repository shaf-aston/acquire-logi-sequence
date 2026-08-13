/**
 * Minimal AWS Signature V4 signer for single-shot S3 PutObject requests, built
 * on Node's stdlib `crypto` — no SDK dependency. Scope is deliberately narrow:
 * one request, payload fully in memory (we hash it directly), no chunked/streaming
 * signing. Cloudflare R2 speaks the S3 API, so this signs R2 too (region "auto").
 *
 * Algorithm: https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
 * Validated against the official AWS signing-key test vector in sigv4.test.ts.
 */
import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** Derive the SigV4 signing key: HMAC chain over date → region → service → "aws4_request". */
export function signingKey(
  secretKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export interface SignedRequest {
  readonly url: string;
  readonly method: "PUT";
  readonly headers: Record<string, string>;
}

export interface SignV4Input {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly service: string;
  /** Full request URL, e.g. https://<acct>.r2.cloudflarestorage.com/<bucket>/<key>. */
  readonly url: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  /** ISO basic timestamp "YYYYMMDDTHHMMSSZ"; injected for deterministic tests. */
  readonly amzDate: string;
}

/**
 * Sign a PUT-with-body request. Returns the headers (including Authorization)
 * to send. The path is taken verbatim from the URL and assumed already
 * URI-encoded by the caller (S3 keys must be encoded per-segment).
 */
export function signPutObject(input: SignV4Input): SignedRequest {
  const { accessKeyId, secretAccessKey, region, service, url, body, contentType, amzDate } = input;
  const parsed = new URL(url);
  const {host} = parsed;
  const canonicalUri = parsed.pathname;
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  // Canonical headers must be sorted lowercase; we use a fixed minimal set.
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const key = signingKey(secretAccessKey, date, region, service);
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `${ALGORITHM} Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url,
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      Authorization: authorization,
    },
  };
}
