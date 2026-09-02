import { existsSync } from 'node:fs';
import path from 'node:path';

export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
}

function resolveTool(name: 'ffmpeg' | 'ffprobe', override?: string): string {
  if (override !== undefined && override.length > 0) {
    return override;
  }

  const executableName = `${name}.exe`;
  const besideHost = path.join(path.dirname(process.execPath), executableName);
  if (existsSync(besideHost)) {
    return besideHost;
  }

  // PATH fallback is intended for development. Production packages place both
  // binaries beside the compiled native host.
  return executableName;
}

export function resolveToolPaths(environment = process.env): ToolPaths {
  return {
    ffmpeg: resolveTool('ffmpeg', environment.FANSLY_MYMEDIA_FFMPEG),
    ffprobe: resolveTool('ffprobe', environment.FANSLY_MYMEDIA_FFPROBE),
  };
}
