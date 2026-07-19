export type PatchFileInput = {
  filePath: string;
  patch: string;
};

/**
 * Original lines captured before applying a patch. Only the lines needed to
 * render the diff (the union of replace blocks' ranges) are stored, keyed by
 * their 1-based line number, alongside the file's total line count so callers
 * can compute end bounds.
 */
export type PatchOriginalLines = {
  totalLines: number;
  lines: Record<number, string>;
};

export type PatchBlock =
  | {
      op: "replace";
      start: number;
      end: number;
      startHash: string;
      endHash: string;
      body: string[];
    }
  | {
      op: "insert";
      after: number;
      afterHash: string;
      body: string[];
    };
