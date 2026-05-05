export type PatchFileInput = {
  filePath: string;
  patch: string;
};

export type PatchBlock =
  | {
      op: "replace";
      start: number;
      end: number;
      head: string;
      body: string[];
    }
  | {
      op: "insert";
      after: number;
      body: string[];
    };
