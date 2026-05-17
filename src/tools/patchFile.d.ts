export type PatchFileInput = {
  filePath: string;
  patch: string;
};

export type PatchBlock =
  | {
      op: "replace";
      start: number;
      /** Line number (1-indexed). null means "to end of file" (N:hash- shorthand). */
      end: number | null;
      startHash: string;
      /** null iff end is null (both come from the N:hash- shorthand). */
      endHash: string | null;

      body: string[];
    }
  | {
      op: "insert";
      after: number;
      afterHash: string;
      body: string[];
    };
