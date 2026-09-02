import path from 'node:path';

import type { DownloadJob, NativeRequest } from './protocol.js';

const CDN_HOST_PATTERN = /^cdn[1-5]\.fansly\.com$/iu;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const MANIFEST_EXTENSIONS = new Set(['.m3u8', '.mpd']);
const OUTPUT_EXTENSIONS = new Set(['.mp4', '.mkv']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }

  return value;
}

function requireBoundedString(value: unknown, field: string, maximumLength: number): string {
  const text = requireString(value, field);
  if (text.length > maximumLength) {
    throw new ValidationError(`${field} is too long`);
  }

  return text;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number`);
  }

  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  const number = requireFiniteNumber(value, field);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`);
  }

  return number;
}

function validateId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new ValidationError(`${field} contains unsupported characters`);
  }

  return id;
}

export class ValidationError extends Error {}

function validateCdnUrl(value: unknown, field: string): URL {
  const rawUrl = requireBoundedString(value, field, 8192);
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError(`${field} is invalid`);
  }

  if (url.protocol !== 'https:') {
    throw new ValidationError(`${field} must use HTTPS`);
  }

  if (!CDN_HOST_PATTERN.test(url.hostname)) {
    throw new ValidationError(`${field} host is not allowed`);
  }

  return url;
}

export function validateManifestUrl(value: unknown): string {
  const url = validateCdnUrl(value, 'manifestUrl');

  if (!MANIFEST_EXTENSIONS.has(path.posix.extname(url.pathname).toLowerCase())) {
    throw new ValidationError('manifestUrl must identify an HLS or DASH manifest');
  }

  return url.toString();
}

export function validateOutputFilename(value: unknown): string {
  const filename = requireString(value, 'outputFilename');
  if (
    filename.length > 180 ||
    filename !== path.basename(filename) ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('\0') ||
    filename.endsWith('.') ||
    filename.endsWith(' ') ||
    WINDOWS_RESERVED_NAME.test(filename)
  ) {
    throw new ValidationError('outputFilename is not a safe basename');
  }

  if (!OUTPUT_EXTENSIONS.has(path.extname(filename).toLowerCase())) {
    throw new ValidationError('outputFilename must end in .mp4 or .mkv');
  }

  return filename;
}

function validateDownloadJob(value: unknown): DownloadJob {
  if (!isRecord(value)) {
    throw new ValidationError('job must be an object');
  }

  const job: DownloadJob = {
    jobId: validateId(value.jobId, 'jobId'),
    manifestUrl: validateManifestUrl(value.manifestUrl),
    outputFilename: validateOutputFilename(value.outputFilename),
    originalFilename: requireBoundedString(value.originalFilename, 'originalFilename', 512),
    createdAt: requireNonNegativeInteger(value.createdAt, 'createdAt'),
    likeCount: requireNonNegativeInteger(value.likeCount, 'likeCount'),
    price: requireNonNegativeInteger(value.price, 'price'),
  };

  if (value.previewUrl !== undefined) {
    job.previewUrl = validateCdnUrl(value.previewUrl, 'previewUrl').toString();
  }

  return job;
}

export function validateRequest(value: unknown): NativeRequest {
  if (!isRecord(value)) {
    throw new ValidationError('request must be an object');
  }

  const type = requireString(value.type, 'type');
  const requestId = validateId(value.requestId, 'requestId');

  if (type === 'hello') {
    return { type, requestId };
  }

  if (type === 'download.start') {
    return { type, requestId, job: validateDownloadJob(value.job) };
  }

  if (type === 'download.cancel') {
    return {
      type,
      requestId,
      jobId: validateId(value.jobId, 'jobId'),
    };
  }

  throw new ValidationError('request type is unsupported');
}
