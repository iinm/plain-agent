export type ReadFileInput = {
  filePath: string;
  offset?: number;
  limit?: number;
};

export type ReadFileConfig = {
  outputMaxLength?: number;
};
