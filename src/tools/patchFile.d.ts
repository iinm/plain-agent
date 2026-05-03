export type PatchFileInput = {
  filePath: string;
  diff: string;
};

export type PatchBlock =
  | {
      op: "replace";
      start: number;
      end: number;
      head?: string;
      body: string[];
    }
  | {
      op: "insert";
      after: number;
      body: string[];
    };
