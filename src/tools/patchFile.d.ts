export type PatchFileInput = {
  filePath: string;
  patch: string;
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
