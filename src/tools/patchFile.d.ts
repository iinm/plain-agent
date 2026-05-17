export type PatchFileInput = {
  filePath: string;
  patch: string;
};

export type PatchBlock =
  | {
      op: "replace";
      start: number;
      end: number | null;
      startHash: string;
      endHash: string | null;
      body: string[];
    }
  | {
      op: "insert";
      after: number;
      afterHash: string;
      body: string[];
    };
